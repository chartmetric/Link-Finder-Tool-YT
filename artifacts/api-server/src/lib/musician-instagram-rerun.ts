import { createHash, randomUUID } from "node:crypto";
import { findProfiles } from "./musician-search";
import { clickHouseJson, clickHouseRequest } from "./clickhouse-profiles";

type ArtistRow = {
  profile_id: string;
  cm_artist: string;
  artist: string;
  tier: number | string;
  tier_rank: number | string;
  account_ids: string[];
};

type LookupRow = {
  profile_id: string;
  latest: [string, string[], string, string, string, string, string];
};

type Player = ArtistRow & { account_ids: string[] };
type RunEvent = {
  run_id: string;
  profile_id: string;
  cm_artist: string;
  account_ids: string[];
  artist: string;
  tier_rank: number;
  updated_at: string;
  status: string;
  instagram_urls: string[];
  result_json: string;
  error: string;
};
type PreviousResult = { latest: [string, string[], string, string, string, string, string] };
type IdentityRow = Pick<ArtistRow, "profile_id" | "cm_artist" | "artist" | "account_ids">;

type RunControl = { stopRequested: boolean; count: number; phase: "preparing" | "running" };
const controls = new Map<string, RunControl>();
const requestRuns = new Map<string, Promise<InstagramRerunRun>>();
const stamp = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const quote = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let ensureTablesPromise: Promise<void> | undefined;

async function ensureResearchTables() {
  if (!ensureTablesPromise) {
    ensureTablesPromise = (async () => {
      for (const ddl of [
        `CREATE TABLE IF NOT EXISTS poc_new_verticals.musician_instagram_discovery_runs (
          run_id UUID, updated_at DateTime64(3, 'UTC'), status String, metadata_json String
        ) ENGINE = MergeTree ORDER BY (run_id, updated_at)`,
        `CREATE TABLE IF NOT EXISTS poc_new_verticals.musician_instagram_discovery_events (
          run_id UUID, profile_id UInt64, cm_artist UInt64, account_ids Array(UInt64),
          artist String, chartmetric_url String, tier_rank UInt32, monthly_listeners Nullable(Float64),
          updated_at DateTime64(3, 'UTC'), status LowCardinality(String),
          instagram_urls Array(String), result_json String, error String
        ) ENGINE = MergeTree ORDER BY (profile_id, run_id, updated_at)`,
      ]) {
        const response = await clickHouseRequest(ddl, 30_000);
        if (!response.ok) throw new Error(`INSTAGRAM_RESEARCH_SETUP_FAILED:${response.status}`);
      }
    })().catch(error => {
      ensureTablesPromise = undefined;
      throw error;
    });
  }
  await ensureTablesPromise;
}

export type InstagramRerunEligibility = {
  count: number;
  selectionToken: string;
  generatedAt: string;
};

export type InstagramRerunRun = {
  runId: string;
  status: "prepared" | "running" | "stop_requested" | "stopped" | "completed" | "needs_review";
  count: number;
  finished: number;
  stopRequested: boolean;
  active: boolean;
  paidAdmissionsOccurred: boolean;
  profiles: Array<{
    profileId: string;
    artist: string;
    tier: number;
    status: string;
    instagramUrls: string[];
    error: string;
  }>;
};

function eligibleSnapshot(players: Player[]) {
  return createHash("sha256")
    .update(players.map(player => `${player.profile_id}:${player.cm_artist}`).join("\n"))
    .digest("hex");
}

export function hasCompletedSerperNoCandidate(player: Pick<IdentityRow, "cm_artist">, previous?: PreviousResult) {
  if (!previous) return false;
  const [status, urls, resultJson, , , , cmArtist] = previous.latest;
  if (status !== "no_candidates" || urls.length || String(cmArtist) !== player.cm_artist) return false;
  try {
    const result = JSON.parse(resultJson) as { methodsUsed?: Array<{ method: string; status: string }> };
    return result.methodsUsed?.some(method => method.method === "serper" && method.status === "used") === true;
  } catch {
    return false;
  }
}

