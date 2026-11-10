import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildSourcePolicyImpact, digest, IMPACT_SCHEMA, renderSourcePolicyImpact} from './instagram-source-policy-impact.mjs';
import {parseImpactArgs, runSourcePolicyImpact} from './instagram-source-policy-impact-cli.mjs';
import {sealOfflineSnapshot} from './instagram-source-policy-offline.mjs';
import {assessInstagramCandidates} from './musician-instagram-matching.mjs';

const music = 'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const ig = 'https://www.instagram.com/example_artist_/';
const at = '2026-11-09T19:00:00Z';
const settings = {evaluationTime: '2026-11-09T20:00:00Z',
  config: {mode: 'offline', minimumSourceIdentityScore: 0.83, maxEvidenceAgeMs: 86400000, maxVerifierAgeMs: 86400000}};
const hashObject = value => digest(JSON.stringify(value));
function fixture(caseId = 'captured-case-1') {
  const requestBody = JSON.stringify({state: {profileId: '1', candidateUrl: ig, referenceUrl: music}});
  const decision = {verdict: 'verified', sameIdentityProbability: 0.84,
    model: 'synthetic-test-model-not-a-real-call', observedAt: at,
    profileId: '1', accountUrl: ig, requestSha256: digest(requestBody)};
  return {caseId, player: {profile_id: '1', artist: 'Example Artist', account_ids: ['11'],
    accounts: [{account_id: '11', profile_id: '1', platform: 'spotify', account_url: music}]},
  result: {methodsUsed: [{method: 'serper', status: 'used'}],
    profiles: [{url: ig, title: 'Example Artist', ownershipContext: 'artist_account',
      identityComparison: {status: 'likely', reference: {url: music, externalUrls: []},
        candidate: {url: ig, displayName: 'Example Artist', bio: 'Singer', externalUrls: []}},
      jevVerification: structuredClone(decision)}]},
  historicalVerifiers: [{candidateIndex: 0, requestProvenance: 'original_captured',
    requestBody, requestSha256: digest(requestBody), decision, decisionSha256: hashObject(decision)}],
  websiteEvidence: [{profileId: '1', page: sealOfflineSnapshot({
    sourceUrl: 'https://artist.example/', observedAt: at, bodySha256: 'a'.repeat(64),
    links: [{url: music, contextKind: 'artist_specific', contextId: 'artist'},
      {url: ig, contextKind: 'artist_specific', contextId: 'artist'}]}),
  catalogDeclaration: sealOfflineSnapshot({kind: 'catalog_reference_external_links',
    sourceUrl: music, observedAt: at, bodySha256: 'b'.repeat(64), links: ['https://artist.example/']})}]};
}
const input = (...cases) => ({schemaVersion: IMPACT_SCHEMA, cases: cases.length ? cases : [fixture()]});
const run = (cases, config = settings) => buildSourcePolicyImpact(cases ?? input(), config);
function updateDecision(c, edit) {
  edit(c.historicalVerifiers[0].decision);
  const r = c.historicalVerifiers[0];
  r.decisionSha256 = hashObject(r.decision);
  c.result.profiles[0].jevVerification = structuredClone(r.decision);
}
function reseal(c, key, edit) {
  const {packetSha256, ...content} = c.websiteEvidence[0][key];
  edit(content); c.websiteEvidence[0][key] = sealOfflineSnapshot(content);
}

test('batch impact preserves inputs, gate and original request; source facts never enter historical replay', () => {
  const data = input(), before = structuredClone(data);
  const base = assessInstagramCandidates(data.cases[0].result, data.cases[0].player);
  const report = run(data);
  assert.deepEqual(data, before);
  assert.deepEqual(report.cases[0].baseline, base);
  assert.equal(report.pairs[0].change, 'new_simulated_acceptance');
  assert.equal(report.pairs[0].proposed.nonImportable, true);
  assert.equal(report.pairs[0].proposed.productionApproved, false);
  assert.equal(report.counts.newSimulatedAcceptances, 1);
  const replay = report.pairs[0].occurrences[0].replay;
  assert.equal(replay.originalRequestSha256, digest(data.cases[0].historicalVerifiers[0].requestBody));
  assert.equal(replay.sourceFactsSeenByHistoricalModel, 'not_asserted');
  assert.equal(report.cases[0].sourceObservations[0].kind, 'newly_supplied_policy_facts_not_historical_model_input');
  assert.ok(!JSON.stringify(report).includes('"requestBody"'));
});

