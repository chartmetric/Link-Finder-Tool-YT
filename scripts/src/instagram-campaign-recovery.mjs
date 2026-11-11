// Recovery preparation is read-only. Importing this module cannot launch work.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from './instagram-next-saved-batch.mjs';
import {nextCampaignAllocation} from './instagram-campaign-budget.mjs';

const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const unique = (rows, key, label) => {
  const values = rows.map(r => String(r[key]));
  assert.equal(new Set(values).size, rows.length, `Duplicate ${label}.`);
  return new Map(rows.map(r => [String(r[key]), r]));
};

export function partitionCampaignEligibility(selected, current) {
  const frozen = unique(selected, 'profile_id', 'queued artist');
  const live = unique(current, 'profile_id', 'eligibility row');
  assert.ok([...live.keys()].every(id => frozen.has(id)), 'Foreign eligibility row.');
  const eligible = [], deferred = [];
  for (const artist of selected) {
    const row = live.get(String(artist.profile_id));
    let reason;
    if (!row) reason = 'missing_current_tier_or_profile';
    else if (String(row.cm_artist) !== String(artist.cm_artist)) reason = 'catalog_identity_changed';
    else {
      assert.ok([0, 1].includes(Number(row.has_instagram)), 'Invalid Instagram eligibility flag.');
      assert.ok(Number.isInteger(Number(row.tier)), 'Invalid current tier.');
      if (Number(row.has_instagram) === 1) reason = 'catalog_instagram_now_present';
      else if (Number(row.tier) < 1 || Number(row.tier) > 5) reason = 'outside_current_tiers';
    }
    if (reason) deferred.push({profileId: String(artist.profile_id),
      cmArtist: String(artist.cm_artist), frozenTier: Number(artist.tier),
      reason, outcome: 'deferred_not_searched', currentEvidence: row ?? null});
    else eligible.push(row);
  }
  return {eligible, deferred};
}

export function reconcileCampaignArchive({scope, journal, packets, budget, admissions, abandonment = null}) {
  assert.equal(budget.id, scope.authorization.budgetId);
  assert.equal(budget.scope_sha256, digest(scope), 'Changed historical scope.');
  const sent = journal.filter(r => r.phase === 'admitted');
  const sentByKey = unique(sent, 'key', 'archived admission');
  assert.ok(sent.length > 0, 'Empty historical admission archive.');
  const returned = unique(journal.filter(r => r.phase === 'returned'), 'key', 'returned receipt');
  const stopped = unique(journal.filter(r => r.phase === 'stopped_no_retry'), 'key', 'stopped receipt');
  assert.ok([...returned.keys(), ...stopped.keys()].every(k => sentByKey.has(k)));
  assert.ok([...returned.keys()].every(k => !stopped.has(k)), 'Ambiguous completion.');
  const ledger = unique(admissions, 'admission_key', 'ledger admission');
  assert.equal(ledger.size, sent.length, 'Archive/ledger count mismatch.');
  assert.equal(budget.reserved_cents, sent.length * 2, 'Reservation mismatch.');
  assert.equal(budget.cap_cents, budget.reserved_cents, 'Child allocation is not retired.');
  assert.ok(budget.cap_cents <= scope.authorization.maxSpendCents);
  const abandoned = new Set(abandonment?.uncertainKeysPermanentlySkipped ?? []);
  if (abandoned.size) {
    assert.equal(abandonment.oldAdmissionsNeverReplay, true);
    assert.equal(abandonment.scopeSha256, digest(scope));
    assert.equal(abandonment.journalSha256, digest(journal));
    assert.equal(abandonment.preservedReservedCents, budget.reserved_cents);
    assert.ok([...abandoned].every(key => stopped.has(key) && !returned.has(key) && sentByKey.has(key)));
  }
  for (const a of sent) {
    const entry = ledger.get(a.key);
    assert.ok(entry, 'Missing paid admission in ledger.');
    assert.equal(String(entry.profile_id), String(a.profileId));
    assert.equal(entry.cents, 2);
    assert.equal(a.reservedCents, 2);
    assert.equal(a.request.sha256, digest(a.request.body), 'Changed paid request.');
    const packet = packets[a.key];
    if (abandoned.has(a.key)) {
      assert.equal(packet, undefined, 'Abandoned request unexpectedly has a response.');
      continue; // Charged, terminal, and never replayable; not a successful response.
    }
    assert.ok(packet, 'Missing paid response; no replay.');
    assert.ok(Number.isInteger(packet.status) && packet.status >= 100 && packet.status <= 599);
    // Auth, funding and rate-limit stops require separate investigation.
    assert.ok(![401, 402, 403, 429].includes(packet.status), 'Unsafe provider stop.');
    if (a.request.kind === 'scrapecreators_candidate') {
      assert.equal(packet.requestedUrl, a.request.body.url);
    } else {
      assert.equal(a.request.kind, 'jev');
      assert.equal(packet.requestBodySha256, a.request.sha256);
    }
    if (!returned.has(a.key)) {
      assert.ok(stopped.has(a.key), 'Uncertain paid request; no replay.');
      assert.equal(a.request.kind, 'scrapecreators_candidate');
      assert.equal(packet.status, 404);
      assert.equal(packet.data?.success, true);
      assert.equal(packet.data?.error, 'not_found');
      assert.equal(packet.data?.errorStatus, 404);
      assert.equal(packet.data?.message, 'Profile is restricted');
      assert.equal(packet.data?.handle, new URL(packet.requestedUrl).pathname.split('/')[1]);
    }
  }
  return {admissions: sent.length, reservedCents: budget.reserved_cents,
    profileIds: [...new Set(sent.map(a => String(a.profileId)))]};
}

