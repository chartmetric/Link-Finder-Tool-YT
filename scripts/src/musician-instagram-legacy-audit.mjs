// Offline quarantine only: no database client, secrets, HTTP, discovery or claims adapter.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assessInstagramCandidates, instagramProfileUrl, MATCHING_POLICY } from './musician-instagram-matching.mjs';
import { researchExportRows } from './musician-instagram-research.mjs';

const knownCases = [
  { profile_id: '302463', cm_artist: '9424667', artist: 'Frankelly Bello',
    note: 'User-confirmed wrong belloo_official attribution. Supplied frankellybello_ is evaluation-only, never injected into candidates. frankellybello and frankellybello_ are distinct accounts.' },
  { profile_id: '249317', cm_artist: '15122359', artist: 'Gula Mın 76',
    note: 'Festival association is not artist ownership. User-reported absence is not independently confirmed account absence.' },
  { profile_id: '3861995', cm_artist: '5238310', artist: 'Rooby Jeantal',
    note: 'Namesakes and label associations do not establish artist ownership; missing evidence remains unresolved.' },
];

export function exactId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Unsafe numeric identifier; original digits required.');
  const text = String(value ?? '');
  if (!/^\d+$/.test(text) || BigInt(text) > 18446744073709551615n) throw Error('Invalid UInt64 identifier.');
  return text;
}

// Quote unsafe integer tokens before JSON.parse, including nested result_json strings
// when those are parsed separately. Never round a UInt64 through a JS Number.
export function parseExactJson(text) {
  let out = '', index = 0;
  while (index < text.length) {
    const start = index;
    if (text[index] === '"') {
      index++;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index++] === '"') break;
      }
      out += text.slice(start, index);
    } else if (text[index] === '-' || /\d/.test(text[index])) {
      const token = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!token) throw Error('Invalid JSON number.');
      index += token[0].length;
      out += /^-?\d+$/.test(token[0]) && !Number.isSafeInteger(Number(token[0]))
        ? JSON.stringify(token[0]) : token[0];
    } else { out += text[index++]; }
  }
  return JSON.parse(out);
}

export function parseCsv(text) {
  const records = [];
  let row = [], cell = '', quoted = false, endedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; endedQuote = true; }
      else cell += char;
    } else if (char === '"' && !cell && !endedQuote) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell); cell = ''; endedQuote = false;
      if (char !== ',') {
        records.push(row); row = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (endedQuote || char === '"') throw Error('Malformed CSV quoting.');
      cell += char;
    }
  }
  if (quoted) throw Error('Unclosed CSV quote.');
  if (cell || row.length || endedQuote) records.push([...row, cell]);
  const fields = records.shift() ?? [];
  if (!fields.length || new Set(fields).size !== fields.length) throw Error('Missing or duplicate CSV headers.');
  return { fields, rows: records.map(values => {
    if (values.length !== fields.length) throw Error('CSV field count mismatch.');
    return Object.fromEntries(fields.map((key, i) => [key, values[i]]));
  }) };
}

export function toCsv(rows, fields) {
  const cell = value => `"${String(Array.isArray(value) ? value.join(' | ') : value ?? '').replaceAll('"', '""')}"`;
  return [fields.map(cell).join(','), ...rows.map(row => fields.map(key => cell(row[key])).join(','))].join('\n') + '\n';
}
const split = value => Array.isArray(value) ? value : String(value ?? '').split(' | ').filter(Boolean);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length
  && a.every(value => b.includes(value));
