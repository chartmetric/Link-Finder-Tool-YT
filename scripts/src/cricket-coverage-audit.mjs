import fs from 'node:fs/promises';

// Offline audit of saved, read-only catalog snapshots and public ICC lists.
// This script never writes to ClickHouse or starts paid discovery.
const dir = 'generated-artifacts/cricket-coverage-audit';
const countries = [
  'India', 'Australia', 'England', 'New Zealand', 'South Africa', 'Pakistan',
  'West Indies', 'Sri Lanka', 'Bangladesh', 'Afghanistan', 'Ireland',
  'Zimbabwe', 'USA', 'Nepal', 'Netherlands', 'Namibia',
];
const countryName = value => ['Ireland Republic', 'Republic of Ireland'].includes(value) ? 'Ireland' : value;
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sources = {
  men: 'https://www.icc-cricket.com/tournaments/mens-t20-world-cup-2026/news/all-the-squads-for-icc-men-s-t20-world-cup-2026',
  women: 'https://www.icc-cricket.com/tournaments/womens-t20-worldcup-2026/news/all-the-squads-at-the-icc-women-s-t20-world-cup-2026',
  legends: 'https://www.icc-cricket.com/hall-of-fame/hall-of-famers',
};
const catalog = JSON.parse(await fs.readFile(`${dir}/catalog.json`, 'utf8'));
const existing = JSON.parse(await fs.readFile(`${dir}/existing.json`, 'utf8'));
const pilot = JSON.parse(await fs.readFile('generated-artifacts/cricket-search/search-results.json', 'utf8'));
const key = player => `${player.provider}:${player.provider_player_id}`;
const prior = new Set([...existing.map(key), ...pilot.map(row => key(row.player))]);
const shortlist = [];
const review = [];

for (const [file, gender, source] of [['men-2026', 'm', sources.men], ['women-2026', 'f', sources.women]]) {
  const markdown = await fs.readFile(`${dir}/${file}.md`, 'utf8');
  for (const line of markdown.split('\n')) {
    const plain = line.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_]/g, '').trim();
    const country = countries.find(name => plain.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    if (!country) continue;
    const names = plain.slice(country.length + 1).split(/\b(?:Travelling reserves|Reserves):/i)[0]
      .split(',').map(name => name.replace(/\([^)]*\)/g, '').trim().replace(/\.$/, '')).filter(Boolean);
    if (names.length !== 15) throw new Error(`${file}: ${country} parsed ${names.length} squad members, expected 15`);
    for (const name of names) shortlist.push({
      source_name: name, country, gender, cohort: '2026 World Cup squad',
      evidence_url: source,
    });
  }
}

// Older Hall of Famers and known deceased players are retained for review, not
// searched for personal accounts. A career date alone never proves life status.
const deceased = new Set(['abdulqadir', 'shanewarne', 'martincrowe', 'bobwillis', 'bishanbedi', 'derekunderwood', 'bobsimpson', 'graemepollock', 'malcolmmarshall', 'rodmarsh']);
const hall = await fs.readFile(`${dir}/icc-hall-of-fame.md`, 'utf8');
for (const match of hall.matchAll(/\]\((https:\/\/www\.icc-cricket\.com\/hall-of-fame\/hall-of-famers\/hall-of-famers?-[^)]+)\)/g)) {
  const block = hall.slice(hall.lastIndexOf('[![undefined]', match.index), match.index);
  const slug = match[1].split('/').at(-1).replace(/^hall-of-famers?-/, '');
  let name = slug.replaceAll('-', ' ');
  if (slug === 'jackques-kallis') name = 'Jacques Kallis';
  const country = block.match(/assets\/flags\/[^)]+\)([A-Za-z ]+)$/)?.[1]?.trim();
  const start = Number(block.match(/career: (\d{4}) - \d{4}/)?.[1] ?? 0);
  const end = Number(block.match(/career: \d{4} - (\d{4})/)?.[1] ?? 0);
  const entry = { source_name: name, country: country ?? '', gender: '', cohort: 'ICC Hall of Fame', career_start: start, career_end: end, evidence_url: match[1] };
  if (deceased.has(normalize(name)) || end < 1980) {
    review.push({ ...entry, reason: deceased.has(normalize(name)) ? 'Known deceased: do not search for a personal account' : 'Older career/life status requires review' });
  } else if (countries.includes(country)) shortlist.push(entry);
  else review.push({ ...entry, reason: 'Country missing from source extract or outside scope' });
}

