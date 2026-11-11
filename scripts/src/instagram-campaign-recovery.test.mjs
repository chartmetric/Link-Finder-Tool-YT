import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest} from './instagram-next-saved-batch.mjs';
import {partitionCampaignEligibility, reconcileCampaignArchive, buildCampaignRecoveryPlan,
  claimPreparedCampaignRecovery, assertRecoveryFiles} from './instagram-campaign-recovery.mjs';

const artists = Array.from({length: 500}, (_, i) =>
  ({profile_id: String(i + 1), cm_artist: String(i + 1001), tier: 3}));
const live = a => ({...a, has_instagram: 0});

test('seven missing tier rows defer seven, retaining all 493 eligible identities in frozen order', () => {
  const {eligible, deferred} = partitionCampaignEligibility(artists, artists.slice(7).reverse().map(live));
  assert.deepEqual(eligible.map(r => r.profile_id), artists.slice(7).map(r => r.profile_id));
  assert.equal(deferred.length, 7);
  assert.ok(deferred.every(r => r.outcome === 'deferred_not_searched'
    && r.reason === 'missing_current_tier_or_profile'));
  assert.deepEqual(partitionCampaignEligibility(artists, []), {eligible: [],
    deferred: artists.map(a => ({profileId: a.profile_id, cmArtist: a.cm_artist,
      frozenTier: 3, reason: 'missing_current_tier_or_profile',
      outcome: 'deferred_not_searched', currentEvidence: null}))});
});

test('new catalog links, changed identities and outside tiers are never passed to paid scope', () => {
  const result = partitionCampaignEligibility(artists.slice(0, 4), [
    {...live(artists[0]), has_instagram: 1}, {...live(artists[1]), cm_artist: 'other'},
    {...live(artists[2]), tier: 6}, live(artists[3])]);
  assert.deepEqual(result.eligible.map(r => r.profile_id), ['4']);
  assert.deepEqual(result.deferred.map(r => r.reason),
    ['catalog_instagram_now_present', 'catalog_identity_changed', 'outside_current_tiers']);
  for (const bad of [[live(artists[0]), live(artists[0])], [{...live(artists[0]), profile_id: 'foreign'}],
    [{...live(artists[0]), has_instagram: 2}], [{...live(artists[0]), tier: 'bad'}]])
    assert.throws(() => partitionCampaignEligibility(artists, bad));
});