// The same projection is used during offline preparation and under the parent
// lock at explicit activation. Never include mutable timestamps or SQL row order.
export async function readCampaignLedger(client, id, lock = false) {
  const parent = (await client.query(`SELECT id,scope_sha256,cap_cents,owner
    FROM instagram_campaign_budgets WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows;
  assert.equal(parent.length, 1);
  const children = (await client.query(`SELECT b.id,b.scope_sha256,b.cap_cents,b.reserved_cents
    FROM instagram_campaign_children c INNER JOIN instagram_saved_batch_budgets b ON b.id=c.budget_id
    WHERE c.campaign_id=$1 ORDER BY b.id`, [id])).rows;
  const admissions = (await client.query(`SELECT a.budget_id,a.admission_key,a.profile_id,a.cents
    FROM instagram_saved_batch_admissions a INNER JOIN instagram_campaign_children c ON c.budget_id=a.budget_id
    WHERE c.campaign_id=$1 ORDER BY a.budget_id,a.admission_key`, [id])).rows;
  return {parent: parent[0], children, admissions};
}

export async function loadCampaignRecovery(root, ledger) {
  const originalApproval = await read(root + '/approval.json');
  const approval = ledger.parent.cap_cents===null ? await read(root + '/uncapped-approval.json') : originalApproval;
  if (ledger.parent.cap_cents===null) {
    assert.equal(approval.uncappedExplicitlyApproved, true);
    assert.equal(approval.originalApprovalSha256, digest(originalApproval));
    assert.equal(approval.maximumSpendCents, null);
    assert.equal(approval.queueSha256, originalApproval.queueSha256);
  }
  const queue = await read(root + '/queue.json');
  assert.equal(digest(queue), approval.queueSha256);
  unique(queue, 'profile_id', 'queue identity');
  unique(queue, 'cm_artist', 'Chartmetric identity');
  assert.equal(ledger.parent.id, approval.id);
  assert.equal(ledger.parent.scope_sha256, digest(approval));
  assert.equal(ledger.parent.cap_cents, approval.maximumSpendCents);
  const progress = await read(root + '/progress.json');
  assert.equal(progress.status, 'stopped', 'Campaign must be stopped.');
  const savedRows = await read(root + '/artist-outcomes.json'), chunks = await read(root + '/chunks.json');
  const rows = savedRows.filter(r => r.reason !== 'not_inspected_within_approved_run');
  unique(rows, 'profileId', 'completed artist');
  assert.equal(progress.completedArtists ?? progress.processedArtists, savedRows.length);
  const files = new Map();
  async function tracked(p) {
    const content = await fs.readFile(p, 'utf8');
    files.set(p, digest(content));
    return JSON.parse(content);
  }
  for (const name of ['approval.json', 'queue.json', 'progress.json', 'artist-outcomes.json', 'chunks.json'])
    await tracked(root + '/' + name);
  if (ledger.parent.cap_cents===null) await tracked(root + '/uncapped-approval.json');
  const priorDeferred = await fs.access(root + '/deferred-artists.json').then(
    () => tracked(root + '/deferred-artists.json'), e => {
      if (e.code !== 'ENOENT') throw e;
      return [];
    });
  const deferredById = unique(priorDeferred, 'profileId', 'deferred artist');
  const covered = new Set(rows.map(r => String(r.profileId)));
  for (const id of deferredById.keys()) {
    assert.ok(!covered.has(id), 'Deferred artist counted as processed.');
    covered.add(id);
  }
  const cursor = covered.size;
  const frozenIds = new Set(queue.map(r => String(r.profile_id)));
  assert.ok([...covered].every(id => frozenIds.has(id)), 'Saved work contains a foreign identity.');
  for (const row of priorDeferred) {
    const frozen = queue.find(r=>String(r.profile_id)===String(row.profileId));
    assert.equal(String(row.cmArtist), String(frozen.cm_artist), 'Deferred identity changed.');
  }
  // Deferrals may occur after the timeout within the selected chunk. Preserve
  // them, but return every untouched artist to the worklist in frozen order.
  const workQueue = [...queue.filter(r => covered.has(String(r.profile_id))),
    ...queue.filter(r => !covered.has(String(r.profile_id)))];
  assert.equal(chunks.length, ledger.children.length, 'Unknown campaign child.');
  const archivedRows = [], reconciled = [];
  for (const chunk of chunks) {
    assert.ok(chunk.dir.startsWith(root + '-chunk-') && /^\d+$/.test(chunk.dir.slice((root + '-chunk-').length)));
    const scope = await tracked(chunk.dir + '/approved-scope.json');
    const budget = ledger.children.find(b => b.id === scope.authorization.budgetId);
    assert.ok(budget, 'Unknown archive budget.');
    const journalPath = chunk.dir + '/execution/admissions.jsonl';
    const journalText = await fs.readFile(journalPath, 'utf8');
    files.set(journalPath, digest(journalText));
    const journal = journalText.trim().split('\n').filter(Boolean).map(JSON.parse);
    const retirementPath = chunk.dir + '/retired-unused-allocation.json';
    const abandonment = await fs.access(retirementPath).then(() => tracked(retirementPath), e => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    const packets = {};
    for (const a of journal.filter(r => r.phase === 'admitted')) {
      assert.match(a.key, /^[a-zA-Z0-9_-]+$/, 'Unsafe receipt key.');
      const kind = a.request.kind === 'scrapecreators_candidate' ? 'metadata-responses' : 'model-responses';
      const packetPath = chunk.dir + '/execution/' + kind + '/' + a.key + '.json';
      packets[a.key] = await fs.access(packetPath).then(() => tracked(packetPath), e => {
        if (e.code !== 'ENOENT' || !abandonment?.uncertainKeysPermanentlySkipped?.includes(a.key)) throw e;
        return undefined;
      });
    }
    reconciled.push(reconcileCampaignArchive({scope, journal, packets, budget,
      admissions: ledger.admissions.filter(a => a.budget_id === budget.id), abandonment}));
    const outcomes = await tracked(chunk.dir + '/execution/artist-outcomes.json');
    for (const row of outcomes) {
      if (row.reason === 'not_inspected_within_approved_run') {
        assert.ok(!reconciled.at(-1).profileIds.includes(String(row.profileId)), 'Paid artist marked untouched.');
      } else archivedRows.push(row);
    }
  }
  assert.equal(digest(archivedRows), digest(rows), 'Aggregate differs from saved child results.');
  const paidIds = new Set(reconciled.flatMap(r => r.profileIds));
  assert.ok([...paidIds].every(id => rows.some(r => String(r.profileId) === id)));
  // Reserve a new directory/ordinal, including unfinished read-only preparations.
  const parentDir = path.dirname(root), base = path.basename(root);
  const dirs = (await fs.readdir(parentDir)).filter(n => n.startsWith(base + '-chunk-')
    && /^\d+$/.test(n.slice((base + '-chunk-').length))).sort();
  const nextOrdinal = 1 + Math.max(0, ...dirs.map(n => Number(n.slice((base + '-chunk-').length))));
  const funds = nextCampaignAllocation(approval.maximumSpendCents, ledger.children);
  return {root, approval, queue: workQueue, rows, chunks, priorDeferred, cursor, nextOrdinal, funds,
    ledgerSha256: digest(ledger), files: Object.fromEntries(files),
    paidAdmissions: reconciled.reduce((sum, r) => sum + r.admissions, 0),
    preservedPartialDirectories: dirs};
}

export function buildCampaignRecoveryPlan(state, eligibility, collectedAt) {
  const selected = state.queue.slice(state.cursor,
    state.cursor + Math.min(500, Math.floor(state.funds.nextCapCents / 4)));
  assert.ok(selected.length, 'No eligible spending allocation remains.');
  const partition = partitionCampaignEligibility(selected, eligibility);
  return {version: 1, status: 'prepared_not_started', campaignId: state.approval.id,
    approvalSha256: digest(state.approval), queueSha256: state.approval.queueSha256,
    originalQueueArtists: state.queue.length, maximumSpendCents: state.approval.maximumSpendCents,
    processedArtists: state.rows.length, likelyMatches: state.rows.filter(r => r.likelyReviewSuggestion).length,
    reservedCents: state.funds.reservedCents,
    remainingAllowanceCents: state.approval.maximumSpendCents===null?null:state.approval.maximumSpendCents - state.funds.allocatedCents,
    reconciledPaidRequests: state.paidAdmissions, uncertainRequests: 0,
    cursor: state.cursor, nextOrdinal: state.nextOrdinal,
    nextDirectory: state.root + '-chunk-' + String(state.nextOrdinal).padStart(3, '0'),
    selectedProfileIds: selected.map(r => String(r.profile_id)),
    eligibilityCollectedAt: collectedAt, eligibility,
    eligibleProfileIds: partition.eligible.map(r => String(r.profile_id)),
    deferred: partition.deferred, priorDeferred: state.priorDeferred,
    preservedPartialDirectories: state.preservedPartialDirectories,
    ledgerSha256: state.ledgerSha256, files: state.files,
    paidCalls: 0, databaseWrites: 0, restarted: false,
    requiresExplicitActivation: true, revalidateEligibilityBeforePaidWork: true};
}

// Only called by an explicitly launched worker, never by the preparation CLI.
export async function claimPreparedCampaignRecovery(pool, plan) {
  assert.equal(plan.status, 'prepared_not_started');
  assert.equal(plan.requiresExplicitActivation, true);
  assert.ok(plan.maximumSpendCents===10000||plan.maximumSpendCents===null);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='15s'");
    const ledger = await readCampaignLedger(c, plan.campaignId, true);
    assert.equal(digest(ledger), plan.ledgerSha256, 'Spending history changed since preparation.');
    assert.equal(ledger.parent.scope_sha256, plan.approvalSha256);
    assert.equal(ledger.parent.cap_cents, plan.maximumSpendCents);
    const owner = randomUUID();
    await c.query('UPDATE instagram_campaign_budgets SET owner=$2 WHERE id=$1', [plan.campaignId, owner]);
    await c.query('COMMIT');
    return {id: plan.campaignId, scopeSha256: plan.approvalSha256, capCents: plan.maximumSpendCents, owner};
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

export async function assertRecoveryFiles(plan) {
  assert.equal(plan.status, 'prepared_not_started');
  assert.equal(plan.requiresExplicitActivation, true);
  assert.equal(plan.paidCalls, 0);
  for (const [p, hash] of Object.entries(plan.files))
    assert.equal(digest(await fs.readFile(p, 'utf8')), hash, 'Saved recovery evidence changed: ' + p);
}
