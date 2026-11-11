// Explicit preparation only: read-only databases, new local report, no launch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './instagram-next-saved-batch.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {readCampaignLedger, loadCampaignRecovery, buildCampaignRecoveryPlan}
  from './instagram-campaign-recovery.mjs';

const args = process.argv.slice(2);
const output = args.find(a => a.startsWith('--output-dir='))?.slice('--output-dir='.length);
assert.ok(args.includes('--prepare-only') && args.length === (output ? 2 : 1)
  && args.every(a => a === '--prepare-only' || a === '--output-dir=' + output),
  'Only --prepare-only and an optional --output-dir are supported; this command cannot start paid work.');
const root = 'generated-artifacts/next-saved-full-tiers-1-5-usd100';
const destination = output ?? root + '-recovery-001';
assert.match(destination, /^generated-artifacts\/next-saved-full-tiers-1-5-usd100-recovery-\d{3}$/);
const approval = JSON.parse(await fs.readFile(root + '/approval.json', 'utf8'));
const pool = await connectSavedBatchPool();
try {
  const c = await pool.connect();
  let state;
  try {
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const ledger = await readCampaignLedger(c, approval.id);
    state = await loadCampaignRecovery(root, ledger);
    const selected = state.queue.slice(state.cursor,
      state.cursor + Math.min(500, Math.floor(state.funds.nextCapCents / 4)));
    const overlap = await c.query(`SELECT DISTINCT profile_id FROM instagram_saved_batch_admissions
      WHERE profile_id=ANY($1::text[])`, [selected.map(r => r.profile_id)]);
    assert.equal(overlap.rows.length, 0, 'Next selection overlaps historical paid work.');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
  const selected = state.queue.slice(state.cursor,
    state.cursor + Math.min(500, Math.floor(state.funds.nextCapCents / 4)));
  assert.ok(selected.every(r => /^\d+$/.test(String(r.profile_id))));
  const preparationCode = await fs.readFile('generated-artifacts/prepare-no-ig-100.mjs', 'utf8');
  const tiers = preparationCode.match(/const tiers=`([\s\S]*?)`;/)[1];
  const query = `SELECT * FROM (WITH ${tiers}
    SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,t.assigned_tier tier,
      toUInt8(p.id IN (SELECT profile_id FROM existing_instagram)) has_instagram
    FROM new_vertical.profile p FINAL INNER JOIN tier_assignments t ON t.profile=p.id
    WHERE p.id IN (${selected.map(r => r.profile_id).join(',')}) AND p.cm_source='cm_artist')`;
  const eligibility = await select(query);
  const plan = buildCampaignRecoveryPlan(state, eligibility, new Date().toISOString());
  plan.eligibilityQuery = query;
  // Bind the modified coordinator and all its existing safety dependencies.
  const code = ['generated-artifacts/run-full-tiers-campaign.mjs',
    'generated-artifacts/run-next-account-context-500.mjs', 'generated-artifacts/prepare-no-ig-100.mjs',
    ...(await fs.readdir('scripts/src')).filter(n => n.startsWith('instagram-') && n.endsWith('.mjs')
      && !n.endsWith('.test.mjs')).map(n => 'scripts/src/' + n)];
  for (const p of code) plan.files[p] = digest(await fs.readFile(p, 'utf8'));
  await fs.mkdir(destination, {recursive: false});
  await fs.writeFile(destination + '/plan.json', JSON.stringify(plan, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({status: plan.status, plan: destination + '/plan.json',
    processedArtists: plan.processedArtists, likelyMatches: plan.likelyMatches,
    nextEligibleArtists: plan.eligibleProfileIds.length, deferredArtists: plan.deferred.length,
    preservedReservedCents: plan.reservedCents, remainingAllowanceCents: plan.remainingAllowanceCents,
    reconciledPaidRequests: plan.reconciledPaidRequests,
    nextDirectory: plan.nextDirectory, paidCalls: 0, databaseWrites: 0, restarted: false}, null, 2));
} finally { await pool.end(); }
