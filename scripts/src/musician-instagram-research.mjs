import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function researchTiers(args = []) {
  const option = args.find(arg => arg.startsWith('--tiers='));
  if (!option) return [3];
  const value = option.slice('--tiers='.length);
  if (!/^[12345](,[12345])*$/.test(value)) throw new Error('Choose tiers 1–5 explicitly.');
  return [...new Set(value.split(',').map(Number))].sort((a, b) => a - b);
}
export function selectionForTiers(query, tiers) {
  if (tiers.length === 1 && tiers[0] === 3) return query;
  return query.replace('AND tier = 3', `AND tier IN (${tiers.join(',')})`);
}
export function selectionAtSnapshot(query, snapshotAt) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(snapshotAt)) throw new Error('Invalid tier snapshot timestamp.');
  return query.replace('computed_at >= toStartOfDay(now())',
    `computed_at = toDateTime('${snapshotAt}', 'UTC')`);
}
export function researchWorkers(args = [], fallback = 4) {
  const option = args.find(arg => arg.startsWith('--workers='));
  const workers = option ? Number(option.slice('--workers='.length)) : fallback;
  if (!Number.isInteger(workers) || workers < 1 || workers > 20) throw new Error('Choose 1–20 parallel workers.');
  return workers;
}
export function admittedProfileIds(records) {
  const admitted = new Set();
  for (const record of records) {
    if (record.phase === 'cancelled_before_dispatch') admitted.delete(record.profileId);
    else admitted.add(record.profileId);
  }
  return admitted;
}
const tiers = researchTiers(process.argv.slice(3));
const cliArgs = process.argv.slice(3);
const rerunNoCandidates = cliArgs.includes('--rerun-no-candidates');
const requestedRunId = cliArgs.find(arg => arg.startsWith('--run-id='))?.slice('--run-id='.length);
function rerunDirectory(runId) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('A valid --run-id is required for this rerun.');
  return `generated-artifacts/musician-instagram-rerun-no-candidates-${runId}`;
}
if (requestedRunId && !rerunNoCandidates) throw new Error('--run-id is only valid with --rerun-no-candidates.');
if (rerunNoCandidates && ['run', 'status'].includes(process.argv[2]) && !requestedRunId) {
  throw new Error('--run-id from the prepare output is required for this rerun.');
}
let directory = rerunNoCandidates
  ? (requestedRunId ? rerunDirectory(requestedRunId) : '')
  : `generated-artifacts/musician-instagram-tier${tiers.join('-')}-all`;
const events = 'poc_new_verticals.musician_instagram_discovery_events';
const runs = 'poc_new_verticals.musician_instagram_discovery_runs';
const lookup = 'poc_new_verticals.musician_instagram_lookup';
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const quote = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