test('all experimental settings and a valid evaluation time are mandatory even for standard passes', () => {
  for (const edit of [
    s => delete s.evaluationTime, s => s.evaluationTime = '2026-11-09',
    s => s.evaluationTime = '2026-02-30T20:00:00Z', s => s.evaluationTime = '2026-11-09T20:00:00+00:00',
    s => delete s.config, s => s.config.mode = 'live', s => delete s.config.minimumSourceIdentityScore,
    s => s.config.minimumSourceIdentityScore = 1.1, s => s.config.minimumSourceIdentityScore = NaN,
    s => delete s.config.maxVerifierAgeMs, s => s.config.maxEvidenceAgeMs = 0,
    s => s.config.maxVerifierAgeMs = 1.5,
  ]) { const s = structuredClone(settings); edit(s); assert.throws(() => run(input(), s)); }
});

test('hashes and original artist/account/request/decision bindings fail closed', () => {
  for (const edit of [
    c => c.historicalVerifiers = [],
    c => c.historicalVerifiers.push(structuredClone(c.historicalVerifiers[0])),
    c => c.historicalVerifiers[0].requestBody += ' ',
    c => c.historicalVerifiers[0].decisionSha256 = 'd'.repeat(64),
    c => c.result.profiles[0].jevVerification.sameIdentityProbability = 0.99,
    c => updateDecision(c, d => d.profileId = '2'),
    c => updateDecision(c, d => d.accountUrl = 'https://www.instagram.com/another/'),
    c => updateDecision(c, d => d.requestSha256 = 'd'.repeat(64)),
    c => updateDecision(c, d => delete d.model),
    c => c.historicalVerifiers[0].requestProvenance = 'current_reconstruction',
    c => delete c.historicalVerifiers[0].requestProvenance,
    c => c.historicalVerifiers[0].candidateIndex = 10,
  ]) { const c = fixture(); edit(c); assert.throws(() => run(input(c))); }
});

test('grading labels cannot enter the evidence path, even nested in captured request JSON', () => {
  for (const location of ['player', 'result', 'websiteEvidence']) {
    const c = fixture(); c[location].expectedArtistOwned = true;
    // Arrays cannot acquire extra JSON fields in the file format; test nested observation instead.
    if (location === 'websiteEvidence') c.websiteEvidence[0].expectedArtistOwned = true;
    assert.throws(() => run(input(c)), /Grading field/);
  }
  const c = fixture(), record = c.historicalVerifiers[0];
  record.requestBody = JSON.stringify({state: {expectedArtistOwned: true}});
  record.requestSha256 = digest(record.requestBody);
  updateDecision(c, d => d.requestSha256 = record.requestSha256);
  assert.throws(() => run(input(c)), /Grading field/);
  assert.throws(() => run({...input(), grading: [{expected: true}]}), /Unknown input field/);
});

test('missing trust stays missing; no declaration is synthesized from a page, artist name or ownership context', () => {
  const c = fixture(); delete c.websiteEvidence[0].catalogDeclaration;
  const report = run(input(c)), row = report.pairs[0].occurrences[0];
  assert.equal(row.proposed.accepted, false);
  assert.equal(row.proof.missingTrustDeclaration, true);
  assert.equal(report.cases[0].sourceObservations[0].catalogDeclaration.missing, true);
  assert.equal(row.proposed.reason, 'independent_trust_or_same_context_exact_links_missing');
});

test('stale, future, missing-time and tampered source proofs have explicit diagnostics', () => {
  for (const [stamp, expected] of [['2026-11-01T00:00:00Z', 'stale'],
    ['2026-11-10T00:00:00Z', 'future'], [null, 'missing_or_invalid']]) {
    const c = fixture(); reseal(c, 'page', p => p.observedAt = stamp);
    const report = run(input(c));
    assert.equal(report.cases[0].sourceObservations[0].page.freshness, expected);
    assert.equal(report.pairs[0].proposed.accepted, false);
  }
  const c = fixture(); c.websiteEvidence[0].page.links[0].url = music + 'X';
  const report = run(input(c));
  assert.equal(report.cases[0].sourceObservations[0].page.packetHashValid, false);
  assert.equal(report.pairs[0].proposed.accepted, false);
});

test('stale historical model is distinct from fresh newly supplied proof', () => {
  const c = fixture(); updateDecision(c, d => d.observedAt = '2026-11-01T00:00:00Z');
  const report = run(input(c));
  assert.equal(report.pairs[0].occurrences[0].replay.freshness, 'stale');
  assert.equal(report.cases[0].sourceObservations[0].page.freshness, 'fresh');
  assert.equal(report.pairs[0].proposed.accepted, false);
});

