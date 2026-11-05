import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessInstagramCandidates, instagramProfileUrl, instagramSearchRequest, catalogReferences, MATCHING_POLICY } from './musician-instagram-matching.mjs';
import { processQueue, initialState, researchExportRows } from './musician-instagram-research.mjs';

const spotify = 'https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';
const url = 'https://www.instagram.com/example.artist/';
const player = { profile_id: '123', cm_artist: '456', artist: 'Example Artist', account_ids: ['789'],
  accounts: [{ profile_id: '123', account_id: '789', platform: 'spotify', account_url: spotify }] };
const result = profiles => ({ profiles, methodsUsed: [{ method: 'serper', status: 'used' }] });
const supported = () => ({
  url, title: 'Example Artist', confidence: 99,
  identityComparison: {
    status: 'likely', score: 95,
    reference: { url: spotify, displayName: 'Example Artist', bio: `Official Instagram: ${url}` },
    candidate: { url, displayName: 'Example Artist', bio: 'Musician' },
  },
  jevVerification: { verdict: 'verified', sameIdentityProbability: 0.99 },
});
const examples = JSON.parse(readFileSync(new URL('./fixtures/musician-instagram-matching-examples.json', import.meta.url)));

for (const example of examples) {
  test(`saved regression: ${example.player.artist} raw search hits never become artist-owned URLs`, async () => {
    const raw = result(example.profiles);
    const before = JSON.stringify(raw);
    const assessment = assessInstagramCandidates(raw, example.player);
    assert.deepEqual(assessment.urls, []);
    assert.equal(assessment.status, 'needs_review');
    assert.equal(assessment.noAccountConfirmed, false);
    assert.equal(JSON.stringify(raw), before, 'raw provider evidence must remain unchanged');
    assert.equal(assessment.candidates.length, example.profiles.length);
    const saved = [];
    await processQueue({ players: [example.player], workers: 1, search: async () => raw,
      save: async (p, status, output, urls) => saved.push({ status, output, urls }) });
    const final = saved.at(-1);
    assert.equal(final.status, 'needs_review');
    assert.deepEqual(final.urls, []);
    assert.deepEqual(final.output.profiles, raw.profiles);
    assert.equal(final.output.candidateMatching.policy, MATCHING_POLICY);
    assert.equal(final.output.candidateMatching.approvedCatalogLinks, false);
    if (example.userSuppliedUrl) {
      assert.ok(!final.output.profiles.some(profile => profile.url === example.userSuppliedUrl),
        'a supplied answer must never be injected into blind discovery');
    }
  });
}

test('exact artist name, confidence 99, and an official title are insufficient without identity evidence', () => {
  const assessment = assessInstagramCandidates(result([{ url, title: 'Example Artist official', confidence: 99,
    signals: ['Name matches', 'Marked official', 'Top Google result'] }]), player);
  assert.deepEqual(assessment.urls, []);
  assert.equal(assessment.status, 'needs_review');
});

test('only a verified, catalog-bound comparison with an exact cross-link supports a candidate', () => {
  const assessment = assessInstagramCandidates(result([supported()]), player);
  assert.deepEqual(assessment.urls, [url]);
  assert.equal(assessment.status, 'candidates_found');
  assert.equal(assessment.profileId, player.profile_id);
  assert.equal(assessment.cmArtist, player.cm_artist);
  assert.equal(assessment.approvedCatalogLinks, false);
});

test('wrong reference, wrong candidate metadata, missing cross-link and inconclusive verification fail closed', () => {
  for (const change of [
    p => { p.identityComparison.reference.url = `${spotify}X`; },
    p => { p.identityComparison.candidate.url = 'https://www.instagram.com/another_artist/'; },
    p => { p.identityComparison.reference.bio = 'Example Artist'; },
    p => { p.jevVerification.verdict = 'likely'; },
    p => { p.jevVerification.sameIdentityProbability = 0.89; },
    p => { p.jevVerification.sameIdentityProbability = 99; },
    p => { delete p.jevVerification; },
  ]) {
    const profile = supported();
    change(profile);
    assert.deepEqual(assessInstagramCandidates(result([profile]), player).urls, []);
  }
});

test('cross-links compare exact account identities, not handle prefixes or another Spotify artist ID', () => {
  const profile = supported();
  profile.identityComparison.reference.bio = `${url}extra`;
  assert.deepEqual(assessInstagramCandidates(result([profile]), player).urls, []);
  profile.identityComparison.reference.bio = '';
  profile.identityComparison.candidate.bio = `${spotify}X`;
  assert.deepEqual(assessInstagramCandidates(result([profile]), player).urls, []);
  profile.identityComparison.candidate.bio = `${spotify}?si=tracking`;
  assert.deepEqual(assessInstagramCandidates(result([profile]), player).urls, [url]);
});