const alias = new Map(Object.entries({
  // Explicit naming variants; never fuzzy-match or select the first namesake.
  'Melie Kerr': 'Amelia Kerr',
  'Steve Smith': 'Steven Smith',
  'MS Dhoni': 'Mahendra Singh Dhoni',
  'AB de Villiers': 'AB de Villiers',
}).map(([name, value]) => [normalize(name), value]));
const matched = [];
for (const entry of shortlist) {
  const names = new Set([normalize(entry.source_name), normalize(alias.get(normalize(entry.source_name)) ?? entry.source_name)]);
  const candidates = catalog.filter(player =>
    names.has(normalize(player.name)) &&
    countryName(player.country) === entry.country &&
    (!entry.gender || player.gender === entry.gender));
  if (candidates.length !== 1) {
    review.push({ ...entry, reason: candidates.length ? 'Multiple matching provider IDs: identity review required' : 'No exact country/name/gender catalog match' });
    continue;
  }
  const player = candidates[0];
  if (entry.cohort === 'ICC Hall of Fame' && (
    !player.birth_year ||
    entry.career_start - player.birth_year < 14 ||
    entry.career_start - player.birth_year > 45
  )) {
    review.push({ ...entry, reason: 'Catalog birth year missing or incompatible with ICC career dates: possible namesake' });
    continue;
  }
  matched.push({
    ...player, country: countryName(player.country), ...entry,
    gender: entry.gender || player.gender,
    already_selected_or_searched: prior.has(key(player)),
    latest_team: `${entry.country} ${(entry.gender || player.gender) === 'f' ? "women's" : "men's"} ${entry.cohort === 'ICC Hall of Fame' ? 'retired international cricketer, ICC Hall of Fame' : 'national cricket team, 2026 World Cup squad'}`,
    selection_evidence: `${entry.cohort}: ${entry.evidence_url}`,
  });
}
const unique = new Map();
for (const player of matched) {
  const previous = unique.get(key(player));
  unique.set(key(player), previous ? { ...previous, selection_evidence: `${previous.selection_evidence}; ${player.selection_evidence}` } : player);
}
const players = [...unique.values()];
const next = players.filter(player => !player.already_selected_or_searched);
const coverage = countries.map(country => ({
  country,
  catalog_players: catalog.filter(player => countryName(player.country) === country).length,
  already_selected_or_searched: catalog.filter(player => countryName(player.country) === country && prior.has(key(player))).length,
  source_shortlist: shortlist.filter(player => player.country === country).length,
  matched_shortlist: players.filter(player => player.country === country).length,
  matched_women: players.filter(player => player.country === country && player.gender === 'f').length,
  new_searches: next.filter(player => player.country === country).length,
  unresolved_source_entries: review.filter(player => player.country === country).length,
}));
const metadata = {
  preparedAt: new Date().toISOString(), countries, sources,
  uniqueMatched: players.length, newSearches: next.length,
  reusedOrAlreadyQueued: players.length - next.length, reviewEntries: review.length,
  limitations: [
    '2026 tournament squads are dated evidence, not complete November 2026 squads across all formats.',
    'Source country denotes catalog country; team-switchers require explicit identity review.',
    'Hall of Fame is a starting list, not all notable retired players.',
    'Older or known deceased legends are held out of personal-account searches.',
    'No arbitrary catalog-only padding to reach 4,000.',
    'Discovery candidates are unverified; no candidate does not establish account absence.',
  ],
};
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
async function csv(name, rows, keys) {
  await fs.writeFile(`${dir}/${name}.csv`, [keys, ...rows.map(row => keys.map(field => row[field]))].map(row => row.map(csvCell).join(',')).join('\n') + '\n');
}
await fs.writeFile(`${dir}/audit.json`, JSON.stringify({ metadata, coverage, matched: players, review, next }, null, 2));
await csv('country-coverage', coverage, Object.keys(coverage[0]));
await csv('priority-shortlist', players, ['provider', 'provider_player_id', 'name', 'country', 'gender', 'cohort', 'already_selected_or_searched', 'evidence_url']);
await csv('needs-review', review, ['source_name', 'country', 'gender', 'cohort', 'reason', 'evidence_url']);
console.log(JSON.stringify({ metadata, coverage }, null, 2));