test('unchanged baseline can pass while stricter experimental ownership/conflict checks hold', () => {
  const c = fixture();
  c.result.profiles[0].identityComparison.candidate.externalUrls = [music];
  updateDecision(c, d => d.sameIdentityProbability = 0.95);
  c.result.profiles[0].ownershipContext = 'unknown';
  const report = run(input(c));
  assert.equal(report.cases[0].baseline.candidates[0].status, 'supported');
  assert.equal(report.pairs[0].change, 'new_simulated_hold');
  assert.equal(report.pairs[0].proposed.reasons[0], 'ownership_context_not_established');
});

test('repeated cases are not counted as distinct artists/accounts; contradictory repeats are retained', () => {
  const a = fixture('repeat-a'), b = fixture('repeat-b');
  b.result.profiles[0].contradictions = ['Different documented owner'];
  const report = run(input(a, b));
  assert.equal(report.counts.cases, 2);
  assert.equal(report.counts.distinctArtists, 1);
  assert.equal(report.counts.distinctAccounts, 1);
  assert.equal(report.counts.distinctPairs, 1);
  assert.equal(report.counts.repeatedOccurrences, 1);
  assert.equal(report.pairs[0].proposed.repeatedDecisionConflict, true);
  assert.equal(report.pairs[0].proposed.accepted, false);
  assert.equal(report.pairs[0].occurrences[0].proposed.accepted, true);
  assert.equal(report.pairs[0].occurrences[1].conflicts.contradictions.length, 1);
});

test('within-result duplicate disagreement preserves current gate final acceptance, not just candidate statuses', () => {
  const c = fixture();
  c.result.profiles[0].identityComparison.candidate.externalUrls = [music];
  updateDecision(c, d => d.sameIdentityProbability = 0.95);
  const other = structuredClone(c.result.profiles[0]); other.identityComparison.status = 'mismatch';
  c.result.profiles.push(other);
  c.historicalVerifiers.push({...structuredClone(c.historicalVerifiers[0]), candidateIndex: 1});
  const report = run(input(c)), rows = report.pairs[0].occurrences;
  assert.equal(rows[0].baseline.status, 'supported');
  assert.equal(rows[0].baseline.accepted, false);
  assert.equal(rows[0].proposed.reason, 'conflicting_duplicate_occurrence');
  assert.equal(report.pairs[0].proposed.accepted, false);
});

test('shared accounts across distinct artists are visible without claiming to resolve ownership', () => {
  const a = fixture('artist-a'), b = fixture('artist-b');
  b.player.profile_id = '2'; b.player.accounts[0].profile_id = '2';
  b.websiteEvidence[0].profileId = '2';
  updateDecision(b, d => d.profileId = '2');
  const report = run(input(a, b));
  assert.equal(report.counts.distinctArtists, 2);
  assert.equal(report.counts.distinctAccounts, 1);
  assert.equal(report.counts.distinctPairs, 2);
  assert.equal(report.counts.sharedAccounts, 1);
  assert.deepEqual(report.sharedAccounts[0].profileIds, ['1', '2']);
});

test('missing verifier, empty candidates, failed discovery and invalid accounts are not absence or silent omissions', () => {
  const noVerifier = fixture('no-verifier');
  delete noVerifier.result.profiles[0].jevVerification; noVerifier.historicalVerifiers = [];
  const empty = fixture('empty'); empty.result.profiles = []; empty.historicalVerifiers = [];
  const failed = fixture('failed'); failed.result.methodsUsed = [];
  const invalid = fixture('invalid'); invalid.result.profiles[0].url = 'https://www.instagram.com/p/post/';
  delete invalid.result.profiles[0].jevVerification; invalid.historicalVerifiers = [];
  const report = run(input(noVerifier, empty, failed, invalid));
  assert.equal(report.counts.emptyCases, 1);
  assert.equal(report.counts.blockedCases, 1);
  assert.equal(report.counts.invalidAccountOccurrences, 1);
  assert.equal(report.counts.candidateOccurrences, 3);
  assert.equal(report.cases[1].baseline.status, 'no_candidates');
  assert.equal(report.cases[2].baseline.status, 'blocked');
  assert.equal(report.noAccountConfirmed, false);
  assert.equal(report.pairs[0].occurrences[0].proof.verifierMissing, true);
});

