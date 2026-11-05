// Read-only ClickHouse inventory. No discovery/provider calls, DDL, claims or imports.
import fs from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
if (!directory?.startsWith('generated-artifacts/')) throw Error('Choose a generated-artifacts output directory.');
await fs.mkdir(directory, { recursive: false });
const host = process.env.CLICKHOUSE_VERT_HOST;
if (!host) throw Error('ClickHouse configuration unavailable.');
const endpoint = new URL(/^https?:\/\//.test(host) ? host : `https://${host}`);
endpoint.searchParams.set('readonly', '1');
endpoint.searchParams.set('max_execution_time', '120');
endpoint.searchParams.set('output_format_json_quote_64bit_integers', '1');
async function query(sql) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw Error('Read-only SELECT required.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-ClickHouse-User': process.env.CLICKHOUSE_USERNAME, 'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD },
    body: `${sql} FORMAT JSON`, signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) throw Error(`Read-only query HTTP ${response.status}; no automatic retries.`);
  return (await response.json()).data;
}
async function save(name, value) {
  await fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { flag: 'wx' });
}
function csv(rows, fields) {
  const cell = value => `"${String(Array.isArray(value) ? value.join(' | ') : value ?? '').replaceAll('"', '""')}"`;
  return fields.map(cell).join(',') + '\n' + rows.map(row => fields.map(key => cell(row[key])).join(',')).join('\n') + '\n';
}
function instagram(value) {
  try {
    const url = new URL(value);
    if (!['instagram.com', 'www.instagram.com', 'm.instagram.com', 'www-fallback.instagram.com'].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || /^(p|reel|reels|stories|explore|accounts|tv|share|direct)$/i.test(parts[0])
      || !/^[a-z0-9._]{1,30}$/i.test(parts[0])) return null;
    return parts[0].toLowerCase();
  } catch { return null; }
}
function hasEvidence(value, pattern) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    (pattern.test(key) && entry !== null && entry !== false && entry !== '' && JSON.stringify(entry) !== '[]')
    || (typeof entry === 'object' && hasEvidence(entry, pattern)));
}
const snapshot = (await query(`SELECT toString(max(computed_at)) AS snapshot,
  dateDiff('hour',max(computed_at),now()) AS age_hours
  FROM new_vertical.l_profile_tier FINAL WHERE profile_type='musician' AND grain='global'`))[0];
if (!snapshot?.snapshot || Number(snapshot.age_hours) > 36) throw Error('No recent global musician tier snapshot.');
const stamp = snapshot.snapshot;
if (!/^[\d :.-]+$/.test(stamp)) throw Error('Unexpected snapshot timestamp.');
const cohort = `WITH assigned AS (
  SELECT profile,argMax(tier,tuple(computed_at,updated_at)) AS current_tier
  FROM new_vertical.l_profile_tier FINAL
  WHERE profile_type='musician' AND grain='global' AND computed_at='${stamp}'
  GROUP BY profile HAVING current_tier IN (1,2,3,4,5)
)`;
console.log('Reading the frozen global Tier 1–5 cohort and latest saved research.');
const artists = await query(`${cohort}
  SELECT toString(t.profile) AS profile_id,t.current_tier AS tier,
    ifNull(p.name,'') AS artist,toString(ifNull(p.cm_source_id,0)) AS cm_artist
  FROM assigned t LEFT JOIN (SELECT id,name,cm_source_id FROM new_vertical.profile FINAL) p ON p.id=t.profile`);
const results = await query(`SELECT toString(profile_id) AS profile_id,
  tupleElement(latest,1) AS status,tupleElement(latest,2) AS instagram_urls,
  toString(tupleElement(latest,3)) AS updated_at,tupleElement(latest,5) AS error,
  JSONExtractRaw(tupleElement(latest,4),'profiles') AS candidates_json,
  JSONExtractRaw(tupleElement(latest,4),'methodsUsed') AS methods_json,
  JSONExtractKeys(tupleElement(latest,4)) AS result_keys
  FROM (SELECT profile_id,argMax(tuple(status,instagram_urls,updated_at,result_json,error),updated_at) AS latest
    FROM poc_new_verticals.musician_instagram_discovery_events GROUP BY profile_id)`);