const normalized = urls => urls.map(instagramProfileUrl);
const html = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function auditHtml(report) {
  const metric = (label, value) => `<li><strong>${html(value)}</strong> ${html(label)}</li>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Legacy Instagram exports — withheld / unresolved</title>
<style>:root{color-scheme:light dark;font:16px/1.6 system-ui}body{max-width:1100px;margin:40px auto;padding:0 24px}
h1{line-height:1.2}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:10px;text-align:left;border:1px solid #8886;overflow-wrap:anywhere}
.warning{border:2px solid #b57720;padding:16px}code{overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}
@media(prefers-color-scheme:dark){body{background:#111b20;color:#eef4f6}}@media(prefers-color-scheme:light){body{background:#fafcfc;color:#14292e}}</style>
<h1>Legacy Instagram exports<br>WITHHELD / UNRESOLVED</h1>
<p class="warning"><strong>Not an import authorization.</strong> Historical search hits and CSV policy labels do not prove artist ownership.
Missing evidence is not a confirmed wrong account or proof of account absence.</p>
<p>Generated ${html(report.generated_at)}. Scope: local archived musician snapshots and CSV files only, not the current database.</p>
<ul>${metric('snapshot row occurrences checked', report.snapshot_rows)}${metric('CSV row occurrences checked', report.csv_rows)}
${metric('withheld/unresolved occurrences', report.withheld_rows)}${metric('safe candidate rows, still requiring claims resolution', report.unique_safe_candidate_rows)}
${metric('input files unchanged (SHA-256 verified)', report.inventory.length)}${metric('network / paid / database-write / claim requests', 0)}</ul>
<p>Occurrences overlap across historical runs and are <strong>not unique artists</strong>.
A header-only safe export means zero eligible candidates. Safe candidates are not approved catalog links.</p>
<h2>Required regression cases</h2>${report.known_cases.map(example => `<section><h3>${html(example.artist)}</h3>
<p>Profile <code>${html(example.profile_id)}</code>; cm_artist <code>${html(example.cm_artist)}</code>. ${html(example.note)}</p>
<p>${example.occurrences.length} archived row occurrences. No known-answer handle is injected into discovery or the safe export.</p>
<details><summary>Original URLs and audit reasons</summary><table><tr><th>Source record</th><th>Raw URLs</th><th>Disposition / reasons</th></tr>
${example.occurrences.map(row => `<tr><td>${html(row.source_file)}<br>Record ${html(row.source_record)}</td>
<td>${row.raw_instagram_urls.map(html).join('<br>')}</td><td>${html(row.disposition)}<br>${row.reasons.map(html).join('<br>')}</td></tr>`).join('')}</table></details></section>`).join('')}
<h2>File inventory</h2><table><tr><th>Original file</th><th>Rows / disposition</th><th>SHA-256</th></tr>
${report.inventory.map(item => `<tr><td>${html(item.file)}</td><td>${html(item.rows ?? 'context')}<br>${html(item.disposition)}
${item.error ? `<br>${html(item.error)}` : ''}</td><td><code>${html(item.sha256_before)}</code></td></tr>`).join('')}</table>
<h2>Limitations and ingestion boundary</h2><ul>${report.limitations.map(value => `<li>${html(value)}</li>`).join('')}</ul>
<p>Identifiers remain exact decimal strings. When opening CSV files in spreadsheet software, explicitly import identifier columns as <strong>text</strong>; automatic numeric conversion can round UInt64 IDs.</p>
<p>The machine-readable audit-report.json, detailed snapshot JSONL, WITHHELD-UNRESOLVED-NOT-FOR-IMPORT.csv and safe-candidates-REQUIRES-CLAIM-RESOLUTION.csv accompany this report.</p>
</html>`;
}

