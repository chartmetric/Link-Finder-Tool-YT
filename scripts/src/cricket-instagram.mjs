import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Explicitly launched, bounded research job. Never automatically replay a paid
// call whose outcome is uncertain. Source catalog tables are read-only.
const runsTable = 'poc_new_verticals.cricket_link_discovery_runs';
const itemsTable = 'poc_new_verticals.cricket_link_discovery_events';
const output = 'generated-artifacts/cricket-1000';
const [command, runId] = process.argv.slice(2);
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
const quote = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
async function sql(query) {
  const host = process.env.CLICKHOUSE_VERT_HOST;
  if (!host || !process.env.CLICKHOUSE_USERNAME || !process.env.CLICKHOUSE_PASSWORD) throw new Error('ClickHouse configuration unavailable');
  const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': process.env.CLICKHOUSE_USERNAME, 'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD },
    body: query, signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`ClickHouse request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  return response.text();
}
async function select(query) { return JSON.parse(await sql(`${query} FORMAT JSON`)).data; }
async function insert(table, rows) {
  if (rows.length) await sql(`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map(row => JSON.stringify(row)).join('\n')}`);
}
async function setup() {
  await sql(`CREATE TABLE IF NOT EXISTS ${runsTable} (
    run_id UUID, updated_at DateTime64(3, 'UTC'), status String, metadata_json String
  ) ENGINE = MergeTree ORDER BY (run_id, updated_at)`);
  await sql(`CREATE TABLE IF NOT EXISTS ${itemsTable} (
    run_id UUID, provider String, provider_player_id UInt32, platform LowCardinality(String),
    updated_at DateTime64(3, 'UTC'), status LowCardinality(String),
    player_json String, result_json String, error String
  ) ENGINE = MergeTree ORDER BY (run_id, provider, provider_player_id, platform, updated_at)`);
}
const event = (id, player, status, result = {}, error = '') => ({
  run_id: id, provider: player.provider, provider_player_id: Number(player.provider_player_id),
  platform: 'instagram', updated_at: stamp(), status,
  player_json: JSON.stringify(player), result_json: JSON.stringify(result), error,
});
async function items(id) {
  return select(`SELECT provider, provider_player_id,
    argMax(tuple(status, player_json, result_json, error), updated_at) AS latest
    FROM ${itemsTable} WHERE run_id = ${quote(id)}
    GROUP BY provider, provider_player_id ORDER BY provider_player_id`);
}
async function metadata(id, status, data = {}) {
  await insert(runsTable, [{ run_id: id, updated_at: stamp(), status, metadata_json: JSON.stringify(data) }]);
}
async function writeExports(id) {
  const rows = await items(id);
  await fs.mkdir(output, { recursive: true });
  const csv = [['provider', 'provider_player_id', 'name', 'country', 'latest_team', 'recent_24m_matches', 'total_matches', 'last_match', 'status', 'candidate_urls', 'verification', 'estimated_cost_usd', 'error']];
  for (const row of rows) {
    const [status, playerJson, resultJson, error] = row.latest;
    const player = JSON.parse(playerJson); const result = JSON.parse(resultJson);
    csv.push([row.provider, row.provider_player_id, player.name, player.country, player.latest_team,
      player.recent_matches, player.total_matches, player.last_match, status,
      (result.profiles ?? []).map(p => p.url).join(' | '), 'Unverified text discovery', result.estimatedCostUsd ?? '', error]);
  }
  await fs.writeFile(`${output}/${id}.csv`, csv.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n');
  return rows;
}
async function prepare() {
  await setup();
  const players = await select(`
    WITH players AS (
      SELECT provider, provider_player_id, argMax(tuple(full_name, country_id), ingested_at) AS details
      FROM poc_new_verticals.cricketers_sportmonks WHERE provider = 'sportmonks'
      GROUP BY provider, provider_player_id
    ), fixtures AS (
      SELECT fixture_id, argMax(tuple(starting_at, localteam_id, localteam_name, visitorteam_id, visitorteam_name), synced_at) AS fixture
      FROM poc_new_verticals.sportmonks_cricket_fixtures GROUP BY fixture_id
    ), lineups AS (
      SELECT fixture_id, player_id, argMax(tuple(team_id), synced_at) AS lineup
      FROM poc_new_verticals.sportmonks_cricket_lineups GROUP BY fixture_id, player_id
    ), countries AS (
      SELECT country_id, argMax(name, synced_at) AS country
      FROM poc_new_verticals.sportmonks_cricket_countries GROUP BY country_id
    ), activity AS (
      SELECT l.player_id, count() AS total_matches,
        countIf(f.fixture.1 >= now() - INTERVAL 24 MONTH) AS recent_matches,
        max(f.fixture.1) AS last_match,
        argMax(if(l.lineup.1 = f.fixture.2, f.fixture.3,
          if(l.lineup.1 = f.fixture.4, f.fixture.5, '')), f.fixture.1) AS latest_team
      FROM lineups l INNER JOIN fixtures f ON l.fixture_id = f.fixture_id
      WHERE f.fixture.1 <= now()
      GROUP BY l.player_id
    )
    SELECT p.provider, p.provider_player_id, p.details.1 AS name,
      c.country, a.total_matches, a.recent_matches, a.last_match, a.latest_team
    FROM players p INNER JOIN activity a ON p.provider_player_id = a.player_id
    LEFT JOIN countries c ON p.details.2 = c.country_id
    WHERE lengthUTF8(trim(p.details.1)) >= 3
    ORDER BY recent_matches DESC, total_matches DESC, last_match DESC, provider_player_id ASC
    LIMIT 1000
  `);
  if (players.length !== 1000) throw new Error(`Expected 1000 eligible players, found ${players.length}. No paid calls started.`);
  const id = randomUUID();
  await insert(itemsTable, players.map(player => event(id, player, 'queued')));
  // Reuse the already-paid pilot only when the exact provider-qualified ID matches.
  let pilot = [];
  try { pilot = JSON.parse(await fs.readFile('generated-artifacts/cricket-search/search-results.json', 'utf8')); } catch {}
  const reusable = players.flatMap(player => {
    const saved = pilot.find(row => row.player.provider === player.provider && row.player.provider_player_id === player.provider_player_id && row.status === 200 && row.result?.profiles?.length);
    return saved ? [event(id, player, 'completed_reused', saved.result)] : [];
  });
  await insert(itemsTable, reusable);
  await metadata(id, 'prepared', {
    count: players.length, reused: reusable.length, platform: 'instagram', methods: ['gemini'],
    selection: 'Highest recorded match appearances in past 24 months, then total appearances, then latest match; Sportmonks catalog coverage only, not a global quality ranking.',
    maximumNewPaidSearches: players.length - reusable.length, automaticPaidRetries: false,
  });
  await writeExports(id);
  console.log(JSON.stringify({ runId: id, selected: players.length, reused: reusable.length, topPlayers: players.slice(0, 15) }));
}
async function run(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new Error('Supply a valid run ID');
  await fs.mkdir(output, { recursive: true });
  const lockPath = `${output}/${id}.lock`;
  const lock = await fs.open(lockPath, 'wx'); // Same-workspace duplicate launch guard; stale lock needs explicit review.
  let stopped = false; let failures = 0; let finished = 0; let fatal;
  process.on('SIGTERM', () => { stopped = true; });
  process.on('SIGINT', () => { stopped = true; });
  try {
    const rows = await items(id);
    const queue = rows.filter(row => row.latest[0] === 'queued').map(row => JSON.parse(row.latest[1]));
    await metadata(id, 'running', { queuedAtStart: queue.length, workers: 4 });
    let cursor = 0;
    async function worker() {
      while (!stopped && cursor < queue.length) {
        const player = queue[cursor++];
        // Persist the claim BEFORE the paid call. Running/failed items are NEVER automatically retried.
        try { await insert(itemsTable, [event(id, player, 'running')]); }
        catch (error) { stopped = true; fatal = error; break; }
        let result = {}; let status = 'failed'; let error = '';
        try {
          const subject = `${player.name}, cricketer`;
          const location = [player.country, player.latest_team].filter(Boolean).join('; ').slice(0, 100);
          const response = await fetch(`https://${process.env.REPLIT_DEV_DOMAIN}/api/profiles/search`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject, location, targetPlatforms: ['instagram'], methods: ['gemini'] }),
            signal: AbortSignal.timeout(65000),
          });
          result = await response.json();
          if (!response.ok) throw new Error(`Search HTTP ${response.status}: ${result.error ?? 'failed'}`);
          if (!result.methodsUsed?.some(method => method.method === 'gemini' && method.status === 'used')) throw new Error('Gemini did not complete; availability not established.');
          status = result.profiles?.length ? 'completed_candidates' : 'completed_no_candidates';
          failures = 0;
        } catch (failure) {
          error = failure.message; failures++;
          if (failures >= 5) stopped = true; // Stop rather than spend through a sustained provider outage.
        }
        try { await insert(itemsTable, [event(id, player, status, result, error)]); }
        catch (failure) {
          await fs.appendFile(`${output}/${id}-unsaved-results.jsonl`, JSON.stringify(event(id, player, status, result, error)) + '\n');
          stopped = true; fatal = failure;
        }
        finished++;
        console.log(JSON.stringify({ runId: id, finishedThisProcess: finished, player: player.name, playerId: player.provider_player_id, status, candidates: result.profiles?.length ?? 0, error }));
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    const final = await writeExports(id);
    const counts = {};
    for (const row of final) counts[row.latest[0]] = (counts[row.latest[0]] ?? 0) + 1;
    await metadata(id, stopped || counts.running || counts.queued ? 'needs_review' : 'completed', { counts, finishedThisProcess: finished });
    console.log(JSON.stringify({ runId: id, final: true, counts }));
    if (fatal) throw fatal;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
if (command === 'prepare') await prepare();
else if (command === 'run') await run(runId);
else if (command === 'status') {
  if (!/^[0-9a-f-]{36}$/i.test(runId ?? '')) throw new Error('Supply a valid run ID');
  const rows = await writeExports(runId); const counts = {};
  for (const row of rows) counts[row.latest[0]] = (counts[row.latest[0]] ?? 0) + 1;
  console.log(JSON.stringify({ runId, counts }));
} else throw new Error('Usage: node scripts/src/cricket-instagram.mjs prepare | run RUN_ID | status RUN_ID');