await save('snapshot.json', { generatedAt: new Date().toISOString(), ...snapshot, selection: 'All current global Tier 1–5 profiles; not historical researchTier labels.' });
await save('cohort.json', artists);
await save('saved-research.json', results);
console.log(`Read ${artists.length} current profiles and ${results.length} saved profile results. Reading catalog references.`);
const references = await query(`${cohort}
  SELECT toString(l.profile_id) AS profile_id,
    groupUniqArray(tuple(toString(a.id),lower(a.platform),ifNull(a.account_url,''),a.handle)) AS accounts
  FROM (SELECT profile_id,account_id FROM new_vertical.l_profile_account FINAL WHERE disconnected_at IS NULL) l
  INNER JOIN (SELECT id,platform,account_url,handle FROM new_vertical.account FINAL) a ON a.id=l.account_id
  INNER JOIN assigned t ON t.profile=l.profile_id
  GROUP BY l.profile_id`);
await save('catalog-references.json', references);
const byResult = new Map(results.map(row => [row.profile_id, row]));
const byReference = new Map(references.map(row => [row.profile_id, row.accounts]));
// Shared-handle flags include assignments outside the current tier cohort.
const owners = new Map();
for (const row of results) {
  for (const handle of new Set(row.instagram_urls.map(instagram).filter(Boolean))) {
    if (!owners.has(handle)) owners.set(handle, new Set());
    owners.get(handle).add(row.profile_id);
  }
}
const rows = artists.map(artist => {
  const result = byResult.get(artist.profile_id);
  const accounts = byReference.get(artist.profile_id) ?? [];
  const urls = result?.instagram_urls ?? [];
  const handles = [...new Set(urls.map(instagram).filter(Boolean))];
  const catalogHandles = [...new Set(accounts.filter(a => a[1] === 'instagram').map(a => instagram(a[2])).filter(Boolean))];
  const catalogUrl = accounts.some(a => a[1] === 'instagram' && a[2].trim());
  const referenceReady = accounts.some(a =>
    (a[1] === 'spotify' && /^https?:\/\/open\.spotify\.com\/artist\/[a-z0-9]+/i.test(a[2]))
    || (['youtube','youtube_music'].includes(a[1]) && /^https?:\/\/(?:www\.|music\.)?youtube\.com\/(?:channel\/UC[\w-]+|@[\w.-]+)/i.test(a[2])));
  let candidates = [], methods = [];
  try { candidates = JSON.parse(result?.candidates_json || '[]'); } catch {}
  try { methods = JSON.parse(result?.methods_json || '[]'); } catch {}
  if (!Array.isArray(candidates)) candidates = [];
  if (!Array.isArray(methods)) methods = [];
  const shared = handles.filter(handle => owners.get(handle)?.size > 1);
  const identityEvidence = hasEvidence(candidates, /^(identityComparison|metadataComparison|identityVerification|verification|jev|jevDecision|jevDecisions)$/i)
    || (result?.result_keys ?? []).some(key => /^(identityComparison|metadataComparison|identityVerification|verification|jev|jevDecision|jevDecisions)$/i.test(key));
  const serper = methods.some(method => method.method === 'serper' && method.status === 'used');
  const flags = [];
  if (urls.length && !identityEvidence) flags.push('no_saved_identity_verification');
  if (shared.length) flags.push('shared_handle_not_proof_of_mismatch');
  if (urls.some(url => !instagram(url))) flags.push('non_profile_or_invalid_url');
  if (handles.length > 1) flags.push('multiple_candidate_handles');
  if (urls.length && catalogHandles.length && !handles.some(handle => catalogHandles.includes(handle))) flags.push('catalog_disagreement_not_proof_of_mismatch');
  if (result && !serper) flags.push('no_successful_serper_evidence');
  if (result && !referenceReady) flags.push('missing_supported_music_reference');
  if (artist.profile_id === '302463' && handles.includes('belloo_official')) flags.push('user_confirmed_wrong_frankelly_handle');
  if (handles.includes('gulagulafestival') && /gula/i.test(artist.artist)) flags.push('user_reported_wrong_festival_handle');
  const status = result?.status ?? 'not_searched';
  const restricted = /restricted|age.restrict|age.gat|must be 18/i.test(result?.error ?? '');
  let action = 'catalog_link_present_no_automatic_rerun';
  if (result && urls.length) action = identityEvidence ? 'inspect_saved_verification' : 'verify_saved_candidates_first';
  else if (restricted) action = 'restricted_skip_paid_retry';
  else if (result && !['no_candidates','candidates_found'].includes(status)) action = 'diagnose_incomplete_before_retry';
  else if (status === 'no_candidates' && !catalogUrl) action = 'focused_recovery_search_after_validation';
  else if (!catalogUrl && !result) action = 'unsearched_check_eligibility';
  else if (status === 'candidates_found' && !urls.length && !catalogUrl) action = 'inconsistent_saved_result_review';
  return { ...artist, status, catalog_url_present: Number(catalogUrl),
    research_url_present: Number(urls.length > 0), candidate_count: urls.length,
    valid_handle_count: handles.length, shared_handle_count: shared.length,
    shared_handles: shared, supported_music_reference: Number(referenceReady),
    saved_identity_evidence_present: Number(identityEvidence), successful_serper: Number(serper),
    restricted: Number(restricted), action, flags, instagram_urls: urls,
    catalog_instagram_urls: accounts.filter(a => a[1] === 'instagram').map(a => a[2]),
    updated_at: result?.updated_at ?? '' };
});
const tierSummary = [1,2,3,4,5].map(tier => {
  const subset = rows.filter(row => Number(row.tier) === tier);
  const count = test => subset.filter(test).length;
  return { tier, population: subset.length, catalog_url_profiles: count(r => r.catalog_url_present),
    saved_research_profiles: count(r => r.status !== 'not_searched'),
    research_candidate_profiles: count(r => r.research_url_present),
    any_url_profiles: count(r => r.catalog_url_present || r.research_url_present),
    no_candidates_without_catalog: count(r => r.status === 'no_candidates' && !r.catalog_url_present),
    no_url_no_research: count(r => !r.catalog_url_present && r.status === 'not_searched'),
    incomplete_or_failed: count(r => r.status !== 'not_searched' && !['candidates_found','no_candidates'].includes(r.status)),
    shared_handle_profiles: count(r => r.shared_handle_count),
    candidates_without_saved_verification: count(r => r.research_url_present && !r.saved_identity_evidence_present),
    research_profiles_missing_music_reference: count(r => r.status !== 'not_searched' && !r.supported_music_reference),
    restricted_profiles: count(r => r.restricted) };
});
const counts = key => Object.fromEntries([...new Set(rows.map(r => r[key]))].map(value => [value,rows.filter(r => r[key] === value).length]));
const flags = Object.fromEntries([...new Set(rows.flatMap(r => r.flags))].map(flag => [flag,rows.filter(r => r.flags.includes(flag)).length]));
const report = { readOnly: true, paidProviderRequests: 0, databaseWrites: 0, snapshot: stamp,
  generatedAt: new Date().toISOString(), tierSummary, actions: counts('action'), flags,
  caveats: [
    'Shared handles, catalog disagreement and multiple candidates are review flags, not measured false positives.',
    'Missing saved verifier evidence means unverified, not incorrect. Existing catalog links are not revalidated by this audit.',
    'Completed no-candidate searches do not prove account absence.',
    'Supported-reference checks are syntactic, not live reachability or ownership verification.',
    'Restrictions are counted only when explicit in the saved error, never inferred from HTTP 403/404 alone.',
    'This inventory uses current global tiers. Saved results outside these tiers only contribute to shared-handle detection.',
    'Reads are not a cross-table transaction. Raw selected inputs are archived for reproducibility.'
  ] };
await save('audit-report.json', report);
await fs.writeFile(path.join(directory,'tier-summary.csv'),csv(tierSummary,Object.keys(tierSummary[0])),{flag:'wx'});
const fields = Object.keys(rows[0]);
await fs.writeFile(path.join(directory,'profile-audit-NOT-FOR-IMPORT.csv'),csv(rows,fields),{flag:'wx'});
await fs.writeFile(path.join(directory,'worklist-NOT-FOR-IMPORT.csv'),csv(rows.filter(r => r.action !== 'catalog_link_present_no_automatic_rerun'),fields),{flag:'wx'});
console.log(JSON.stringify(report,null,2));
