import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Explicit one-off cohort preparation. No provider calls; source tables are read-only.
// A separate explicit runner command starts paid work from the durable queue.
const write = process.argv.includes('--prepare');
const directory = 'generated-artifacts/cricket-additional-2000';
const countries = ['India', 'Australia', 'England', 'New Zealand', 'South Africa',
  'Pakistan', 'West Indies', 'Sri Lanka', 'Bangladesh', 'Afghanistan', 'Ireland',
  'Zimbabwe', 'USA', 'Nepal', 'Netherlands', 'Namibia'];
const countryName = value => ['Ireland Republic', 'Republic of Ireland'].includes(value) ? 'Ireland' : value;
const key = player => `${player.provider}:${player.provider_player_id}`;
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const identity = player => `${countryName(player.country)}:${player.gender}:${normalized(player.name)}`;
const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
async function sql(query) {
  const host = process.env.CLICKHOUSE_VERT_HOST;
  if (!host || !process.env.CLICKHOUSE_USERNAME || !process.env.CLICKHOUSE_PASSWORD) throw new Error('ClickHouse configuration unavailable');
  const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': process.env.CLICKHOUSE_USERNAME, 'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD },
    body: query, signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`ClickHouse request failed (${response.status})`);
  return response.text();
}
async function select(query) { return JSON.parse(await sql(`${query} FORMAT JSON`)).data; }
async function insert(table, rows) {
  await sql(`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map(row => JSON.stringify(row)).join('\n')}`);
}
const [catalogRows, prior, audit] = await Promise.all([
  select(`WITH players AS (
    SELECT provider, provider_player_id,
      argMax(tuple(full_name, country_id, gender, date_of_birth, position_name,
        batting_style, bowling_style, image_url), ingested_at) AS d
    FROM poc_new_verticals.cricketers_sportmonks WHERE provider = 'sportmonks'
    GROUP BY provider, provider_player_id
  ), countries AS (
    SELECT country_id, argMax(name, synced_at) AS country
    FROM poc_new_verticals.sportmonks_cricket_countries GROUP BY country_id
  )
  SELECT p.provider, p.provider_player_id, d.1 AS name, c.country,
    d.3 AS gender, toYear(d.4) AS birth_year, d.5 AS position_name,
    d.6 AS batting_style, d.7 AS bowling_style,
    notEmpty(ifNull(d.8, '')) AS has_image
  FROM players p LEFT JOIN countries c ON d.2 = c.country_id`),
  select(`SELECT provider, provider_player_id,
    argMax(tuple(status, player_json), updated_at) AS latest
    FROM poc_new_verticals.cricket_link_discovery_events GROUP BY provider, provider_player_id`),
  fs.readFile('generated-artifacts/cricket-coverage-audit/audit.json', 'utf8').then(JSON.parse),
]);
const pilot = JSON.parse(await fs.readFile('generated-artifacts/cricket-search/search-results.json', 'utf8'));
const catalog = catalogRows.map(player => ({ ...player, country: countryName(player.country) }));
const excluded = new Set([...prior.map(key), ...pilot.map(row => key(row.player))]);
const usedNames = new Set(prior.map(row => {
  const player = JSON.parse(row.latest[1]);
  return `${countryName(player.country)}:${normalized(player.name)}`;
}));
const nameKey = player => `${player.country}:${normalized(player.name)}`;
const heldNames = new Set(audit.review.map(player => `${countryName(player.country)}:${normalized(player.source_name)}`));
const multiplicity = new Map();
for (const player of catalog) multiplicity.set(identity(player), (multiplicity.get(identity(player)) ?? 0) + 1);
const byKey = new Map(catalog.map(player => [key(player), player]));
const selected = [];
const selectedKeys = new Set();
function add(player) {
  if (excluded.has(key(player)) || selectedKeys.has(key(player)) || usedNames.has(nameKey(player))) return false;
  selected.push(player);
  selectedKeys.add(key(player));
  usedNames.add(nameKey(player));
  return true;
}
for (const verified of audit.matched) {
  const current = byKey.get(key(verified));
  if (!current || current.country !== verified.country ||
      normalized(current.name) !== normalized(verified.name) ||
      current.gender !== verified.gender || Number(current.birth_year) !== Number(verified.birth_year)) continue;
  add({ ...current, latest_team: verified.latest_team,
    cohort: verified.cohort, selection_evidence: verified.selection_evidence });
}
const priorityCount = selected.length;
// Broader catalog cohort, not a claimed ranking of quality/current national selection.
// Require an adult birth year in a modern era, full name, role metadata, photo,
// unique country/name/gender identity, and no unresolved historical-name match.
const eligible = catalog.filter(player =>
  countries.includes(player.country) && ['m', 'f'].includes(player.gender) &&
  Number(player.birth_year) >= 1980 && Number(player.birth_year) <= 2008 &&
  player.name.trim().split(/\s+/).length >= 2 && player.name.trim().length >= 5 &&
  player.has_image && player.position_name &&
  multiplicity.get(identity(player)) === 1 &&
  !heldNames.has(nameKey(player)) && !excluded.has(key(player)) &&
  !selectedKeys.has(key(player)) && !usedNames.has(nameKey(player)));
