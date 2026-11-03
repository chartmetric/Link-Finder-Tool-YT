import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function validationQueries(artist) {
  const name = artist.replace(/["\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Artist name required.');
  return [
    `${name} instagram`,
    `"${name}" site:instagram.com`,
    `${name} site:instagram.com -inurl:/p/ -inurl:/reel/ -inurl:/reels/`,
  ];
}

export function directInstagramProfile(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (!['https:', 'http:'].includes(url.protocol)
      || !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)
      || parts.length !== 1
      || !/^[a-z0-9._]{1,30}$/i.test(parts[0])
      || ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'about', 'direct'].includes(parts[0].toLowerCase())) return null;
    return `https://www.instagram.com/${parts[0].toLowerCase()}/`;
  } catch { return null; }
}

async function clickhouse(query) {
  const { CLICKHOUSE_VERT_HOST: host, CLICKHOUSE_USERNAME: user, CLICKHOUSE_PASSWORD: password } = process.env;
  if (!host || !user || !password) throw new Error('ClickHouse configuration missing.');
  const endpoint = new URL(/^https?:/.test(host) ? host : `https://${host}`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': user, 'X-ClickHouse-Key': password },
    body: query, signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}.`);
  return (await response.json()).data;
}

async function prepare() {
  const rows = await clickhouse(`SELECT toString(profile_id) AS profile_id,
    toString(cm_artist) AS cm_artist, account_ids, artist, chartmetric_url, tier_rank,
    monthly_listeners, JSONExtractUInt(result_json,'researchTier') AS tier
    FROM poc_new_verticals.musician_instagram_discovery_events
    WHERE run_id=toUUID('98120573-5f9e-4f09-8519-c3fd5898b562')
      AND status='no_candidates' AND empty(instagram_urls)
    ORDER BY coalesce(monthly_listeners,0) DESC,profile_id
    FORMAT JSON`);
  const example = rows.find(row => row.profile_id === '281761');
  if (!example) throw new Error('Known example not found in the no-candidate cohort.');
  const artists = [example];
  const names = new Set([example.artist.toLowerCase().replace(/[^a-z0-9]/g, '')]);
  for (const [tier, count] of [[2, 4], [3, 5]]) {
    let added = 0;
    for (const row of rows) {
      const key = row.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (Number(row.tier) !== tier || names.has(key)) continue;
      artists.push(row); names.add(key);
      if (++added === count) break;
    }
    if (added !== count) throw new Error('Insufficient distinct artists for the validation sample.');
  }
  const runId = randomUUID();
  const directory = `generated-artifacts/musician-instagram-validation-${runId}`;
  await fs.mkdir(directory, { recursive: true });
  const manifest = {
    runId, createdAt: new Date().toISOString(), provider: 'serper', maximumRequests: 30,
    sampleMethod: 'Known counterexample plus highest-listener distinct names: four Tier 2 and five additional Tier 3.',
    knownPositive: { profileId: example.profile_id, url: 'https://www.instagram.com/shenge_wasehlalankosi/', source: 'user', excludedFromQueries: true },
    artists: artists.map(row => ({ ...row, queries: validationQueries(row.artist) })),
    automaticRetries: false, catalogWrites: false,
  };
  await fs.writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ directory, profiles: artists.length, maximumRequests: 30 }));
}

async function run(directory) {
  if (!/^generated-artifacts\/musician-instagram-validation-[0-9a-f-]{36}$/.test(directory ?? '')) {
    throw new Error('Pass the exact validation directory returned by prepare.');
  }
  const manifest = JSON.parse(await fs.readFile(`${directory}/manifest.json`, 'utf8'));
  if (manifest.artists.length !== 10 || manifest.artists.some(row => row.queries.length !== 3)) {
    throw new Error('Expected exactly ten artists and three queries each.');
  }
  if (!process.env.SERPERDEV_API_KEY) throw new Error('Serper key missing.');
  // Exclusive ledger creation prevents replay of admitted/uncertain paid requests.
  const ledger = await fs.open(`${directory}/admissions.jsonl`, 'wx');
  let dispatched = 0;
  const outcomes = [];
  try {
    for (const artist of manifest.artists) {
      const hits = [];
      for (const [queryIndex, query] of artist.queries.entries()) {
        if (dispatched >= 30) throw new Error('Request budget exhausted.');
        await ledger.write(`${JSON.stringify({ profileId: artist.profile_id, queryIndex, query, admittedAt: new Date().toISOString() })}\n`);
        await ledger.sync();
        dispatched++;
        const response = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': process.env.SERPERDEV_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, gl: 'us', num: 10, autocorrect: false }),
          signal: AbortSignal.timeout(20000),
        });
        const raw = await response.json();
        await fs.writeFile(`${directory}/${artist.profile_id}-${queryIndex}.json`,
          JSON.stringify({ query, status: response.status, receivedAt: new Date().toISOString(), response: raw }, null, 2), { flag: 'wx' });
        if (!response.ok || raw.error || !Array.isArray(raw.organic)) {
          throw new Error(`Serper response incomplete or failed (HTTP ${response.status}); stopped without retry.`);
        }
        for (const hit of raw.organic) {
          hits.push({ queryIndex, query, title: hit.title, url: hit.link, snippet: hit.snippet,
            profileUrl: directInstagramProfile(hit.link) });
        }
      }
      const profileUrls = [...new Set(hits.map(hit => hit.profileUrl).filter(Boolean))];
      const outcome = { ...artist, hits, profileUrls,
        knownPositiveFound: artist.profile_id === manifest.knownPositive.profileId
          ? profileUrls.includes(manifest.knownPositive.url) : null,
        identityStatus: 'unreviewed_search_results' };
      outcomes.push(outcome);
      await fs.writeFile(`${directory}/outcomes.json`, JSON.stringify(outcomes, null, 2));
      console.log(JSON.stringify({ completed: outcomes.length, profileId: artist.profile_id,
        directProfileUrls: profileUrls.length, knownPositiveFound: outcome.knownPositiveFound, dispatched }));
    }
    await fs.writeFile(`${directory}/summary.json`, JSON.stringify({
      runId: manifest.runId, status: 'completed', dispatched,
      profiles: outcomes.length, profilesWithDirectResults: outcomes.filter(row => row.profileUrls.length).length,
      knownPositiveFound: outcomes.find(row => row.knownPositiveFound !== null)?.knownPositiveFound,
      identityStatus: 'unreviewed_search_results', catalogWrites: false,
    }, null, 2));
  } finally { await ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === 'prepare') await prepare();
  else if (command === 'run') await run(process.argv[3]);
  else throw new Error('Usage: musician-instagram-validation.mjs prepare | run DIRECTORY');
}