export function auditSnapshot(row, player) {
  const reasons = [];
  let result, matching, exported;
  const rawUrls = split(row.instagram_urls);
  const savedStatus = row.status ?? 'unknown';
  try {
    exactId(row.profile_id); exactId(row.cm_artist);
    if (!player || exactId(player.profile_id) !== exactId(row.profile_id)
      || exactId(player.cm_artist) !== exactId(row.cm_artist)) throw Error('Missing or conflicting profile/catalog identity.');
    for (const id of player.account_ids ?? []) exactId(id);
    for (const account of player.accounts ?? []) {
      exactId(account.account_id);
      if (account.profile_id !== undefined) exactId(account.profile_id);
    }
  } catch (error) { reasons.push(error.message); }
  try {
    if (typeof row.result_json !== 'string') throw Error('Full original result_json unavailable; partial snapshot cannot establish policy provenance.');
    result = parseExactJson(row.result_json);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid saved result object.');
  } catch (error) { reasons.push(error.message); }
  const saved = result?.candidateMatching;
  if (saved?.policy !== MATCHING_POLICY) reasons.push('Missing or unknown saved matching policy.');
  if (result && !reasons.some(reason => /identity|identifier|UInt64/.test(reason))) {
    try {
      matching = assessInstagramCandidates(result, player);
      // Use the actual research export helper as a second, shared export boundary.
      const table = researchExportRows([{ profile_id: row.profile_id, latest: [
        row.cm_artist, player.account_ids ?? [], player.artist, savedStatus, rawUrls,
        row.error ?? '', row.result_json,
      ] }], [player]);
      exported = Object.fromEntries(table[0].map((field, index) => [field, table[1][index]]));
    } catch (error) { reasons.push(error.message); }
  }
  if (saved?.policy === MATCHING_POLICY && matching) {
    if (String(saved.profileId) !== String(row.profile_id) || String(saved.cmArtist) !== String(row.cm_artist)
      || saved.approvedCatalogLinks !== false || saved.noAccountConfirmed !== false
      || saved.status !== matching.status || !Array.isArray(saved.urls) || !sameSet(saved.urls, matching.urls)
      || JSON.stringify(saved.catalogReferences) !== JSON.stringify(matching.catalogReferences)
      || JSON.stringify(saved.candidates) !== JSON.stringify(matching.candidates)) {
      reasons.push('Saved matching assessment is stale, incomplete or identity-conflicting.');
    }
  }
  if (!['candidates_found', 'no_candidates', 'needs_review'].includes(savedStatus)) reasons.push('Incomplete or failed saved discovery.');
  if (matching && (savedStatus !== matching.status || normalized(rawUrls).some(url => !url)
    || !sameSet(normalized(rawUrls), matching.urls))) reasons.push('Saved status/URLs disagree with recomputed evidence.');
  if (!matching?.urls.length) reasons.push('No identity-supported candidate; this does not prove account absence.');
  if (exported && (!sameSet(split(exported.instagram_urls), matching?.urls ?? [])
    || exported.requires_claim_resolution !== true)) reasons.push('Research export did not agree with candidate gate.');
  const disposition = reasons.length ? 'WITHHELD_UNRESOLVED_NOT_FOR_IMPORT' : 'SAFE_CANDIDATE_REQUIRES_CLAIM_RESOLUTION';
  return {
    profile_id: String(row.profile_id ?? ''), cm_artist: String(row.cm_artist ?? ''),
    artist: player?.artist ?? row.artist ?? '', saved_status: savedStatus,
    saved_policy: saved?.policy ?? '', recomputed_policy: matching?.policy ?? '',
    disposition, reasons, raw_instagram_urls: rawUrls,
    supported_instagram_urls: reasons.length ? [] : matching.urls,
    candidate_assessments: matching?.candidates ?? [], requires_claim_resolution: true,
    no_account_confirmed: false, exported: reasons.length ? null : exported,
  };
}