// Stable interleaving provides country/gender breadth, not an ability ranking.
const buckets = countries.flatMap(country => ['f', 'm'].map(gender =>
  eligible.filter(player => player.country === country && player.gender === gender)
    .sort((a, b) => Number(Boolean(b.batting_style) && Boolean(b.bowling_style)) -
      Number(Boolean(a.batting_style) && Boolean(a.bowling_style)) ||
      a.provider_player_id - b.provider_player_id)));
while (selected.length < 2000) {
  let progressed = false;
  for (const bucket of buckets) {
    while (bucket.length) {
      const player = bucket.shift();
      if (add({ ...player, latest_team: `${player.country} ${player.gender === 'f' ? "women's" : "men's"} cricket; Sportmonks catalog`,
        cohort: 'Broader adult catalog',
        selection_evidence: 'Country, gender, birth year, role and image in Sportmonks catalog; national selection and playing strength not independently established' })) {
        progressed = true;
        break;
      }
    }
    if (selected.length === 2000) break;
  }
  if (!progressed) throw new Error(`Only ${selected.length} eligible unique players; no queue written.`);
}
if (prior.length !== 2000) throw new Error(`Expected 2000 previously attempted players, found ${prior.length}; review before preparing.`);
const summary = {
  selected: selected.length, priorityCount, broaderCatalog: selected.length - priorityCount,
  priorUnique: prior.length, maximumNewPaidSearches: 2000,
  platform: 'instagram', methods: ['gemini'], workers: 4, automaticPaidRetries: false,
  countries: countries.map(country => ({ country, selected: selected.filter(p => p.country === country).length })),
  limitations: [
    'Working 16-country basket, not a verified current ICC top-16 ranking.',
    'Only the priority shortlist has independently checked squad/Hall of Fame evidence.',
    'Broader catalog membership does not prove current activity or playing strength.',
    'Candidates remain unverified; no result is not proof of account absence.',
  ],
};
await fs.mkdir(directory, { recursive: true });
if (!write) {
  await fs.writeFile(`${directory}/selection-preview.json`, JSON.stringify({ summary, players: selected }, null, 2));
  console.log(JSON.stringify({ ...summary, prepared: false }));
} else {
  // Refuse another preparation when an earlier accepted cohort exists locally.
  const file = await fs.open(`${directory}/accepted.json`, 'wx');
  const id = randomUUID();
  try {
    await file.writeFile(JSON.stringify({ runId: id, summary, players: selected }, null, 2));
  } finally { await file.close(); }
  const now = stamp();
  await insert('poc_new_verticals.cricket_link_discovery_events', selected.map(player => ({
    run_id: id, provider: player.provider, provider_player_id: Number(player.provider_player_id),
    platform: 'instagram', updated_at: now, status: 'queued',
    player_json: JSON.stringify(player), result_json: '{}', error: '',
  })));
  await insert('poc_new_verticals.cricket_link_discovery_runs', [{
    run_id: id, updated_at: stamp(), status: 'prepared', metadata_json: JSON.stringify(summary),
  }]);
  console.log(JSON.stringify({ ...summary, runId: id, prepared: true }));
}
