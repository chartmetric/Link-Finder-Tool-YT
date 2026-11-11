import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from './instagram-next-saved-batch.mjs';
import {loadCampaignRecovery, readCampaignLedger, buildCampaignRecoveryPlan,
  claimPreparedCampaignRecovery, assertRecoveryFiles} from './instagram-campaign-recovery.mjs';
import {allocateCampaignChild, nextCampaignAllocation} from './instagram-campaign-budget.mjs';
import {openSavedBatchGate} from './instagram-saved-batch-gate.mjs';
import {campaignMemoryLedger} from '../fixtures/campaign-memory-ledger.mjs';

const operation = fileURLToPath(new URL('./authorize-uncapped-instagram-campaign.mjs', import.meta.url));
const loader = fileURLToPath(new URL('../fixtures/campaign-authorization-loader.mjs', import.meta.url));
const writes = calls => calls.filter(c => /^(INSERT|UPDATE|ALTER|DELETE)/.test(c.sql));
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
async function write(p, value) {
  await fs.mkdir(path.dirname(p), {recursive: true});
  await fs.writeFile(p, JSON.stringify(value));
}
async function tree(dir) {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const result = {};
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await tree(p));
    else result[p] = digest(await fs.readFile(p, 'utf8'));
  }
  return result;
}
function scopeFor(id, profileId, cap = 2000) {
  const body = {url: `https://www.instagram.com/fixture_${profileId}/`};
  return {authorization: {approved: true, budgetId: id, maxSpendCents: cap},
    savedEvidenceOnly: false, candidateMetadataFetchesApproved: true,
    liveLinkWrites: false, automaticRetries: 0,
    artists: [{profile_id: profileId, savedCandidateUrls: [body.url]}],
    requests: [{key: 'metadata-' + profileId, profileId, kind: 'scrapecreators_candidate',
      body, sha256: digest(body), bytes: Buffer.byteLength(JSON.stringify(body))}]};
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uncapped-campaign-'));
  // These tests are sequential: preserve the runner's cwd because the real
  // operation deliberately binds relative archive paths, not just their bytes.
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await fs.rm(dir, {recursive: true, force: true});
  });
  // Match the CLI's operations path, but only underneath a disposable cwd.
  const relativeRoot = 'generated-artifacts/next-saved-full-tiers-1-5-usd100';
  const root = relativeRoot, id = 'test-only-campaign';
  const queue = Array.from({length: 10}, (_, i) =>
    ({profile_id: String(i + 1), cm_artist: String(i + 1001), tier: (i % 5) + 1}));
  const approval = {id, queueSha256: digest(queue), maximumSpendCents: 10000, approved: true};
  const ledger = {parent: {id, scope_sha256: digest(approval), cap_cents: 10000, owner: 'old-owner'},
    children: [], admissions: []};
  const outcomes = [{profileId: '1', likelyReviewSuggestion: true},
    {profileId: '4', reason: 'charged_timeout_permanently_skipped'},
    ...queue.filter(a => !['1', '3', '4', '7'].includes(a.profile_id)).map(a =>
      ({profileId: a.profile_id, reason: 'not_inspected_within_approved_run'}))];
  const deferred = ['3', '7'].map(profileId => ({
    profileId, cmArtist: queue[Number(profileId) - 1].cm_artist,
    outcome: 'deferred_not_searched', reason: 'missing_current_tier_or_profile'}));
  const chunks = [];
  for (const [index, profileId] of ['1', '4'].entries()) {
    const childDir = root + '-chunk-' + String(index + 1).padStart(3, '0');
    const scope = scopeFor(id + '-chunk-' + String(index + 1).padStart(3, '0'), profileId);
    const request = scope.requests[0], key = request.key;
    const journal = [{phase: 'admitted', key, profileId, reservedCents: 2, request},
      {phase: profileId === '4' ? 'stopped_no_retry' : 'returned', key}];
    const budget = {id: scope.authorization.budgetId, scope_sha256: digest(scope), cap_cents: 2,
      reserved_cents: 2, owner: 'historical-child-owner'};
    ledger.children.push(budget);
    ledger.admissions.push({budget_id: budget.id, admission_key: key, profile_id: profileId, cents: 2});
    await write(childDir + '/approved-scope.json', scope);
    await write(childDir + '/execution/artist-outcomes.json',
      profileId === '1' ? [outcomes[0], ...outcomes.slice(2, 4)] : [outcomes[1], ...outcomes.slice(4)]);
    await fs.writeFile(childDir + '/execution/admissions.jsonl', journal.map(JSON.stringify).join('\n') + '\n');
    if (profileId === '4') await write(childDir + '/retired-unused-allocation.json', {
      uncertainKeysPermanentlySkipped: [key], oldAdmissionsNeverReplay: true,
      scopeSha256: digest(scope), journalSha256: digest(journal), preservedReservedCents: 2});
    else await write(childDir + '/execution/metadata-responses/' + key + '.json',
      {status: 200, requestedUrl: request.body.url, data: {fixture: true}});
    chunks.push({dir: childDir});
  }
  await write(root + '/approval.json', approval);
  await write(root + '/queue.json', queue);
  await write(root + '/artist-outcomes.json', outcomes);
  await write(root + '/chunks.json', chunks);
  await write(root + '/progress.json', {status: 'stopped', completedArtists: outcomes.length});
  await write(root + '/deferred-artists.json', deferred);
  // Incomplete read-only preparations must not be reused or overwritten.
  await write(root + '-chunk-003/partial.json', {preparedOnly: true});
  await fs.mkdir(root + '-chunk-008', {recursive: true});
  const ledgerPath = path.join(dir, 'synthetic-ledger.json');
  await write(ledgerPath, ledger);
  const authorize = (args = ['--approve-uncapped-remaining']) => spawnSync(process.execPath,
    ['--import', loader, operation, ...args], {cwd: dir, encoding: 'utf8', timeout: 10000,
      // No inherited credentials, DATABASE_URL or provider configuration.
      env: {TEST_CAMPAIGN_LEDGER: ledgerPath}});
  return {dir, root, id, queue, approval, ledger, ledgerPath, chunks, outcomes, authorize};
}
async function projection(memory, id) {
  const c = await memory.pool.connect();
  try { return await readCampaignLedger(c, id); } finally { c.release(); }
}
async function prepared(memory, f) {
  const state = await loadCampaignRecovery(f.root, await projection(memory, f.id));
  const eligibility = state.queue.slice(state.cursor).map(a => ({...a, has_instagram: 0})).reverse();
  return {state, plan: buildCampaignRecoveryPlan(state, eligibility, 'fixture-time')};
}

