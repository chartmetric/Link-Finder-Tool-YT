import { randomUUID } from "node:crypto";
import { GetBulkBrandRunResponse, type BulkBrandRun } from "@workspace/api-zod";
import { clickHouseJson, clickHouseRequest } from "./clickhouse-profiles";

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

export async function readBulkRuns(id?: string) {
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

/** Conservatively skip prior paid attempts, including failures/interruptions.
 * Never automatically charge again merely because an earlier outcome was incomplete. */
export async function readAttemptedBulkProfileIds(ids: number[]) {
  if (!ids.length) return new Set<number>();
  await ensureBulkStore();
  const rows = await clickHouseJson<{ profileId: number }>(`
    SELECT DISTINCT JSONExtractUInt(item, 'candidate', 'profileId') AS profileId
    FROM (
      SELECT argMax(data_json, version) AS state FROM ${table}
      WHERE event_type = 'snapshot' GROUP BY run_id
    ) ARRAY JOIN JSONExtractArrayRaw(state, 'items') AS item
    WHERE profileId IN {ids:Array(UInt64)}
      AND (JSONExtractString(item, 'status') IN ('completed', 'failed', 'running')
        OR notEmpty(JSONExtractString(item, 'startedAt')))
    FORMAT JSON
  `, { ids: JSON.stringify(ids) }, 10_000);
  return new Set(rows.data.map(row => Number(row.profileId)));
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