export function auditCsvRow(row, fields) {
  const reasons = [];
  try { exactId(row.profile_id); exactId(row.cm_artist); split(row.account_ids).forEach(exactId); }
  catch (error) { reasons.push(error.message); }
  if (!fields.includes('matching_policy') || row.matching_policy !== MATCHING_POLICY) reasons.push('Missing or unknown CSV matching policy.');
  if (row.requires_claim_resolution !== 'true') reasons.push('Missing claim-resolution boundary.');
  // CSV policy labels alone cannot establish original metadata/JEV evidence.
  reasons.push('CSV is not an evidence archive; do not ingest directly. Use separately audited full snapshots.');
  return {
    profile_id: row.profile_id ?? '', cm_artist: row.cm_artist ?? '', artist: row.artist ?? '',
    saved_status: row.saved_status ?? row.status ?? '', saved_policy: row.matching_policy ?? '',
    disposition: 'WITHHELD_UNRESOLVED_NOT_FOR_IMPORT', reasons,
    raw_instagram_urls: split(row.instagram_urls), supported_instagram_urls: [],
    requires_claim_resolution: true, no_account_confirmed: false,
  };
}

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target); // Never follow symlinks.
  }
  return files.sort();
}
async function digest(file) {
  const handle = await fs.open(file, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function runLegacyAudit({ root = 'generated-artifacts', output }) {
  if (!output || !path.resolve(output).startsWith(path.resolve('generated-artifacts') + path.sep)) {
    throw Error('Choose a new output directory under generated-artifacts.');
  }
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('musician-instagram-')
      && !entry.name.startsWith('musician-instagram-legacy-audit-')) {
      files.push(...await walk(path.join(root, entry.name)));
    }
  }
  const selected = files.filter(file => file.endsWith('.csv') || [
    'accepted.json', 'saved-research.json', 'source-snapshots.json', 'cohort.json',
    'catalog-references.json', 'manifest.json', 'outcomes.json',
  ].includes(path.basename(file)));
  if (!selected.length) throw Error('No legacy musician inputs found.');
  if (selected.some(file => path.resolve(file).startsWith(path.resolve(output) + path.sep))) throw Error('Output overlaps inputs.');
  await fs.mkdir(output, { recursive: false }); // Never overwrite an audit or source directory.
  const inventory = [];
  for (const file of selected.sort()) {
    inventory.push({ file, sha256_before: await digest(file), bytes: (await fs.stat(file)).size });
  }
  const readJson = async file => parseExactJson(await fs.readFile(file, 'utf8'));
  const players = new Map();
  const playerKey = row => `${exactId(row.profile_id)}:${exactId(row.cm_artist)}`;
  const contextIssues = [];
  for (const file of selected.filter(file => path.basename(file) === 'accepted.json')) {
    try {
      for (const player of (await readJson(file)).players ?? []) {
        const key = playerKey(player);
        if (!players.has(key)) players.set(key, player);
      }
    } catch (error) { contextIssues.push({ file, error: error.message }); }
  }
  // Full pilot excerpts bind to their own frozen manifest, never today's catalog.
  const manifests = new Map();
  for (const file of selected.filter(file => path.basename(file) === 'manifest.json')) {
    try {
      manifests.set(path.dirname(file), new Map(((await readJson(file)).artists ?? []).map(player => [playerKey(player), player])));
    } catch (error) { contextIssues.push({ file, error: error.message }); }
  }
  const cohorts = new Map();
  for (const file of selected.filter(file => path.basename(file) === 'cohort.json')) {
    try { for (const player of await readJson(file)) cohorts.set(String(player.profile_id), player); }
    catch (error) { contextIssues.push({ file, error: error.message }); }
  }
  const fields = ['source_file', 'source_record', 'profile_id', 'cm_artist', 'artist', 'saved_status',
    'saved_policy', 'recomputed_policy', 'disposition', 'reasons', 'raw_instagram_urls',
    'supported_instagram_urls', 'requires_claim_resolution', 'no_account_confirmed'];
  const withheldPath = path.join(output, 'WITHHELD-UNRESOLVED-NOT-FOR-IMPORT.csv');
  const details = await fs.open(path.join(output, 'snapshot-assessments-NOT-FOR-IMPORT.jsonl'), 'wx');
  const withheld = await fs.open(withheldPath, 'wx');
  await withheld.write(toCsv([], fields));
  const safe = new Map(), known = new Map(knownCases.map(row => [row.profile_id, { ...row, occurrences: [] }]));
  const totals = { snapshot_rows: 0, csv_rows: 0, withheld_rows: 0, snapshot_supported_rows: 0 };
  const reasonCounts = {};
  const add = async (record, full = false) => {
    if (record.disposition.startsWith('WITHHELD')) {
      totals.withheld_rows++;
      for (const reason of record.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      await withheld.write(toCsv([record], fields).split('\n').slice(1).join('\n'));
    }
    if (full) await details.write(JSON.stringify(record) + '\n');
    const example = known.get(record.profile_id);
    if (example) example.occurrences.push(record);
  };
  try {
    for (const item of inventory) {
      const base = path.basename(item.file);
      if (item.file.endsWith('.csv')) {
        item.kind = 'historical_csv';
        try {
          const { fields: headers, rows } = parseCsv(await fs.readFile(item.file, 'utf8'));
          item.rows = rows.length; item.headers = headers;
          item.disposition = 'QUARANTINED_NOT_FOR_DIRECT_IMPORT';
          item.missing_policy_rows = rows.filter(row => row.matching_policy !== MATCHING_POLICY).length;
          for (let i = 0; i < rows.length; i++) {
            totals.csv_rows++;
            await add({ source_file: item.file, source_record: i + 2, ...auditCsvRow(rows[i], headers) });
          }
        } catch (error) { item.disposition = 'UNREADABLE_WITHHELD'; item.error = error.message; }
      } else if (['saved-research.json', 'source-snapshots.json'].includes(base)) {
        item.kind = base === 'saved-research.json' ? 'partial_saved_research_snapshot' : 'full_result_excerpts';
        try {
          const rows = await readJson(item.file);
          if (!Array.isArray(rows)) throw Error('Snapshot must be an array.');
          item.rows = rows.length; item.withheld_rows = 0;
          for (let i = 0; i < rows.length; i++) {
            const raw = rows[i];
            const cohort = cohorts.get(String(raw.profile_id));
            const row = { ...raw, cm_artist: raw.cm_artist ?? cohort?.cm_artist };
            let key, player;
            try {
              key = playerKey(row);
              player = manifests.get(path.dirname(item.file))?.get(key) ?? players.get(key);
            } catch { /* auditSnapshot records the exact identifier error. */ }
            let result;
            try { result = typeof row.result_json === 'string' ? parseExactJson(row.result_json) : null; } catch {}
            // Excerpts omitted status/URLs: use the frozen manifest, not a new decision.
            const snapshot = { ...row, status: row.status ?? player?.status,
              instagram_urls: row.instagram_urls ?? player?.instagram_urls ?? [],
              artist: row.artist ?? player?.artist ?? cohort?.artist };
            const assessment = auditSnapshot(snapshot, player);
            if (!row.cm_artist) assessment.reasons.push('Partial snapshot omitted cm_artist; identity cannot be reconstructed.');
            if (!result && base === 'saved-research.json') {
              // Preserve projected candidates for inspection only, never reconstruct a full result.
              try {
                const projected = { profiles: parseExactJson(raw.candidates_json || '[]'),
                  methodsUsed: parseExactJson(raw.methods_json || '[]') };
                assessment.candidate_assessments = assessInstagramCandidates(projected, player ?? {}).candidates;
              } catch { assessment.reasons.push('Unreadable projected candidate JSON.'); }
            }
            const record = { source_file: item.file, source_record: i + 1, updated_at: row.updated_at ?? '', ...assessment };
            totals.snapshot_rows++;
            if (assessment.exported) {
              totals.snapshot_supported_rows++;
              const safeKey = `${key}:${assessment.supported_instagram_urls.join('|')}`;
              safe.set(safeKey, { ...assessment.exported, source_file: item.file, source_record: i + 1 });
            } else item.withheld_rows++;
            await add(record, true);
          }
          item.disposition = item.withheld_rows ? 'CONTAINS_WITHHELD_UNRESOLVED_ROWS' : 'AUDITED_CLAIM_CANDIDATES_ONLY';
        } catch (error) { item.disposition = 'UNREADABLE_WITHHELD'; item.error = error.message; }
      } else {
        item.kind = base === 'outcomes.json' ? 'diagnostic_outcomes_not_original_research' : 'frozen_context_only';
        item.disposition = 'NOT_AN_IMPORT_SOURCE';
      }
    }
  } finally { await details.close(); await withheld.close(); }
  const safeFields = ['profile_id', 'cm_artist', 'account_ids', 'artist', 'status', 'instagram_urls',
    'identity_status', 'error', 'saved_status', 'matching_policy', 'requires_claim_resolution', 'source_file', 'source_record'];
  await fs.writeFile(path.join(output, 'safe-candidates-REQUIRES-CLAIM-RESOLUTION.csv'), toCsv([...safe.values()], safeFields), { flag: 'wx' });
  for (const item of inventory) {
    item.sha256_after = await digest(item.file);
    if (item.sha256_after !== item.sha256_before) throw Error(`Source changed during audit: ${item.file}`);
  }
  const cases = [...known.values()];
  const report = {
    kind: 'OFFLINE_LEGACY_QUARANTINE_NOT_AN_IMPORT', generated_at: new Date().toISOString(),
    matching_policy: MATCHING_POLICY, read_only: true, network_requests: 0, paid_provider_calls: 0,
    database_writes: 0, claims_submitted: 0, originals_unchanged: true,
    ...totals, unique_safe_candidate_rows: safe.size, inventory, context_issues: contextIssues,
    reason_counts: reasonCounts, known_cases: cases,
    limitations: [
      'Local archived files only; no assertion about the current database or missing/unavailable exports.',
      'CSV rows are occurrences, not unique artists. Historical runs and snapshots overlap.',
      'Partial saved-research projections omit original result_json and some identifiers/policy evidence; no reconstructed metadata is accepted.',
      'All historical CSVs are withheld as ingestion sources, even when they claim a policy. Full source evidence must be audited separately.',
      'Missing evidence, completed empty searches and user-reported absence never establish no account.',
      'Supported research candidates are not approved catalog links. Eventual live ingestion must use account_links/claims.record and normal resolution.',
      'No files are renamed, removed or edited. Quarantine is an explicit report, not physical deletion or catalog cleanup.',
    ],
  };
  await fs.writeFile(path.join(output, 'audit-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'audit-report.html'), auditHtml(report), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'README.md'), `# Legacy Instagram exports — WITHHELD / UNRESOLVED

This is a local, offline audit, **not an import authorization**.

- Snapshot occurrences checked: ${totals.snapshot_rows}
- CSV row occurrences checked: ${totals.csv_rows}
- Withheld/unresolved occurrences: ${totals.withheld_rows}
- Safe candidate rows: ${safe.size} (still require claims and normal resolution)
- Network/provider/database-write/claim requests: 0
- All ${inventory.length} input file SHA-256 hashes unchanged.

See audit-report.json for the file inventory, hashes, limitations and the Frankelly Bello, Gula Mın 76 and Rooby Jeantal case traces.
WITHHELD-UNRESOLVED-NOT-FOR-IMPORT.csv preserves original URL strings; snapshot-assessments-NOT-FOR-IMPORT.jsonl records the evidence limitations.
safe-candidates-REQUIRES-CLAIM-RESOLUTION.csv contains only policy-consistent, recomputed full-evidence candidates. A header-only file means **zero eligible candidates**, not a failed export or confirmed account absence.

The old files remain untouched and must not be consumed directly. No status command, paid discovery, rerun, catalog write or import ran.
Any eventual live ingestion must use account_links/claims.record and the normal resolver, under separate authorization.
`, { flag: 'wx' });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  if (extra.length) throw Error('Usage: node scripts/src/musician-instagram-legacy-audit.mjs generated-artifacts/musician-instagram-legacy-audit-UNIQUE');
  const report = await runLegacyAudit({ output });
  console.log(JSON.stringify({ output, snapshot_rows: report.snapshot_rows, csv_rows: report.csv_rows,
    withheld_rows: report.withheld_rows, safe_candidate_rows: report.unique_safe_candidate_rows,
    originals_unchanged: report.originals_unchanged, network_requests: 0 }));
}