test('offline capped stop → supplemental uncapped approval → recovery → later recovery never replays charges',
  async t => {
    const f = await fixture(t), before = await tree('generated-artifacts');
    const memory = campaignMemoryLedger(f.ledger);
    const capped = await prepared(memory, f);
    const untouched = ['2', '5', '6', '8', '9', '10'];
    assert.deepEqual(capped.plan.selectedProfileIds, untouched);
    assert.deepEqual(capped.plan.eligibleProfileIds, untouched);
    assert.equal(capped.plan.originalQueueArtists, 10);
    assert.equal(capped.plan.processedArtists, 2);
    assert.equal(capped.plan.reservedCents, 4);
    assert.equal(capped.plan.reconciledPaidRequests, 2);
    assert.equal(capped.plan.nextOrdinal, 9);
    assert.equal(capped.plan.maximumSpendCents, 10000);
    assert.equal(capped.plan.remainingAllowanceCents, 9996);
    assert.deepEqual(capped.plan.priorDeferred.map(a => a.profileId), ['3', '7']);
    assert.equal(new Set(capped.state.queue.map(a => a.profile_id)).size, 10);
    assert.deepEqual(await tree('generated-artifacts'), before, 'Preparation must be read-only.');
    assert.equal(writes(memory.calls).length, 0);

    const authorized = f.authorize();
    assert.equal(authorized.status, 0, authorized.stderr);
    assert.deepEqual(JSON.parse(authorized.stdout), {status: 'uncapped_remaining_approved',
      maximumSpendCents: null, preservedReservedCents: 4, paidCalls: 0, restarted: false});
    const afterAuthorization = await read(f.ledgerPath);
    const supplemental = await read(f.root + '/uncapped-approval.json');
    assert.equal(supplemental.maximumSpendCents, null);
    assert.equal(supplemental.uncappedExplicitlyApproved, true);
    assert.equal(supplemental.originalApprovalSha256, digest(f.approval));
    assert.equal(supplemental.queueSha256, f.approval.queueSha256);
    assert.equal(supplemental.preservedReservedCents, 4);
    assert.deepEqual(afterAuthorization.children, f.ledger.children);
    assert.deepEqual(afterAuthorization.admissions, f.ledger.admissions);
    assert.equal(afterAuthorization.parent.owner, 'old-owner', 'Authorization does not start work.');
    const afterTree = await tree('generated-artifacts');
    delete afterTree[f.root + '/uncapped-approval.json'];
    assert.deepEqual(afterTree, before, 'Original approval and archives remain byte-identical.');
    const calls = await read(f.ledgerPath + '.calls.json');
    assert.deepEqual(writes(calls).map(c => c.sql.split(' ')[0]), ['ALTER', 'UPDATE']);
    assert.ok(calls.some(c => c.sql.includes('FOR UPDATE')));

    const uncapped = campaignMemoryLedger(afterAuthorization);
    const unchanged = uncapped.state;
    const historicalDispatches = [];
    for (const chunk of f.chunks) {
      const scope = await read(chunk.dir + '/approved-scope.json');
      await assert.rejects(openSavedBatchGate({pool: uncapped.pool, scope, scopeSha256: digest(scope),
        journalPath: path.join(f.dir, scope.authorization.budgetId + '-replay.jsonl'),
        transport: {live: true, dispatch: async r => { historicalDispatches.push(r); }}}),
      /approval is missing or changed/);
    }
    assert.deepEqual(historicalDispatches, [], 'Retired historical children must never dispatch.');
    await assert.rejects(claimPreparedCampaignRecovery(uncapped.pool, capped.plan), /changed since/);
    await assert.rejects(allocateCampaignChild(uncapped.pool,
      {id: f.id, scopeSha256: digest(f.approval), capCents: 10000, owner: 'old-owner'},
      {id: f.id + '-chunk-009', scopeSha256: 'stale', capCents: 2000}));
    assert.deepEqual(uncapped.state, unchanged);
    assert.equal(writes(uncapped.calls).length, 0);

    const recovery = await prepared(uncapped, f);
    assert.deepEqual(recovery.plan.selectedProfileIds, untouched);
    assert.equal(recovery.plan.maximumSpendCents, null);
    assert.equal(recovery.plan.remainingAllowanceCents, null);
    assert.equal(recovery.plan.nextOrdinal, 9);
    await assertRecoveryFiles(recovery.plan);
    const claim = await claimPreparedCampaignRecovery(uncapped.pool, recovery.plan);
    assert.notEqual(claim.owner, 'old-owner');
    assert.equal(claim.capCents, null);
    await assert.rejects(claimPreparedCampaignRecovery(uncapped.pool, recovery.plan), /changed since/);
    const staleOwner = {...claim, owner: 'old-owner'};
    await assert.rejects(allocateCampaignChild(uncapped.pool, staleOwner,
      {id: f.id + '-chunk-009', scopeSha256: 'stale-owner', capCents: 2}));

    // Even with an unlimited parent, a bounded child and one durable admission
    // still precede the stub's fake charge. No real provider transport exists.
    const childDir = f.root + '-chunk-009', scope = scopeFor(f.id + '-chunk-009', '2', 2);
    await write(childDir + '/approved-scope.json', scope);
    await fs.mkdir(childDir + '/execution', {recursive: true});
    await allocateCampaignChild(uncapped.pool, claim,
      {id: scope.authorization.budgetId, scopeSha256: digest(scope), capCents: 2});
    const charged = [];
    const transport = {live: true, async dispatch(request) {
      assert.equal(uncapped.state.children.at(-1).reserved_cents, 2);
      assert.ok(uncapped.state.admissions.some(a => a.profile_id === '2'));
      charged.push(request.key);
      return {cost: 0.02, costBasis: 'conservative_fixture'};
    }};
    const gate = await openSavedBatchGate({pool: uncapped.pool, scope, scopeSha256: digest(scope),
      journalPath: childDir + '/execution/gate-journal.jsonl', transport});
    t.after(() => gate.close());
    await gate.request(scope.requests[0].key);
    assert.deepEqual(charged, ['metadata-2']);
    await assert.rejects(openSavedBatchGate({pool: uncapped.pool, scope, scopeSha256: digest(scope),
      journalPath: childDir + '/execution/replay.jsonl', transport}), /already claimed/);
    assert.deepEqual(charged, ['metadata-2']);
    assert.deepEqual(uncapped.state.admissions.slice(0, 2), f.ledger.admissions);
    assert.deepEqual(uncapped.state.children.slice(0, 2), f.ledger.children);

    // Archive the single fake response in the same format as historical workers.
    const journal = (await fs.readFile(childDir + '/execution/gate-journal.jsonl', 'utf8'))
      .trim().split('\n').map(JSON.parse);
    journal[0].request = scope.requests[0];
    await fs.writeFile(childDir + '/execution/admissions.jsonl', journal.map(JSON.stringify).join('\n') + '\n');
    await write(childDir + '/execution/metadata-responses/metadata-2.json',
      {status: 200, requestedUrl: scope.requests[0].body.url});
    const completed = {profileId: '2', likelyReviewSuggestion: false};
    await write(childDir + '/execution/artist-outcomes.json', [completed]);
    await write(f.root + '/chunks.json', [...f.chunks, {dir: childDir}]);
    const saved = [...f.outcomes.filter(r => r.profileId !== '2'), completed];
    await write(f.root + '/artist-outcomes.json', saved);
    await write(f.root + '/progress.json', {status: 'stopped', completedArtists: saved.length});
    const later = await prepared(uncapped, f);
    assert.deepEqual(later.plan.selectedProfileIds, untouched.slice(1));
    assert.equal(new Set(later.plan.selectedProfileIds).size, untouched.length - 1);
    assert.equal(later.plan.originalQueueArtists, 10);
    assert.equal(later.plan.processedArtists, 3);
    assert.equal(later.plan.reservedCents, 6);
    assert.equal(later.plan.reconciledPaidRequests, 3);
    assert.equal(later.plan.nextOrdinal, 10);
    assert.equal(new Set(later.state.queue.map(a => a.profile_id)).size, 10);
    assert.deepEqual(later.plan.priorDeferred.map(a => a.profileId), ['3', '7']);
    const funds = nextCampaignAllocation(null, uncapped.state.children);
    assert.deepEqual(funds, {allocatedCents: 6, reservedCents: 6, nextCapCents: 2000});
    const snapshot = uncapped.state;
    for (const capCents of [null, undefined, 0, -2, 2001, Infinity]) {
      await assert.rejects(allocateCampaignChild(uncapped.pool, claim,
        {id: f.id + '-chunk-010', scopeSha256: 'bad-child', capCents}));
    }
    assert.deepEqual(uncapped.state, snapshot);
    // Exercise failure after reconciling the clean successful archive: a later
    // rejected duplicate must not be mistaken for an additional fake charge.
    await assert.rejects(gate.request(scope.requests[0].key), /cap reached/);
    await assert.rejects(gate.request(scope.requests[0].key), /stopped/);
    assert.deepEqual(uncapped.state, snapshot);
    assert.deepEqual(charged, ['metadata-2'], 'Recoveries cannot dispatch anything.');
  });