export function validateRerunIdentities(players: IdentityRow[]) {
  if (!players.length) throw new Error("NO_ELIGIBLE_PROFILES");
  const max = 18446744073709551615n;
  const seen = new Set<string>();
  for (const player of players) {
    for (const id of [player.profile_id, player.cm_artist, ...player.account_ids]) {
      if (!/^[0-9]+$/.test(String(id)) || BigInt(id) > max) throw new Error("INVALID_LOOKUP_IDENTITY");
    }
    if (!player.artist?.trim() || seen.has(player.profile_id)) throw new Error("INVALID_RERUN_PROFILE");
    seen.add(player.profile_id);
  }
}

function makeEvent(runId: string, player: Player, status: string, result: unknown = {}, urls: string[] = [], error = ""): RunEvent {
  return {
    run_id: runId,
    profile_id: player.profile_id,
    cm_artist: player.cm_artist,
    account_ids: player.account_ids,
    artist: player.artist,
    tier_rank: Number(player.tier_rank),
    updated_at: stamp(),
    status,
    instagram_urls: urls,
    result_json: JSON.stringify({ ...(result as object), researchTier: Number(player.tier) }),
    error,
  };
}

async function insertEvents(rows: RunEvent[]) {
  if (!rows.length) return;
  const response = await clickHouseRequest(
    `INSERT INTO poc_new_verticals.musician_instagram_discovery_events FORMAT JSONEachRow\n${rows.map(row => JSON.stringify(row)).join("\n")}`,
    60_000,
  );
  if (!response.ok) throw new Error(`INSTAGRAM_RESEARCH_SAVE_FAILED:${response.status}`);
}

async function saveMetadata(runId: string, status: string, metadata: Record<string, unknown>) {
  const response = await clickHouseRequest(
    `INSERT INTO poc_new_verticals.musician_instagram_discovery_runs FORMAT JSONEachRow\n${JSON.stringify({ run_id: runId, updated_at: stamp(), status, metadata_json: JSON.stringify(metadata) })}`,
    30_000,
  );
  if (!response.ok) throw new Error(`INSTAGRAM_RESEARCH_METADATA_FAILED:${response.status}`);
}

async function loadPlayersForRerun(): Promise<Player[]> {
  const candidates = await clickHouseJson<LookupRow>(`
    WITH latest AS (
      SELECT profile_id,
        argMax(tuple(status,instagram_urls,result_json,error,run_id,updated_at,cm_artist),updated_at) AS outcome
      FROM poc_new_verticals.musician_instagram_discovery_events
      GROUP BY profile_id
    )
    SELECT toString(profile_id) AS profile_id, outcome AS latest
    FROM latest
    WHERE tupleElement(outcome, 1) = 'no_candidates' AND empty(tupleElement(outcome, 2))
    FORMAT JSON
  `, {}, 60_000);
  const previousById = new Map(candidates.data.map(row => [row.profile_id, row]));
  const candidateIds = candidates.data
    .filter(row => hasCompletedSerperNoCandidate({ cm_artist: String(row.latest[6]) }, row))
    .map(row => row.profile_id);
  const matched: Player[] = [];
  for (let start = 0; start < candidateIds.length; start += 1000) {
    const ids = candidateIds.slice(start, start + 1000);
    const profiles = await clickHouseJson<Omit<ArtistRow, "account_ids">>(`
      WITH current_tier AS (
        SELECT profile, argMax(tier, tuple(computed_at, updated_at)) AS tier,
          argMax(tier_rank, tuple(computed_at, updated_at)) AS tier_rank
        FROM new_vertical.l_profile_tier FINAL
        WHERE profile_type = 'musician' AND computed_at >= toStartOfDay(now())
          AND profile IN (${ids.join(",")})
        GROUP BY profile
        HAVING tier IN (1, 2, 3)
      )
      SELECT toString(p.id) AS profile_id, toString(p.cm_source_id) AS cm_artist,
        p.name AS artist, t.tier, t.tier_rank
      FROM current_tier AS t
      INNER JOIN (SELECT id, name, cm_source_id FROM new_vertical.profile FINAL
        WHERE cm_source = 'cm_artist' AND cm_source_id IS NOT NULL) AS p ON p.id = t.profile
      WHERE p.id NOT IN (
        SELECT l.profile_id
        FROM new_vertical.l_profile_account AS l FINAL
        INNER JOIN (SELECT id, platform FROM new_vertical.account FINAL) AS a ON a.id = l.account_id
        WHERE a.platform = 'instagram' AND l.profile_id IN (${ids.join(",")})
      )
      ORDER BY t.tier, t.tier_rank, p.id
      FORMAT JSON
    `, {}, 60_000);
    if (!profiles.data.length) continue;
    const selectedIds = profiles.data.map(row => row.profile_id).join(",");
    const links = await clickHouseJson<{ profile_id: string; account_id: string }>(`
      SELECT toString(l.profile_id) AS profile_id, toString(l.account_id) AS account_id
      FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id FROM new_vertical.account FINAL) AS a ON a.id = l.account_id
      WHERE l.profile_id IN (${selectedIds})
      FORMAT JSON
    `, {}, 45_000);
    const accounts = new Map<string, Set<string>>();
    for (const link of links.data) {
      const current = accounts.get(link.profile_id) ?? new Set<string>();
      current.add(link.account_id);
      accounts.set(link.profile_id, current);
    }
    for (const profile of profiles.data) {
      const player = { ...profile, account_ids: [...(accounts.get(profile.profile_id) ?? [])] };
      if (hasCompletedSerperNoCandidate(player, previousById.get(player.profile_id))) matched.push(player);
    }
  }
  return matched;
}

