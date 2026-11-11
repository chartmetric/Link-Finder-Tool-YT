// Explicit operator fence. It blocks NEW admissions while allowing the one
// already dispatched request to save its response and the old worker to exit.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {digest} from './instagram-next-saved-batch.mjs';

export const LEGACY_ROOT='generated-artifacts/next-saved-full-tiers-1-5-usd100';
export const PRIORITY_ROOT='generated-artifacts/instagram-tier-priority';
export async function fenceLegacyInstagram(){
  const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
  const original=await read(LEGACY_ROOT+'/approval.json'),approval=await read(LEGACY_ROOT+'/uncapped-approval.json');
  assert.equal(approval.originalApprovalSha256,digest(original));
  assert.equal(approval.maximumSpendCents,null);assert.equal(approval.uncappedExplicitlyApproved,true);
  const progress=await read(LEGACY_ROOT+'/progress.json');
  assert.equal(progress.status,'running');
  assert.ok(progress.activeChunk?.startsWith(LEGACY_ROOT+'-chunk-'));
  const scope=await read(progress.activeChunk+'/approved-scope.json');
  const owner=randomUUID(),pool=await connectSavedBatchPool(),c=await pool.connect();
  try{
    await c.query('BEGIN');
    const parent=(await c.query('SELECT * FROM instagram_campaign_budgets WHERE id=$1 FOR UPDATE',[original.id])).rows[0];
    const child=(await c.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1 FOR UPDATE',[scope.authorization.budgetId])).rows[0];
    assert.equal(parent.scope_sha256,digest(approval));assert.equal(parent.cap_cents,null);
    assert.equal(child.scope_sha256,digest(scope));assert.ok(child.owner);
    const membership=(await c.query('SELECT 1 FROM instagram_campaign_children WHERE campaign_id=$1 AND budget_id=$2',[original.id,child.id])).rowCount;
    assert.equal(membership,1);
    await fs.mkdir(PRIORITY_ROOT,{recursive:false});
    const proof={version:1,campaignId:original.id,queueSha256:original.queueSha256,
      approvedBy:'User selected Switch to strict tier order.',
      at:new Date().toISOString(),parentScopeSha256:parent.scope_sha256,parentOwner:owner,
      priorParentOwner:parent.owner,childId:child.id,childScopeSha256:child.scope_sha256,
      childDirectory:progress.activeChunk,priorChildOwner:child.owner,
      reservedAtFenceCents:child.reserved_cents,policy:'tier_1_then_2_then_3_then_4_then_5',
      automaticRetries:0,maximumSpendCents:null};
    await fs.writeFile(PRIORITY_ROOT+'/handoff.json',JSON.stringify(proof,null,2),{flag:'wx'});
    await c.query('UPDATE instagram_saved_batch_budgets SET owner=$2 WHERE id=$1',[child.id,owner]);
    await c.query('UPDATE instagram_campaign_budgets SET owner=$2 WHERE id=$1',[parent.id,owner]);
    await c.query('COMMIT');
    console.log(JSON.stringify({status:'draining',child:child.id,reservedCents:child.reserved_cents,
      noRequestCancelled:true,noNewAdmissions:true,noReplay:true}));
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--fence-approved']);await fenceLegacyInstagram();
}