test('unlimited parent never relaxes child authorization before journal or ledger writes', async t => {
  const f = await fixture(t);
  assert.equal(f.authorize().status, 0);
  const memory = campaignMemoryLedger(await read(f.ledgerPath)), initial = memory.state;
  const valid = scopeFor(f.id + '-chunk-009', '2', 2), dispatched = [];
  const mutations = [
    scope => { scope.authorization.maxSpendCents = null; },
    scope => { scope.authorization.maxSpendCents = 2001; },
    scope => { scope.authorization.approved = false; },
    scope => { scope.automaticRetries = 1; },
    scope => { scope.liveLinkWrites = true; },
    scope => { scope.artists = Array.from({length: 501}, (_, i) => ({profile_id: String(i)})); },
    scope => { scope.requests = Array.from({length: 1001}, () => scope.requests[0]); },
    scope => { scope.requests.push({...scope.requests[0], key: 'other'}); },
    scope => { scope.requests[0].profileId = 'foreign'; },
    scope => { scope.requests[0].body.url += 'changed'; },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const scope = structuredClone(valid);
    mutate(scope);
    const journalPath = path.join(f.dir, 'invalid-' + i + '.jsonl');
    await assert.rejects(openSavedBatchGate({pool: memory.pool, scope, scopeSha256: digest(scope),
      journalPath, transport: {live: true, dispatch: async r => { dispatched.push(r); }}}));
    await assert.rejects(fs.access(journalPath), {code: 'ENOENT'});
  }
  assert.deepEqual(memory.calls, [], 'Validation must precede every SQL statement.');
  assert.deepEqual(memory.state, initial);
  assert.deepEqual(dispatched, []);
});