export async function getInstagramRerunEligibility(): Promise<InstagramRerunEligibility> {
  await ensureResearchTables();
  const players = await loadPlayersForRerun();
  return {
    count: players.length,
    selectionToken: eligibleSnapshot(players),
    generatedAt: new Date().toISOString(),
  };
}

export async function startInstagramNoMatchRerun(input: {
  requestId: string;
  selectionToken: string;
  expectedCount: number;
  paidAcknowledged: boolean;
}): Promise<InstagramRerunRun> {
  if (!input.paidAcknowledged) throw new Error("EXPLICIT_PAID_ACK_REQUIRED");
  if (!uuidPattern.test(input.requestId)) throw new Error("INVALID_REQUEST_ID");
  if (!Number.isSafeInteger(input.expectedCount) || input.expectedCount < 1) throw new Error("INVALID_EXPECTED_COUNT");
  const existing = requestRuns.get(input.requestId);
  if (existing) return existing;
  if (controls.size > 0) throw new Error("ANOTHER_RERUN_ACTIVE");
  const control: RunControl = { stopRequested: false, count: input.expectedCount, phase: "preparing" };
  controls.set(input.requestId, control);
  const pending = (async () => {
    await ensureResearchTables();
    const prior = await clickHouseJson<{ profile_count: number | string }>(`
      SELECT countDistinct(profile_id) AS profile_count
      FROM poc_new_verticals.musician_instagram_discovery_events
      WHERE run_id = toUUID(${quote(input.requestId)})
      FORMAT JSON
    `, {}, 30_000);
    if (Number(prior.data[0]?.profile_count ?? 0) > 0) {
      controls.delete(input.requestId);
      return getInstagramRerunRun(input.requestId);
    }
    const priorMetadata = await readRunMetadata(input.requestId);
    if (priorMetadata) {
      controls.delete(input.requestId);
      return getInstagramRerunRun(input.requestId);
    }
    await saveMetadata(input.requestId, "prepared", {
      scope: "Completed Serper no-candidate musician profiles, current Tier 1–3, Instagram only",
      methods: ["serper"], platform: "instagram", paidAcknowledged: true,
      automaticPaidRetries: false, requestId: input.requestId, count: input.expectedCount,
      phase: "preparing", selectedAt: new Date().toISOString(),
    });
    const players = await loadPlayersForRerun();
    if (!players.length || eligibleSnapshot(players) !== input.selectionToken || players.length !== input.expectedCount) {
      controls.delete(input.requestId);
      await saveMetadata(input.requestId, "needs_review", {
        methods: ["serper"], platform: "instagram", automaticPaidRetries: false,
        count: input.expectedCount, phase: "eligibility_changed", paidAdmissionsOccurred: false,
      });
      throw new Error(players.length ? "ELIGIBILITY_CHANGED" : "NO_ELIGIBLE_PROFILES");
    }
    validateRerunIdentities(players);
    const runId = input.requestId;
    if (control.stopRequested) {
      controls.delete(runId);
      await saveMetadata(runId, "stopped", {
        methods: ["serper"], platform: "instagram", automaticPaidRetries: false,
        count: players.length, stopRequested: true, paidAdmissionsOccurred: false,
      });
      return getInstagramRerunRun(runId);
    }
    await insertEvents(players.map(player => makeEvent(runId, player, "queued")));
    await saveMetadata(runId, "prepared", {
      scope: "Completed Serper no-candidate musician profiles, current Tier 1–3, Instagram only",
      methods: ["serper"], platform: "instagram", paidAcknowledged: true,
      automaticPaidRetries: false, requestId: input.requestId, count: players.length, selectedAt: new Date().toISOString(),
    });
    control.phase = "running";
    void processRun(runId, players, control);
    return getInstagramRerunRun(runId);
  })();
  requestRuns.set(input.requestId, pending);
  try {
    const run = await pending;
    requestRuns.delete(input.requestId);
    return run;
  } catch (error) {
    requestRuns.delete(input.requestId);
    if (control.phase === "preparing") controls.delete(input.requestId);
    throw error;
  }
}