test('associated label and festival accounts are not artist-owned accounts even with a cross-link', () => {
  for (const bio of ['Official record label', 'Festival updates', 'Fan account']) {
    const profile = supported();
    profile.identityComparison.candidate.bio = bio;
    assert.deepEqual(assessInstagramCandidates(result([profile]), player).urls, []);
  }
});

test('explicit mismatches and duplicate contradictory assessments cannot be promoted', () => {
  for (const method of ['identityComparison', 'jevVerification']) {
    const mismatch = supported();
    if (method === 'identityComparison') mismatch[method].status = 'mismatch';
    else mismatch[method].verdict = 'mismatch';
    const assessment = assessInstagramCandidates(result([supported(), mismatch]), player);
    assert.deepEqual(assessment.urls, []);
    assert.equal(assessment.status, 'needs_review');
  }
});

test('normalization strips locale parameters but preserves significant handle underscores', () => {
  assert.equal(instagramProfileUrl('https://www.instagram.com/Frankellybello_/?hl=en'), 'https://www.instagram.com/frankellybello_/');
  assert.notEqual(instagramProfileUrl('https://www.instagram.com/frankellybello/'), instagramProfileUrl('https://www.instagram.com/frankellybello_/'));
  for (const value of ['https://user:pass@instagram.com/artist/', 'https://instagram.com/p/123/',
    'https://instagram.com:444/artist/', 'https://evil.example/artist/', 'https://instagram.com/artist%2fother/']) {
    assert.equal(instagramProfileUrl(value), null);
  }
});

test('new requests use a trusted active linked account and always require Serper', () => {
  assert.deepEqual(instagramSearchRequest(player), { knownProfileUrl: spotify, targetPlatforms: ['instagram'], methods: ['serper'] });
  for (const account of [
    { ...player.accounts[0], profile_id: 'another-profile' },
    { ...player.accounts[0], account_id: 'unlinked-id' },
    { ...player.accounts[0], disconnected_at: '2026-01-01' },
    { ...player.accounts[0], account_url: 'https://evil.example/artist/123' },
  ]) {
    const other = { ...player, accounts: [account] };
    assert.deepEqual(catalogReferences(other), []);
    assert.equal(instagramSearchRequest(other).subject, 'Example Artist, musician');
    assert.deepEqual(instagramSearchRequest(other).methods, ['serper']);
  }
});

test('old candidate results are reassessed locally, never automatically replayed or blindly reused', () => {
  const raw = result([{ url, title: 'Example Artist official', confidence: 99 }]);
  const previous = { latest: ['candidates_found', [url], JSON.stringify(raw), '', 'old-run', 'date', player.cm_artist] };
  const state = initialState(player, previous);
  assert.equal(state.status, 'needs_review');
  assert.deepEqual(state.urls, []);
  assert.equal(state.result.reusedFromRunId, 'old-run');
  assert.equal(state.result.estimatedCostUsd, 0);
  assert.deepEqual(state.result.profiles, raw.profiles);
});

test('empty completed discovery is no-candidates, not confirmed account absence; provider failures remain errors', () => {
  const empty = assessInstagramCandidates(result([]), player);
  assert.equal(empty.status, 'no_candidates');
  assert.equal(empty.noAccountConfirmed, false);
  assert.throws(() => assessInstagramCandidates({ profiles: [], methodsUsed: [{ method: 'serper', status: 'failed' }] }, player), /Serper/);
  assert.throws(() => assessInstagramCandidates({ methodsUsed: [{ method: 'serper', status: 'used' }] }, player), /candidate list/);
});

test('CSV export reassesses historical rows instead of exposing old raw URLs as importable links', () => {
  for (const example of examples) {
    const raw = result(example.profiles);
    const rows = researchExportRows([{ profile_id: example.player.profile_id, latest: [
      example.player.cm_artist, [], example.player.artist, 'candidates_found', example.profiles.map(profile => profile.url), '', JSON.stringify(raw),
    ] }], [example.player]);
    assert.equal(rows[1][4], 'needs_review');
    assert.equal(rows[1][5], '');
    assert.equal(rows[1][8], 'candidates_found', 'retain saved status without rewriting historical rows');
    assert.equal(rows[1][9], MATCHING_POLICY);
    assert.equal(rows[1][10], true);
  }
});

test('CSV export keeps supported URLs claim-only and fails closed for missing identities or invalid evidence', () => {
  const row = { profile_id: player.profile_id, latest: [player.cm_artist, player.account_ids,
    player.artist, 'candidates_found', [url], '', JSON.stringify(result([supported()]))] };
  const supportedCsv = researchExportRows([row], [player])[1];
  assert.equal(supportedCsv[5], url);
  assert.equal(supportedCsv[6], 'identity_supported_candidates_not_claim_resolved');
  for (const players of [[], [{ ...player, cm_artist: 'other' }], [{ ...player, accounts: [] }]]) {
    assert.equal(researchExportRows([row], players)[1][5], '');
  }
  row.latest[6] = '{}';
  assert.equal(researchExportRows([row], [player])[1][5], '');
});
