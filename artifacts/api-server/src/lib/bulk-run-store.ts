import { randomUUID } from "node:crypto";
import { GetBulkBrandRunResponse, type BulkBrandRun, type BulkBrandCandidate } from "@workspace/api-zod";
import { clickHouseJson, clickHouseRequest } from "./clickhouse-profiles";
import { bulkOwnership } from "./bulk-ownership-store";
import { observePreparationRead } from "./bulk-preparation-diagnostics";

const table = "poc_new_verticals.profile_bulk_events";
export const bulkWorkerId = randomUUID();
let initializing: Promise<void> | undefined;
let previousVersion = 0;
export function bulkVersion() {
  previousVersion = Math.max(Date.now() * 1000, previousVersion + 1);
  return previousVersion;
}
export async function ensureBulkStore() {
  if (!initializing) initializing = (async () => {
    const response = await clickHouseRequest(`
      CREATE TABLE IF NOT EXISTS ${table} (
        run_id UUID, event_type LowCardinality(String), version UInt64,
        created_at DateTime64(3, 'UTC'), data_json String
      ) ENGINE = MergeTree ORDER BY (run_id, version)
    `, 5_000);
    if (!response.ok) throw new Error(`Bulk result storage is unavailable (${response.status}). No paid queue was started.`);
  })().catch(error => { initializing = undefined; throw error; });
  await initializing;
}

async function appendEvent(runId: string, eventType: "snapshot" | "stop", data: string) {
  await ensureBulkStore();
  const row = JSON.stringify({
    run_id: runId, event_type: eventType, version: bulkVersion(),
    created_at: new Date().toISOString().replace("T", " ").replace("Z", ""), data_json: data,
  });
  const response = await clickHouseRequest(`INSERT INTO ${table} FORMAT JSONEachRow\n${row}`, 8_000);
  if (!response.ok) throw new Error(`Could not persist bulk progress (${response.status}). The queue will stop to avoid unsaved paid work.`);
}

export async function saveBulkRun(run: BulkBrandRun) {
  run.updatedAt = new Date().toISOString();
  await appendEvent(run.id, "snapshot", JSON.stringify(GetBulkBrandRunResponse.parse(run)));
}
export async function requestBulkStop(id: string) { await appendEvent(id, "stop", "{}"); }

export function mergeBulkRunView(local: BulkBrandRun | undefined, stored: BulkBrandRun | undefined) {
  if (local && (!stored || local.resumeVersion > stored.resumeVersion
    || (local.resumeVersion === stored.resumeVersion && Date.parse(local.updatedAt) >= Date.parse(stored.updatedAt)))) {
    // Polling an old generation cannot restore a cleared stop request.
    local.stopRequested ||= stored?.resumeVersion === local.resumeVersion && stored.stopRequested;
    return local;
  }
  return stored;
}

export function decodeBulkSnapshot(row: { state: string; stopVersion: string | number }) {
  const run = GetBulkBrandRunResponse.parse(JSON.parse(row.state));
  run.stopRequested = Number(row.stopVersion) > run.resumeVersion;
  if (run.status === "running" || run.status === "stopping") {
    if (Date.now() - Date.parse(run.heartbeatAt) > 150_000) {
      run.status = "interrupted";
      run.error = "Worker heartbeat expired. Resume explicitly; unfinished requests may already have incurred provider charges.";
    } else if (run.stopRequested) run.status = "stopping";
  }
  return run;
}

export async function readArchivedBulkRuns(id?: string) {
  return observePreparationRead("archive_lookup", () => readArchive(id), rows => rows.length);
}

async function readArchive(id?: string) {
  await ensureBulkStore();
  const rows = await clickHouseJson<{ state: string; stopVersion: string }>(`
    SELECT argMaxIf(data_json, version, event_type = 'snapshot') AS state,
      maxIf(version, event_type = 'stop') AS stopVersion, max(version) AS latest
    FROM ${table} ${id ? "WHERE run_id = {id:UUID}" : ""}
    GROUP BY run_id HAVING notEmpty(state)
      ${id ? "" : "AND JSONExtractString(state, 'archiveOf') = ''"}
    ORDER BY latest DESC LIMIT 30 FORMAT JSON
  `, id ? { id } : {}, 10_000);
  return rows.data.map(decodeBulkSnapshot);
}

export async function readBulkRuns(id?: string) {
  const managed = await bulkOwnership.read(id);
  if (id && managed.length) return managed;
  const archived = await readArchivedBulkRuns(id);
  // A stale worker's late archive append must not surface even if its run is
  // outside the coordinator's latest-30 window.
  const missingIds = archived.filter(run => !managed.some(current => current.id === run.id)).map(run => run.id);
  if (missingIds.length) managed.push(...await bulkOwnership.read(missingIds));
  const ids = new Set(managed.map(run => run.id));
  return [...managed, ...archived.filter(run => !ids.has(run.id))]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
}

/** Conservatively skip prior paid attempts, including failures/interruptions.
 * Never automatically charge again merely because an earlier outcome was incomplete. */
export const paidProfilesSql = `
  SELECT
    JSONExtractUInt(item, 'candidate', 'profileId') AS profile_id,
    arrayDistinct(arrayConcat(
      [JSONExtractString(item, 'candidate', 'accountId')],
      arrayMap(account -> JSONExtractString(account, 'accountId'),
        JSONExtractArrayRaw(item, 'candidate', 'accounts'))
    )) AS account_ids
  FROM poc_new_verticals.profile_bulk_events
  ARRAY JOIN JSONExtractArrayRaw(data_json, 'items') AS item
  PREWHERE event_type = 'snapshot' AND match(data_json, {historyPattern:String})
  WHERE (JSONExtractString(item, 'status') IN ('completed', 'failed', 'running')
      OR notEmpty(JSONExtractString(item, 'startedAt')))
`;