async function sql(query) {
  const host = process.env.CLICKHOUSE_VERT_HOST;
  if (!host || !process.env.CLICKHOUSE_USERNAME || !process.env.CLICKHOUSE_PASSWORD) throw new Error('ClickHouse configuration unavailable.');
  const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  url.searchParams.set('max_execution_time', '45');
  url.searchParams.set('output_format_json_quote_64bit_integers', '1');
  url.searchParams.set('async_insert', '0');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': process.env.CLICKHOUSE_USERNAME, 'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD },
    body: query, signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}; no automatic retry.`);
  return response.text();
}
async function select(query) { return JSON.parse(await sql(`${query} FORMAT JSON`)).data; }
async function insert(table, rows) {
  if (rows.length) await sql(`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map(row => JSON.stringify(row)).join('\n')}`);
}
async function setup() {
  await sql(`CREATE TABLE IF NOT EXISTS ${runs} (
    run_id UUID, updated_at DateTime64(3, 'UTC'), status String, metadata_json String
  ) ENGINE = MergeTree ORDER BY (run_id, updated_at)`);
  await sql(`CREATE TABLE IF NOT EXISTS ${events} (
    run_id UUID, profile_id UInt64, cm_artist UInt64, account_ids Array(UInt64),
    artist String, chartmetric_url String, tier_rank UInt32, monthly_listeners Nullable(Float64),
    updated_at DateTime64(3, 'UTC'), status LowCardinality(String),
    instagram_urls Array(String), result_json String, error String
  ) ENGINE = MergeTree ORDER BY (profile_id, run_id, updated_at)`);
  await sql(`CREATE VIEW IF NOT EXISTS ${lookup} AS
    WITH argMax(source.snapshot, source.updated_at) AS latest
    SELECT source.profile_id AS profile_id, latest.1 AS cm_artist, latest.2 AS artist,
      arraySort(arrayDistinct(arrayFlatten(groupArray(source.account_ids)))) AS account_ids,
      latest.3 AS status, latest.4 AS instagram_urls, latest.5 AS result_json,
      latest.6 AS run_id, latest.7 AS updated_at, latest.8 AS error,
      'unverified_candidates' AS identity_status
    FROM (
      SELECT profile_id, account_ids, updated_at,
        tuple(cm_artist,artist,status,instagram_urls,result_json,run_id,updated_at,error) AS snapshot
      FROM ${events}
    ) AS source
    GROUP BY source.profile_id`);
}

export function validatePlayers(players, { allowMissingArtist = false } = {}) {
  if (!players.length) throw new Error('No artists match the requested tier selection; no paid work started.');
  const seen = new Set();
  for (const player of players) {
    for (const id of [player.profile_id, player.cm_artist, ...(player.account_ids ?? [])]) {
      if (!/^[0-9]+$/.test(String(id)) || BigInt(id) > 18446744073709551615n) throw new Error('Invalid lookup identity.');
    }
    if ((!allowMissingArtist && !player.artist?.trim()) || seen.has(player.profile_id)) throw new Error('Missing artist or duplicate profile; no paid work started.');
    seen.add(player.profile_id);
  }
}
export function initialState(player, previous) {
  if (!player.artist?.trim()) return { status: 'needs_review', result: {}, urls: [],
    error: 'Missing artist name in source catalog; no paid search dispatched.' };
  if (!previous) return { status: 'queued', result: {}, urls: [], error: '' };
  const [status, urls, json, error, sourceRunId, , cmArtist] = previous.latest;
  const result = JSON.parse(json);
  if (['candidates_found', 'no_candidates'].includes(status)
    && String(cmArtist) === player.cm_artist
    && result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used')) {
    return { status, urls, error: '', result: { ...result, reusedFromRunId: sourceRunId,
      reusedOriginalEstimatedCostUsd: result.estimatedCostUsd, estimatedCostUsd: 0 } };
  }
  // Never race an older queued job or replay a failed/uncertain admission.
  return { status: 'needs_review', result: { ...result, previousRunId: sourceRunId }, urls: [],
    error: error || 'Previous work needs review before another paid search; not automatically replayed.' };
}
export function rerunNoCandidateProfiles(players, previousByProfile) {
  return players.filter(player => {
    const previous = previousByProfile.get(player.profile_id);
    if (!previous) return false;
    const [status, urls, resultJson, , , , cmArtist] = previous.latest;
    if (status !== 'no_candidates' || !Array.isArray(urls) || urls.length || String(cmArtist) !== player.cm_artist) return false;
    try {
      const result = JSON.parse(resultJson);
      return result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used') === true;
    } catch {
      return false;
    }
  });
}
export function candidateUrls(result) {
  if (!result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used')) {
    throw new Error('Required Serper search did not complete; stopped without fallback or automatic retry.');
  }
  return [...new Set((result.profiles ?? []).flatMap(profile => {
    let url;
    try { url = new URL(profile.url); } catch { return []; }
    const path = url.pathname.split('/').filter(Boolean);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname) || url.protocol !== 'https:'
      || path.length !== 1 || ['p', 'reel', 'reels', 'stories', 'explore', 'accounts'].includes(path[0].toLowerCase())) {
      return [];
    }
    return [url.href];
  }))];
}

function event(id, player, status, result = {}, urls = [], error = '') {
  return { run_id: id, profile_id: player.profile_id, cm_artist: player.cm_artist,
    account_ids: player.account_ids, artist: player.artist, chartmetric_url: player.chartmetric_url,
    tier_rank: player.tier_rank, monthly_listeners: player.monthly_listeners ?? null,
    updated_at: stamp(), status, instagram_urls: urls,
    result_json: JSON.stringify({ ...result, ...(player.tier ? { researchTier: player.tier } : {}) }), error };
}
async function metadata(id, status, data) {
  await insert(runs, [{ run_id: id, updated_at: stamp(), status, metadata_json: JSON.stringify(data) }]);
}
async function prepare() {
  let selectionSql = selectionForTiers(
    await fs.readFile(new URL('./musician-instagram-cohort.sql', import.meta.url), 'utf8'), tiers);
  let snapshotAt;
  if (cliArgs.includes('--latest-snapshot')) {
    const [snapshot] = await select(`SELECT toString(max(computed_at)) AS snapshot_at,
      dateDiff('second',max(computed_at),now()) AS age_seconds
      FROM new_vertical.l_profile_tier FINAL WHERE profile_type='musician'`);
    if (!snapshot || Number(snapshot.age_seconds) < 0 || Number(snapshot.age_seconds) > 36 * 3600) {
      throw new Error('Latest musician tier snapshot is missing or older than 36 hours; no paid work started.');
    }
    snapshotAt = snapshot.snapshot_at;
    selectionSql = selectionAtSnapshot(selectionSql, snapshotAt);
  }
  let players = await select(selectionSql);
  validatePlayers(players, { allowMissingArtist: true });
  const previous = new Map();
  for (let start = 0; start < players.length; start += 1000) {
    const ids = players.slice(start, start + 1000).map(player => player.profile_id).join(',');
    for (const row of await select(`SELECT toString(e.profile_id) AS profile_id,
      argMax(tuple(status,instagram_urls,result_json,error,run_id,updated_at,cm_artist),updated_at) AS latest
      FROM ${events} AS e WHERE e.profile_id IN (${ids}) GROUP BY e.profile_id`)) previous.set(row.profile_id, row);
  }
  if (rerunNoCandidates) {
    players = rerunNoCandidateProfiles(players, previous);
    if (!players.length) throw new Error('No eligible completed Serper no-candidate profiles remain; no paid work started.');
  }
  const links = [];
  for (let start = 0; start < players.length; start += 1000) {
    const ids = players.slice(start, start + 1000).map(player => player.profile_id).join(',');
    links.push(...await select(`SELECT toString(l.profile_id) AS profile_id, toString(l.account_id) AS account_id,
      a.platform, a.handle, a.account_url
      FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id, platform, handle, account_url FROM new_vertical.account FINAL) AS a ON a.id = l.account_id
      WHERE l.profile_id IN (${ids})`));
  }
  const linksByProfile = new Map();
  for (const link of links) {
    const list = linksByProfile.get(link.profile_id) ?? [];
    list.push(link);
    linksByProfile.set(link.profile_id, list);
  }
  for (const player of players) {
    player.accounts = linksByProfile.get(player.profile_id) ?? [];
    player.account_ids = [...new Set(player.accounts.map(link => link.account_id))];
    if (player.accounts.some(account => account.platform === 'instagram')) throw new Error('Cohort changed: an Instagram account is already linked. Reselect before paying.');
  }
  validatePlayers(players, { allowMissingArtist: true });
  const runId = rerunNoCandidates ? (requestedRunId ?? randomUUID()) : randomUUID();
  if (rerunNoCandidates) directory = rerunDirectory(runId);
  const workers = researchWorkers(cliArgs, rerunNoCandidates ? 5 : 4);
  const states = players.map(player => rerunNoCandidates
    ? { status: 'queued', result: {}, urls: [], error: '' }
    : initialState(player, previous.get(player.profile_id)));
  const reusedCount = states.filter(state => state.result.reusedFromRunId).length;
  const reviewCount = states.filter(state => state.status === 'needs_review').length;
  const newSearches = states.filter(state => state.status === 'queued').length;
  const accepted = { runId, count: players.length, selectedAt: new Date().toISOString(),
    scope: rerunNoCandidates
      ? `Focused Serper rerun of completed no-candidate Tier ${tiers.join(', ')} musicians without a linked Instagram account`
      : `ALL current Tier ${tiers.join(', ')} musicians without any linked Instagram account`,
    tiers, snapshotAt, tierCounts: Object.fromEntries(tiers.map(tier => [tier, players.filter(player => player.tier === tier).length])),
    reusedCount, reviewCount, maximumNewPaidSearches: newSearches,
    methods: ['serper'], platform: 'instagram', workers, selectionSql, players,
    rerunNoCandidates,
    automaticPaidRetries: false, verification: 'Unverified indexed search candidates, not account approval.' };
  await fs.mkdir(directory, { recursive: true });
  const file = await fs.open(`${directory}/accepted.json`, 'wx');
  try { await file.writeFile(JSON.stringify(accepted, null, 2)); } finally { await file.close(); }
  await setup();
  for (let start = 0; start < players.length; start += 1000) {
    await insert(events, players.slice(start, start + 1000).map((player, offset) => {
      const state = states[start + offset];
      return event(runId, player, state.status, state.result, state.urls, state.error);
    }));
  }
  await metadata(runId, 'prepared', { ...accepted, players: undefined });
  console.log(JSON.stringify({ runId, count: players.length, snapshotAt, tierCounts: accepted.tierCounts, reusedCount, reviewCount, newSearches,
    withAccountIds: players.filter(p => p.account_ids.length).length }));
}

export async function processQueue({ players, save, search, workers = 4, shouldStop = () => false, progress = () => {} }) {
  researchWorkers([], workers);
  let stopped = false, cursor = 0, finished = 0;
  async function worker() {
    while (!stopped && !shouldStop() && cursor < players.length) {
      const player = players[cursor++];
      const subject = `${player.artist}, musician`;
      if (!player.artist?.trim() || subject.length > 120) {
        const error = 'Artist name is missing or exceeds the search API subject limit; no paid search dispatched.';
        await save(player, 'needs_review', {}, [], error);
        finished++;
        progress({ finished, profileId: player.profile_id, artist: player.artist,
          status: 'needs_review', candidates: 0, error });
        continue;
      }
      // Durable admission precedes the paid request. A save failure aborts;
      // a lost request remains running/uncertain and is never auto-replayed.
      await save(player, 'running', {}, [], '');
      if (stopped || shouldStop()) { await save(player, 'queued', {}, [], ''); break; }
      let result = {}, urls = [], status = 'failed', error = '';
      try {
        result = await search(player);
        urls = candidateUrls(result);
        status = urls.length ? 'candidates_found' : 'no_candidates';
      } catch (failure) { stopped = true; error = failure.message; }
      await save(player, status, result, urls, error);
      finished++;
      progress({ finished, profileId: player.profile_id, artist: player.artist, status, candidates: urls.length, error });
    }
  }
  // Drain other lanes even if persistence fails; do not abandon live requests.
  const outcomes = await Promise.allSettled(Array.from({ length: workers }, async () => {
    try { await worker(); } catch (error) { stopped = true; throw error; }
  }));
  const failure = outcomes.find(outcome => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return { stopped: stopped || shouldStop(), finished };
}

async function run() {
  const accepted = JSON.parse(await fs.readFile(`${directory}/accepted.json`, 'utf8'));
  const { runId } = accepted;
  const workers = researchWorkers(process.argv.slice(3), accepted.workers ?? 4);
  const lock = await fs.open(`${directory}/${runId}.lock`, 'wx');
  let stopRequested = false;
  process.on('SIGTERM', () => { stopRequested = true; });
  process.on('SIGINT', () => { stopRequested = true; });
  try {
    let admissions = '';
    try { admissions = await fs.readFile(`${directory}/${runId}-admissions.jsonl`, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const admitted = admittedProfileIds(admissions.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const saved = await select(`SELECT toString(profile_id) AS profile_id, argMax(status,updated_at) AS status
      FROM ${events} WHERE run_id=${quote(runId)} GROUP BY profile_id`);
    if (saved.length !== accepted.players.length) throw new Error('Preparation incomplete; no paid work started.');
    const statuses = new Map(saved.map(row => [row.profile_id, row.status]));
    if (saved.some(row => row.status === 'running' || (row.status === 'queued' && admitted.has(row.profile_id)))) {
      throw new Error('Uncertain previous admission; review before retrying.');
    }
    const queue = accepted.players.filter(player => statuses.get(player.profile_id) === 'queued');
    await metadata(runId, 'running', { queuedAtStart: queue.length, methods: ['serper'], workers,
      originalWorkers: accepted.workers, explicitWorkerOverride: workers !== accepted.workers });
    console.log(JSON.stringify({ runId, status: 'running', workers, remaining: queue.length }));
    await processQueue({
      players: queue, workers, shouldStop: () => stopRequested,
      save: async (player, status, result, urls, error) => {
        // Local write-ahead admission also protects against a stale replica
        // returning "queued" after a previously dispatched request.
        if (status === 'running') await fs.appendFile(`${directory}/${runId}-admissions.jsonl`,
          `${JSON.stringify({ profileId: player.profile_id, admittedAt: new Date().toISOString() })}\n`, { flush: true });
        const row = event(runId, player, status, result, urls, error);
        try {
          await insert(events, [row]);
          if (status === 'queued') await fs.appendFile(`${directory}/${runId}-admissions.jsonl`,
            `${JSON.stringify({ profileId: player.profile_id, phase: 'cancelled_before_dispatch', at: new Date().toISOString() })}\n`, { flush: true });
        }
        catch (failure) {
          await fs.appendFile(`${directory}/${runId}-unsaved.jsonl`, `${JSON.stringify(row)}\n`);
          throw failure;
        }
      },
      search: async player => {
        const response = await fetch(`https://${process.env.REPLIT_DEV_DOMAIN}/api/profiles/search`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subject: `${player.artist}, musician`, targetPlatforms: ['instagram'], methods: ['serper'] }),
          signal: AbortSignal.timeout(65000),
        });
        if (!response.ok) throw new Error(`Search HTTP ${response.status}; stopped without automatic retry.`);
        return response.json();
      },
      progress: row => console.log(JSON.stringify({ runId, ...row })),
    });
    await report(accepted);
  } finally { await lock.close(); await fs.unlink(`${directory}/${runId}.lock`); }
}
async function report(accepted) {
  const rows = await select(`SELECT toString(profile_id) AS profile_id,
    argMax(tuple(cm_artist,account_ids,artist,status,instagram_urls,error),updated_at) AS latest
    FROM ${events} WHERE run_id=${quote(accepted.runId)} GROUP BY profile_id ORDER BY profile_id`);
  const counts = {};
  for (const row of rows) counts[row.latest[3]] = (counts[row.latest[3]] ?? 0) + 1;
  const csv = [['profile_id','cm_artist','account_ids','artist','status','instagram_urls','identity_status','error']];
  for (const row of rows) csv.push([row.profile_id, row.latest[0], row.latest[1].join(' | '), row.latest[2],
    row.latest[3], row.latest[4].join(' | '), 'Unverified candidates; no result does not prove absence', row.latest[5]]);
  await fs.writeFile(`${directory}/${accepted.runId}.csv`, csv.map(row => row.map(value =>
    `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n');
  const status = counts.failed || counts.running || counts.queued || counts.needs_review ? 'needs_review' : 'completed';
  await metadata(accepted.runId, status, { counts, methods: ['serper'], verification: 'Unverified candidates' });
  console.log(JSON.stringify({ runId: accepted.runId, final: true, status, counts, lookupView: lookup }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const command = process.argv[2];
  if (command === 'prepare') await prepare();
  else if (command === 'run') await run();
  else if (command === 'status') await report(JSON.parse(await fs.readFile(`${directory}/accepted.json`, 'utf8')));
  else throw new Error('Usage: musician-instagram-research.mjs prepare | run | status [--tiers=1,2,3,4,5] [--latest-snapshot] [--workers=5] [--rerun-no-candidates] [--run-id=UUID]');
}