function instagramProfileUrls(result: { profiles?: Array<{ url?: string }> }) {
  const urls = new Set<string>();
  for (const profile of result.profiles ?? []) {
    try {
      const url = new URL(profile.url ?? "");
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.protocol === "https:" && ["instagram.com", "www.instagram.com"].includes(url.hostname)
        && parts.length === 1 && !["p", "reel", "reels", "stories", "explore", "accounts"].includes(parts[0].toLowerCase())) {
        urls.add(url.href);
      }
    } catch { /* Ignore malformed provider candidates. */ }
  }
  return [...urls];
}

async function processRun(runId: string, players: Player[], control: RunControl) {
  let cursor = 0;
  let stoppedByProvider = false;
  const worker = async () => {
    while (!control.stopRequested && !stoppedByProvider) {
      const player = players[cursor++];
      if (!player) return;
      await insertEvents([makeEvent(runId, player, "running")]);
      if (control.stopRequested) {
        await insertEvents([makeEvent(runId, player, "queued")]);
        return;
      }
      let result: Awaited<ReturnType<typeof findProfiles>> | undefined;
      let status = "failed";
      let urls: string[] = [];
      let error = "";
      try {
        result = await findProfiles({
          subject: `${player.artist}, musician`,
          targetPlatforms: ["instagram"],
          methods: ["serper"],
          serperApiKey: process.env.SERPERDEV_API_KEY ?? process.env.SERPER_API_KEY,
        });
        if (!result.methodsUsed.some(method => method.method === "serper" && method.status === "used")) {
          result = undefined;
          throw new Error("Required Serper search did not complete; stopped without fallback or automatic retry.");
        }
        urls = instagramProfileUrls(result);
        status = urls.length ? "candidates_found" : "no_candidates";
      } catch (failure) {
        stoppedByProvider = true;
        error = "Serper search failed or did not complete. It was not automatically retried; review provider activity before paying again.";
      }
      await insertEvents([makeEvent(runId, player, status, result ?? {}, urls, error)]);
    }
  };
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      try {
        await worker();
      } catch (error) {
        stoppedByProvider = true;
        throw error;
      }
    }));
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const rows = await readRunRows(runId);
    const unresolved = rows.filter(row => ["queued", "running", "failed"].includes(row.status)).length;
    const status = unresolved ? (control.stopRequested && !stoppedByProvider ? "stopped" : "needs_review") : "completed";
    await saveMetadata(runId, status, {
      scope: "Completed Serper no-candidate musician profiles, current Tier 1–3, Instagram only",
      methods: ["serper"], platform: "instagram", automaticPaidRetries: false,
      stopRequested: control.stopRequested, counts: rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {}),
    });
  } catch {
    // A persisted "running" event remains an uncertain paid admission; never replay it.
    try { await saveMetadata(runId, "needs_review", { methods: ["serper"], platform: "instagram", automaticPaidRetries: false }); } catch { /* Preserve the original uncertainty in events. */ }
  } finally {
    controls.delete(runId);
  }
}