test('explicit higher floor changes only simulated source route; inclusive freshness boundary works', () => {
  const s = structuredClone(settings); s.config.minimumSourceIdentityScore = 0.85;
  const a = run(), b = run(input(), s);
  assert.deepEqual(a.cases[0].baseline, b.cases[0].baseline);
  assert.equal(b.pairs[0].proposed.accepted, false);
  s.config.minimumSourceIdentityScore = 0.84;
  s.config.maxEvidenceAgeMs = s.config.maxVerifierAgeMs = 3600000;
  assert.equal(run(input(), s).pairs[0].proposed.accepted, true);
  s.config.maxEvidenceAgeMs -= 1;
  assert.equal(run(input(), s).pairs[0].proposed.accepted, false);
});

test('Markdown includes every case, hashes, stale/missing proof, warning and repeated-case reasons', () => {
  const c = fixture(), report = run(input(c)), markdown = renderSourcePolicyImpact(report);
  for (const text of ['NON-IMPORTABLE', 'PRODUCTION-UNAPPROVED', 'not verifier accuracy',
    'historical_model_replay', 'originalRequestSha256', 'bodySha256', 'missingTrustDeclaration',
    c.historicalVerifiers[0].requestSha256, 'Repeated decision conflict', 'originalResultSha256']) {
    assert.ok(markdown.includes(text), text);
  }
});

const argsFor = (file, output) => ['--input', file, '--output', output,
  '--evaluation-time', settings.evaluationTime, '--minimum-source-identity-score', '0.83',
  '--max-evidence-age-ms', '86400000', '--max-verifier-age-ms', '86400000'];
test('CLI rejects omitted, unknown, live, duplicate, traversal and malformed settings', () => {
  const args = argsFor('local.json', 'new-run');
  for (const bad of [[], args.slice(0, -2), [...args, '--live', 'true'],
    [...args, '--input', 'second.json'], args.map(v => v === 'new-run' ? '../escape' : v),
    args.map(v => v === '0.83' ? 'Infinity' : v), args.map(v => v === '86400000' ? '' : v)]) {
    assert.throws(() => parseImpactArgs(bad));
  }
});

test('CLI emits exclusive ignored outputs, exact input hash, no raw requests and refuses overwrite/symlink', async () => {
  const root = fileURLToPath(new URL('../../generated-artifacts/', import.meta.url));
  await fs.mkdir(root, {recursive: true});
  const name = `contract-test-${randomUUID()}`;
  const source = path.join(root, `${name}.json`);
  const parent = path.join(root, 'instagram-source-policy-impact');
  const output = path.join(parent, name), link = path.join(parent, `${name}-link`);
  const bytes = JSON.stringify(input());
  await fs.writeFile(source, bytes, {flag: 'wx'});
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network allowed'); };
  try {
    const done = await runSourcePolicyImpact(argsFor(source, name));
    assert.equal(done.output, output);
    const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(report.inputFileSha256, digest(bytes));
    assert.equal(report.providerRequests, 0);
    assert.equal(report.databaseWrites, 0);
    assert.equal(report.defaultPolicyChanged, false);
    assert.deepEqual((await fs.readdir(output)).sort(), ['report.json', 'report.md']);
    const before = await fs.readFile(path.join(output, 'report.json'), 'utf8');
    await assert.rejects(runSourcePolicyImpact(argsFor(source, name)), {code: 'EEXIST'});
    assert.equal(await fs.readFile(path.join(output, 'report.json'), 'utf8'), before);
    await fs.symlink(output, link);
    await assert.rejects(runSourcePolicyImpact(argsFor(source, `${name}-link`)), {code: 'EEXIST'});
    assert.equal(await fs.readFile(source, 'utf8'), bytes);
  } finally {
    globalThis.fetch = savedFetch;
    await fs.rm(link, {force: true});
    await fs.rm(output, {recursive: true, force: true});
    await fs.rm(source, {force: true});
  }
});

test('offline dependency graph contains only allowlisted pure modules and Node local-file/hash builtins', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const modules = ['instagram-source-policy-impact.mjs', 'instagram-source-policy-impact-cli.mjs',
    'instagram-source-policy-offline.mjs', 'musician-instagram-matching.mjs'];
  for (const name of modules) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    for (const [, specifier] of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(['node:crypto', 'node:fs/promises', 'node:path', 'node:url',
        ...modules.map(m => `./${m}`)].includes(specifier), specifier);
    }
    assert.doesNotMatch(text, /process\.env|fetch\s*\(|https?\.request|import\s*\(/);
  }
});