function archiveFixture() {
  const request = {kind: 'scrapecreators_candidate', body: {url: 'https://www.instagram.com/artist/'}};
  request.sha256 = digest(request.body);
  const scope = {authorization: {budgetId: 'campaign-chunk-001', maxSpendCents: 2000}};
  return {scope, journal: [{phase: 'admitted', key: 'key', profileId: '1', reservedCents: 2, request},
    {phase: 'returned', key: 'key'}],
    packets: {key: {status: 200, requestedUrl: request.body.url}},
    budget: {id: scope.authorization.budgetId, scope_sha256: digest(scope), cap_cents: 2, reserved_cents: 2},
    admissions: [{admission_key: 'key', profile_id: '1', cents: 2}]};
}
test('exact archived calls reconcile without resetting reservations or requiring fresh metadata', () => {
  assert.deepEqual(reconcileCampaignArchive(archiveFixture()), {admissions: 1, reservedCents: 2, profileIds: ['1']});
  const f = archiveFixture();
  f.journal[1].phase = 'stopped_no_retry';
  f.packets.key.status = 404;
  f.packets.key.data = {success: true, error: 'not_found', errorStatus: 404,
    message: 'Profile is restricted', handle: 'artist'};
  assert.equal(reconcileCampaignArchive(f).admissions, 1);
});
test('uncertainty, ledger disagreement, changed receipts and unretired budgets fail closed', () => {
  const changes = [
    f => { delete f.packets.key; }, f => { f.admissions = []; },
    f => { f.admissions[0].profile_id = '2'; }, f => { f.budget.reserved_cents = 0; },
    f => { f.budget.cap_cents = 2000; }, f => { f.journal.pop(); },
    f => { f.journal.push(f.journal[0]); }, f => { f.packets.key.requestedUrl += 'other'; },
    f => { f.journal[0].request.sha256 = 'changed'; },
    f => { f.budget.scope_sha256 = 'changed'; },
    ...[401, 402, 403, 429].map(status => f => { f.packets.key.status = status; }),
  ];
  for (const change of changes) {
    const f = archiveFixture(); change(f);
    assert.throws(() => reconcileCampaignArchive(f));
  }
});
test('model receipts bind to the exact saved request, and acknowledged server errors are not retried', () => {
  const f = archiveFixture();
  f.journal[0].request.kind = 'jev';
  f.packets.key = {status: 500, requestBodySha256: f.journal[0].request.sha256};
  assert.equal(reconcileCampaignArchive(f).reservedCents, 2);
  f.packets.key.requestBodySha256 = 'other';
  assert.throws(() => reconcileCampaignArchive(f));
});
test('prepared plan retains denominator, completed work, allowance and partial-directory history', () => {
  const state = {root: 'generated-artifacts/campaign', approval: {id: 'campaign',
    queueSha256: 'frozen', maximumSpendCents: 10000},
    queue: [...Array.from({length: 985}, (_, i) => ({profile_id: 'done-' + i})), ...artists],
    rows: Array.from({length: 985}, (_, i) => ({likelyReviewSuggestion: i < 477})),
    cursor: 985, nextOrdinal: 4, priorDeferred: [], funds: {nextCapCents: 2000,
      reservedCents: 3776, allocatedCents: 3776}, paidAdmissions: 1888,
    preservedPartialDirectories: ['campaign-chunk-001', 'campaign-chunk-002', 'campaign-chunk-003'],
    ledgerSha256: 'ledger', files: {}};
  const plan = buildCampaignRecoveryPlan(state, artists.slice(7).map(live), 'now');
  assert.equal(plan.originalQueueArtists, 1485);
  assert.equal(plan.processedArtists, 985);
  assert.equal(plan.likelyMatches, 477);
  assert.equal(plan.remainingAllowanceCents, 6224);
  assert.equal(plan.reservedCents, 3776);
  assert.equal(plan.eligibleProfileIds.length, 493);
  assert.equal(plan.deferred.length, 7);
  assert.equal(plan.nextDirectory, 'generated-artifacts/campaign-chunk-004');
  assert.equal(plan.paidCalls, 0);
  assert.equal(plan.restarted, false);
  assert.equal(plan.requiresExplicitActivation, true);
});
test('explicit activation locks and compares spending history; stale plans cannot change ownership', async () => {
  const ledger = {parent: {id: 'campaign', scope_sha256: 'approval', cap_cents: 10000, owner: 'old'},
    children: [], admissions: []};
  const calls = [];
  const c = {release() {}, async query(sql) {
    calls.push(sql);
    if (sql.includes('FROM instagram_campaign_budgets')) return {rows: [ledger.parent]};
    if (sql.includes('SELECT b.id')) return {rows: ledger.children};
    if (sql.includes('SELECT a.budget_id')) return {rows: ledger.admissions};
    return {rows: []};
  }};
  const plan = {campaignId: 'campaign', ledgerSha256: digest(ledger),
    approvalSha256: 'approval', maximumSpendCents: 10000,
    status: 'prepared_not_started', requiresExplicitActivation: true};
  const claim = await claimPreparedCampaignRecovery({connect: async () => c}, plan);
  assert.equal(claim.capCents, 10000);
  assert.ok(calls.some(sql => sql.includes('FOR UPDATE')));
  assert.equal(calls.filter(sql => sql.startsWith('UPDATE')).length, 1);
  calls.length = 0;
  ledger.children.push({id: 'new-paid-child'});
  await assert.rejects(claimPreparedCampaignRecovery({connect: async () => c}, plan), /changed since/);
  assert.equal(calls.filter(sql => sql.startsWith('UPDATE')).length, 0);
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('changed evidence cannot activate and readiness checks never modify archived files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'campaign-recovery-'));
  try {
    const file = path.join(dir, 'archive.json');
    const content = '{"preserved":true}\n';
    await fs.writeFile(file, content);
    const plan = {status: 'prepared_not_started', requiresExplicitActivation: true,
      paidCalls: 0, files: {[file]: digest(content)}};
    await assertRecoveryFiles(plan);
    assert.equal(await fs.readFile(file, 'utf8'), content);
    await fs.writeFile(file, content + '\n');
    await assert.rejects(assertRecoveryFiles(plan), /evidence changed/);
    await fs.rm(file);
    await assert.rejects(assertRecoveryFiles(plan), /ENOENT/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