export function candidateAccountIds(candidate: Pick<BulkBrandCandidate, "accountId" | "accounts">) {
  return [...new Set([candidate.accountId, ...(candidate.accounts ?? []).map(account => account.accountId)].filter(Boolean))];
}

/** A no-false-negative prefilter on identity fields avoids parsing every large
 * result snapshot for every catalog page. Whitespace is allowed; patterns are
 * escaped JSON values, never caller-supplied regular expressions. The parsed
 * item/status filters below remain authoritative (raw matches may be unrelated).
 */
export function bulkAttemptSnapshotPattern(ids: number[], accounts: string[] = []) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [`"profileId"\\s*:\\s*(?:${ids.map(String).join("|")})\\s*[,}]`];
  if (accounts.length) patterns.push(`"accountId"\\s*:\\s*(?:${accounts.map(id => escape(JSON.stringify(id))).join("|")})\\s*[,}]`);
  return patterns.join("|");
}

export function attemptedCandidateIds(candidates: BulkBrandCandidate[], rows: { profile_id: number; account_id: string }[]) {
  const profiles = new Set(rows.map(row => Number(row.profile_id)));
  const accounts = new Set(rows.map(row => row.account_id).filter(Boolean));
  return new Set(candidates.filter(candidate => profiles.has(candidate.profileId)
    || candidateAccountIds(candidate).some(id => accounts.has(id))).map(candidate => candidate.profileId));
}

/** Restrict output to the bounded catalog page, but inspect ALL historical starts.
 * A later queued snapshot after Resume must never erase an earlier paid attempt.
 * Stable account IDs retain aliases and survive a change of reference account.
 */
export async function readAttemptedBulkCandidates(candidates: BulkBrandCandidate[]) {
  if (!candidates.length) return new Set<number>();
  const rows = await observePreparationRead("prior_attempts_archive", async () => {
    await ensureBulkStore();
    return clickHouseJson<{ profile_id: number; account_ids: string[] }>(`
    SELECT profile_id, account_ids FROM (${paidProfilesSql})
    WHERE profile_id IN {ids:Array(UInt64)}
      OR hasAny(account_ids, JSONExtract({accounts:String}, 'Array(String)'))
    FORMAT JSON
  `, {
    ids: JSON.stringify(candidates.map(candidate => candidate.profileId)),
    accounts: JSON.stringify([...new Set(candidates.flatMap(candidateAccountIds))]),
    historyPattern: bulkAttemptSnapshotPattern(candidates.map(candidate => candidate.profileId), candidates.flatMap(candidateAccountIds)),
    }, 10_000);
  }, result => result.data.length);
  const attempted = attemptedCandidateIds(candidates, rows.data.flatMap(row =>
    row.account_ids.map(account_id => ({ profile_id: row.profile_id, account_id }))));
  const coordinated = await observePreparationRead("prior_attempts_coordinator",
    () => bulkOwnership.attempted(candidates.map(candidate => candidate.profileId)), result => result.size);
  for (const id of coordinated) attempted.add(id);
  return attempted;
}

export async function readAttemptedBulkProfileIds(ids: number[]) {
  if (!ids.length) return new Set<number>();
  await ensureBulkStore();
  const rows = await clickHouseJson<{ profileId: number }>(`
    SELECT DISTINCT JSONExtractUInt(item, 'candidate', 'profileId') AS profileId
    FROM ${table} ARRAY JOIN JSONExtractArrayRaw(data_json, 'items') AS item
    PREWHERE event_type = 'snapshot' AND match(data_json, {historyPattern:String})
    WHERE profileId IN {ids:Array(UInt64)}
      AND (JSONExtractString(item, 'status') IN ('completed', 'failed', 'running')
        OR notEmpty(JSONExtractString(item, 'startedAt')))
    FORMAT JSON
  `, { ids: JSON.stringify(ids), historyPattern: bulkAttemptSnapshotPattern(ids) }, 10_000);
  const attempted = await bulkOwnership.attempted(ids);
  for (const row of rows.data) attempted.add(Number(row.profileId));
  return attempted;
}

export async function readBulkBatchArchives(rootId: string, afterBatch: number) {
  await ensureBulkStore();
  const rows = await clickHouseJson<{ state: string; stopVersion: string }>(`
    SELECT argMaxIf(data_json, version, event_type = 'snapshot') AS state,
      maxIf(version, event_type = 'stop') AS stopVersion
    FROM ${table} GROUP BY run_id
    HAVING notEmpty(state) AND JSONExtractString(state, 'archiveOf') = {rootId:String}
      AND JSONExtractUInt(state, 'batchNumber') > {afterBatch:UInt64}
    ORDER BY JSONExtractUInt(state, 'batchNumber') ASC LIMIT 21 FORMAT JSON
  `, { rootId, afterBatch: String(afterBatch) }, 10_000);
  const runs = rows.data.slice(0, 20).map(decodeBulkSnapshot);
  return { runs, hasMore: rows.data.length > 20, nextBatch: runs.at(-1)?.batchNumber ?? afterBatch };
}