async function readRunRows(runId: string) {
  const rows = await clickHouseJson<{
    profile_id: string;
    latest: [string, string, number, string, string[], string];
  }>(`
    SELECT toString(profile_id) AS profile_id,
      argMax(tuple(artist,status,tier_rank,cm_artist,instagram_urls,error),updated_at) AS latest
    FROM poc_new_verticals.musician_instagram_discovery_events
    WHERE run_id = toUUID(${quote(runId)})
    GROUP BY profile_id
    ORDER BY profile_id
    FORMAT JSON
  `, {}, 30_000);
  return rows.data.map(row => ({
    profileId: row.profile_id, artist: row.latest[0], status: row.latest[1],
    tier: Number(row.latest[2]), instagramUrls: row.latest[4] ?? [], error: row.latest[5] ?? "",
  }));
}

async function readRunMetadata(runId: string) {
  const result = await clickHouseJson<{ status: string; metadata_json: string }>(`
    SELECT argMax(status, updated_at) AS status,
      argMax(metadata_json, updated_at) AS metadata_json
    FROM poc_new_verticals.musician_instagram_discovery_runs
    WHERE run_id = toUUID(${quote(runId)})
    FORMAT JSON
  `, {}, 30_000);
  const metadata = result.data[0];
  return metadata?.status ? metadata : undefined;
}

export async function getInstagramRerunRun(runId: string): Promise<InstagramRerunRun> {
  await ensureResearchTables();
  const rows = await readRunRows(runId);
  const active = controls.has(runId);
  const metadata = await readRunMetadata(runId);
  if (!rows.length && !metadata && !active) throw new Error("RUN_NOT_FOUND");
  const meta = metadata?.metadata_json ? JSON.parse(metadata.metadata_json) as { count?: number } : {};
  const count = rows.length || Number(meta.count ?? controls.get(runId)?.count ?? 0);
  const paidAdmissionsOccurred = rows.some(row => row.status !== "queued");
  const finished = rows.filter(row => !["queued", "running"].includes(row.status)).length;
  const failed = rows.some(row => ["failed", "running"].includes(row.status));
  let status: InstagramRerunRun["status"] = active ? "running"
    : metadata?.status === "stopped" ? "stopped"
    : metadata?.status === "needs_review" || failed ? "needs_review"
    : metadata?.status === "prepared" ? "needs_review"
    : "completed";
  if (active && controls.get(runId)?.stopRequested) status = "stop_requested";
  else if (active && controls.get(runId)?.phase === "preparing") status = "prepared";
  else if (active && controls.get(runId)?.phase === "running" && rows.length > 0 && rows.every(row => row.status === "queued")) status = "prepared";
  if (!active && metadata?.status !== "stopped" && rows.some(row => row.status === "queued")) status = "needs_review";
  return {
    runId, status, count, finished, stopRequested: status === "stop_requested" || status === "stopped",
    active, paidAdmissionsOccurred, profiles: rows,
  };
}

export async function stopInstagramRerun(runId: string): Promise<InstagramRerunRun> {
  await ensureResearchTables();
  const control = controls.get(runId);
  if (!control) throw new Error("RUN_NOT_ACTIVE");
  control.stopRequested = true;
  await saveMetadata(runId, "stop_requested", {
    methods: ["serper"], platform: "instagram", stopRequested: true, automaticPaidRetries: false,
  });
  return getInstagramRerunRun(runId);
}

export function newInstagramRerunRequestId() {
  return randomUUID();
}
