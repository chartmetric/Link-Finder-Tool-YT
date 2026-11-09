import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assessInstagramCandidates, MATCHING_POLICY } from './musician-instagram-matching.mjs';
import { auditSnapshot, auditCsvRow, auditHtml, exactId, parseExactJson, parseCsv, toCsv, runLegacyAudit } from './musician-instagram-legacy-audit.mjs';

const url = 'https://www.instagram.com/example_artist_/';
const spotify = 'https://open.spotify.com/artist/1234567890123456789012';
const player = { profile_id: '18446744073709551615', cm_artist: '9007199254740993',
  artist: 'Example Artist', account_ids: ['9007199254740995'], accounts: [{
    account_id: '9007199254740995', platform: 'spotify', account_url: spotify,
  }] };
function fixture() {
  const result = { methodsUsed: [{ method: 'serper', status: 'used' }], profiles: [{
    url, title: 'Example Artist', identityComparison: { status: 'likely',
      reference: { url: spotify, bio: url }, candidate: { url, displayName: 'Example Artist' } },
    jevVerification: { verdict: 'verified', sameIdentityProbability: 0.95 },
  }] };
  result.candidateMatching = assessInstagramCandidates(result, player);
  return { ...player, status: 'candidates_found', instagram_urls: [url], result_json: JSON.stringify(result) };
}

test('integer tokens, nested JSON and CSV preserve UInt64 precision and original strings', () => {
  assert.equal(parseExactJson('{"id":18446744073709551615,"small":2,"score":0.95}').id, player.profile_id);
  assert.equal(parseExactJson('{"id":18446744073709551615,"small":2,"score":0.95}').small, 2);
  assert.equal(parseExactJson('"text \\" 18446744073709551615"'), 'text " 18446744073709551615');
  assert.throws(() => exactId(Number(player.profile_id)), /Unsafe/);
  assert.throws(() => exactId('18446744073709551616'), /UInt64/);
  const rows = [{ profile_id: player.profile_id, artist: 'Gula Mın 76,\n"quoted"', url: `${url}?hl=en` }];
  assert.deepEqual(parseCsv(toCsv(rows, Object.keys(rows[0]))).rows, rows);
  for (const text of ['a,a\n1,2', 'a,b\n"unclosed', 'a,b\n1', 'a\n"x"oops']) assert.throws(() => parseCsv(text));
});

test('only a saved policy with reproducible raw identity evidence reaches the claim-only safe export', () => {
  const row = fixture(), before = JSON.stringify(row);
  const assessment = auditSnapshot(row, player);
  assert.equal(assessment.disposition, 'SAFE_CANDIDATE_REQUIRES_CLAIM_RESOLUTION');
  assert.equal(assessment.exported.profile_id, player.profile_id);
  assert.equal(assessment.exported.cm_artist, player.cm_artist);
  assert.equal(assessment.exported.account_ids, player.account_ids[0]);
  assert.equal(assessment.exported.requires_claim_resolution, true);
  assert.deepEqual(assessment.supported_instagram_urls, [url]);
  assert.equal(JSON.stringify(row), before);
});

test('forged policy labels, stale URLs, mismatches, invalid JSON and incomplete work are withheld', () => {
  const alterations = [
    row => { const raw = JSON.parse(row.result_json); delete raw.candidateMatching; row.result_json = JSON.stringify(raw); },
    row => { const raw = JSON.parse(row.result_json); raw.candidateMatching.policy = 'unknown'; row.result_json = JSON.stringify(raw); },
    row => { const raw = JSON.parse(row.result_json); delete raw.profiles[0].jevVerification; row.result_json = JSON.stringify(raw); },
    row => { const raw = JSON.parse(row.result_json); raw.candidateMatching.profileId = '1'; row.result_json = JSON.stringify(raw); },
    row => { const raw = JSON.parse(row.result_json); raw.profiles.push({ ...raw.profiles[0], jevVerification: { verdict: 'mismatch' } }); row.result_json = JSON.stringify(raw); },
    row => { row.instagram_urls = ['https://instagram.com/wrong/']; },
    row => { row.status = 'running'; },
    row => { row.result_json = '{bad'; },
    row => { delete row.result_json; row.candidates_json = '[]'; },
    row => { row.profile_id = Number(row.profile_id); },
    row => { row.cm_artist = '123'; },
  ];
  for (const alter of alterations) {
    const row = fixture(); alter(row);
    const result = auditSnapshot(row, player);
    assert.match(result.disposition, /^WITHHELD/);
    assert.deepEqual(result.supported_instagram_urls, []);
    assert.equal(result.exported, null);
  }
});