test('malformed or stale capped approvals fail before authorization writes', async t => {
  const mutations = [
    ['wrong queue hash', async f => {
      const approval = {...f.approval, queueSha256: 'changed'};
      await write(f.root + '/approval.json', approval);
      f.ledger.parent.scope_sha256 = digest(approval);
    }],
    ['changed approval binding', async f => { f.ledger.parent.scope_sha256 = 'other'; }],
    ['wrong parent cap', async f => { f.ledger.parent.cap_cents = 9999; }],
    ['unretired historical child', async f => { f.ledger.children[0].cap_cents = 2000; }],
    ['lost timeout charge', async f => { f.ledger.admissions.pop(); }],
    ['changed abandonment', async f => {
      const p = f.chunks[1].dir + '/retired-unused-allocation.json';
      await write(p, {...await read(p), preservedReservedCents: 0});
    }],
    ['duplicate frozen identity', async f => {
      const queue = [...f.queue, f.queue[0]], approval = {...f.approval, queueSha256: digest(queue)};
      await write(f.root + '/queue.json', queue);
      await write(f.root + '/approval.json', approval);
      f.ledger.parent.scope_sha256 = digest(approval);
    }],
    ['active campaign', async f => {
      await write(f.root + '/progress.json', {status: 'running', completedArtists: f.outcomes.length});
    }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async t => {
    const f = await fixture(t);
    await mutate(f);
    await write(f.ledgerPath, f.ledger);
    const before = await tree(f.root), result = f.authorize();
    assert.notEqual(result.status, 0, 'Invalid authorization unexpectedly succeeded.');
    assert.equal(result.signal, null, result.stderr);
    assert.deepEqual(await read(f.ledgerPath), f.ledger);
    assert.deepEqual(await tree(f.root), before);
    assert.equal(writes(await read(f.ledgerPath + '.calls.json')).length, 0);
  });
});

test('approval command requires exact opt-in and cannot overwrite or repeat authorization', async t => {
  const f = await fixture(t), before = await tree(f.root);
  for (const args of [[], ['--approve'], ['--approve-uncapped-remaining', '--force']]) {
    assert.notEqual(f.authorize(args).status, 0);
    assert.deepEqual(await tree(f.root), before);
    await assert.rejects(fs.access(f.ledgerPath + '.calls.json'), {code: 'ENOENT'});
  }
  assert.equal(f.authorize().status, 0);
  const authorized = await read(f.ledgerPath), evidence = await tree(f.root);
  await fs.rm(f.ledgerPath + '.calls.json');
  assert.notEqual(f.authorize().status, 0);
  assert.deepEqual(await read(f.ledgerPath), authorized);
  assert.deepEqual(await tree(f.root), evidence);
  await assert.rejects(fs.access(f.ledgerPath + '.calls.json'), {code: 'ENOENT'});
});

test('malformed supplemental approvals cannot prepare or claim recovery', async t => {
  for (const [name, mutate] of [
    ['missing explicit approval', a => { delete a.uncappedExplicitlyApproved; }],
    ['false explicit approval', a => { a.uncappedExplicitlyApproved = false; }],
    ['wrong original binding', a => { a.originalApprovalSha256 = 'foreign'; }],
    ['non-null cap', a => { a.maximumSpendCents = 10000; }],
    ['missing cap', a => { delete a.maximumSpendCents; }],
    ['changed queue binding', a => { a.queueSha256 = 'foreign'; }],
    ['foreign campaign', a => { a.id = 'foreign'; }],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    assert.equal(f.authorize().status, 0);
    const approval = await read(f.root + '/uncapped-approval.json');
    mutate(approval);
    await write(f.root + '/uncapped-approval.json', approval);
    const ledger = await read(f.ledgerPath);
    // Rebind to ensure semantic validation, not only the outer digest, rejects.
    ledger.parent.scope_sha256 = digest(approval);
    const memory = campaignMemoryLedger(ledger), before = await tree(f.root);
    await assert.rejects(prepared(memory, f));
    assert.equal(writes(memory.calls).length, 0);
    assert.deepEqual(memory.state, ledger);
    assert.deepEqual(await tree(f.root), before);
  });
});