test('empty discovery, missing references and failed discovery never establish account absence', () => {
  for (const result of [{ profiles: [], methodsUsed: [{ method: 'serper', status: 'used' }] },
    { profiles: [], methodsUsed: [{ method: 'serper', status: 'failed' }] }]) {
    const report = auditSnapshot({ ...fixture(), status: 'no_candidates', instagram_urls: [],
      result_json: JSON.stringify(result) }, player);
    assert.equal(report.no_account_confirmed, false);
    assert.equal(report.exported, null);
  }
  assert.equal(auditSnapshot(fixture(), { ...player, accounts: [] }).exported, null);
});

test('all historical CSVs stay quarantined, even with a forged current policy', () => {
  const row = { profile_id: player.profile_id, cm_artist: player.cm_artist, artist: 'Example Artist',
    instagram_urls: `${url}?hl=en`, matching_policy: MATCHING_POLICY, requires_claim_resolution: 'true' };
  const report = auditCsvRow(row, Object.keys(row));
  assert.match(report.disposition, /^WITHHELD/);
  assert.deepEqual(report.raw_instagram_urls, [`${url}?hl=en`]);
  assert.deepEqual(report.supported_instagram_urls, []);
});

test('saved Frankelly, Gula and Rooby excerpts remain withheld with their original handles', async () => {
  const examples = JSON.parse(await fs.readFile(new URL('./fixtures/musician-instagram-matching-examples.json', import.meta.url), 'utf8'));
  for (const example of examples) {
    const row = { ...example.player, status: 'candidates_found', instagram_urls: example.profiles.map(p => p.url),
      result_json: JSON.stringify({ profiles: example.profiles, methodsUsed: [{ method: 'serper', status: 'used' }] }) };
    const report = auditSnapshot(row, example.player);
    assert.match(report.disposition, /^WITHHELD/);
    assert.deepEqual(report.raw_instagram_urls, row.instagram_urls);
    assert.equal(report.saved_policy, '');
    assert.equal(report.recomputed_policy, MATCHING_POLICY);
    assert.equal(report.no_account_confirmed, false);
    if (example.userSuppliedUrl) assert.ok(!report.raw_instagram_urls.includes(example.userSuppliedUrl));
  }
});

test('complete offline audit inventories stale files, does not overwrite inputs, and exports header-only on zero candidates', async () => {
  await fs.mkdir('generated-artifacts', { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-audit-input-'));
  const parent = await fs.mkdtemp('generated-artifacts/musician-instagram-legacy-audit-test-');
  const directory = path.join(root, 'musician-instagram-fixture');
  await fs.mkdir(directory);
  const raw = fixture();
  const broken = { ...raw, result_json: '{}' };
  await fs.writeFile(path.join(directory, 'accepted.json'), JSON.stringify({ players: [player] }));
  await fs.writeFile(path.join(directory, 'source-snapshots.json'), JSON.stringify([broken]));
  await fs.writeFile(path.join(directory, 'stale.csv'), toCsv([{
    profile_id: player.profile_id, cm_artist: player.cm_artist, status: 'candidates_found', instagram_urls: url,
  }], ['profile_id', 'cm_artist', 'status', 'instagram_urls']));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Network forbidden'); };
  try {
    const report = await runLegacyAudit({ root, output: path.join(parent, 'held') });
    assert.equal(report.snapshot_rows, 1);
    assert.equal(report.csv_rows, 1);
    assert.equal(report.withheld_rows, 2);
    assert.equal(report.unique_safe_candidate_rows, 0);
    assert.equal(report.known_cases.length, 3);
    assert.ok(report.inventory.every(item => item.sha256_before === item.sha256_after));
    const rendered = await fs.readFile(path.join(parent, 'held', 'audit-report.html'), 'utf8');
    assert.match(rendered, /Frankelly Bello/);
    assert.match(rendered, /Gula Mın 76/);
    assert.match(rendered, /Rooby Jeantal/);
    assert.match(rendered, /Not an import authorization/);
    const malicious = structuredClone(report);
    malicious.known_cases[0].artist = '<script>alert("x")</script>';
    assert.ok(!auditHtml(malicious).includes('<script>'));
    assert.equal(parseCsv(await fs.readFile(path.join(parent, 'held', 'safe-candidates-REQUIRES-CLAIM-RESOLUTION.csv'), 'utf8')).rows.length, 0);
    await assert.rejects(runLegacyAudit({ root, output: path.join(parent, 'held') }), /EEXIST/);
    await fs.writeFile(path.join(directory, 'source-snapshots.json'), JSON.stringify([raw]));
    const positive = await runLegacyAudit({ root, output: path.join(parent, 'supported') });
    assert.equal(positive.unique_safe_candidate_rows, 1);
    const safe = parseCsv(await fs.readFile(path.join(parent, 'supported', 'safe-candidates-REQUIRES-CLAIM-RESOLUTION.csv'), 'utf8')).rows;
    assert.equal(safe[0].profile_id, player.profile_id);
    assert.equal(safe[0].requires_claim_resolution, 'true');
  } finally {
    globalThis.fetch = fetchBefore;
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  }
});
