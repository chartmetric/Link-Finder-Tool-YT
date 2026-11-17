import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {errorContinuationPlan,approveErrorContinuation,errorGroupApproval,serverErrorReceipt} from './youtube-channel-error-continuation.mjs';
import {speedSuffix,speedGroupApproval} from './youtube-channel-speed-switch.mjs';
import {sourceChannelSnapshot,verifySourceChannelReceipts} from './youtube-channel-fast-live.mjs';
import {boundedHoldReadiness} from './run-youtube-channel-speed-switch.mjs';
import {assertHoldHistory,verifyCompletedHoldGroup} from './run-youtube-channel-hold-continuation.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {assertZeroOriginalChannelAttempt} from './youtube-accounted-channel-groups.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export function errorSourceGroups(plan){
  return {id:plan.sourcePlan.id,groups:speedSuffix(plan.sourcePlan,plan.cutover.snapshot,plan.cutover.holds).groups};
}
export async function assertErrorHistory(c,plan,recovered){
  const base=plan.sourcePlan.sourcePlan;
  await assertZeroOriginalChannelAttempt(c,base.predecessor.sourcePlan);
  await assertHoldHistory(c,base,true);
  assert.deepEqual(await sourceChannelSnapshot(c,base),plan.cutover.snapshot);
  assert.deepEqual(await sourceChannelSnapshot(c,errorSourceGroups(plan)),
    recovered?plan.projectedSnapshot:plan.snapshot);
}
export async function verifyErrorReceipts(plan){
  const source=errorSourceGroups(plan),r=plan.recovery;
  await verifySourceChannelReceipts(source,{...plan.projectedSnapshot,admissions:plan.projectedSnapshot.admissions.filter(a=>
    a.run_id!==r.runId||a.operation_key!==r.operationKey)});
  const g=source.groups.find(g=>g.id===r.runId),op=g.operations.find(o=>o.key===r.operationKey);
  const receiptBytes=await fs.readFile(r.receiptPath),receipt=JSON.parse(receiptBytes),raw=await fs.readFile(r.rawPath);
  assert.equal(digest(receiptBytes),r.receiptFileSha256);assert.equal(digest(receipt),r.receiptSha256);
  assert.equal(digest(raw),r.rawSha256);
  return serverErrorReceipt(receipt,raw,g,speedGroupApproval(plan.sourcePlan,plan.sourceApproval,plan.cutover,g),op);
}
export async function errorFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  deepFreeze(plan);assert.deepEqual(errorContinuationPlan(plan),plan);assert.deepEqual(await read(root+'/plan.json'),plan);
  const files={...plan.sourceFiles,...extras,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json'))};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const verify=frozenFileVerifier(files);await verify();return verify;
}
export async function acknowledgeServerError({pool,plan,root,assertFrozen,
  checkHistory=assertErrorHistory,checkReceipts=verifyErrorReceipts}){
  await assertFrozen();const disposition=await checkReceipts(plan),c=await pool.connect();
  try{
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[MIXED_PARENT])).rows[0]?.status,'stopped');
    await checkHistory(c,plan,false);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await sourceChannelSnapshot(c,plan)).runs.length,0);
    const r=plan.recovery;
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE status='admitted' AND NOT (run_id=$1 AND operation_key=$2)`,[r.runId,r.operationKey])).rows[0].n,0);
    await durableStageFile(root+'/error-acknowledgment.json',JSON.stringify({planSha256:digest(plan),
      runId:r.runId,operationKey:r.operationKey,disposition,noProviderRequests:true,
      originalReservationPreserved:true,at:new Date().toISOString()},null,2));
    assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
      receipt_sha256=$3,raw_sha256=$4,http_status=500 WHERE run_id=$1 AND operation_key=$2
      AND status='admitted' AND receipt_sha256 IS NULL AND raw_sha256 IS NULL AND http_status IS NULL`,
    [r.runId,r.operationKey,r.receiptSha256,r.rawSha256])).rowCount,1);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-channel-error-continuation-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  let assertFrozen=await errorFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveErrorContinuation(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await read(root+'/approval.json'));
  assert.deepEqual(approveErrorContinuation(plan,approval),approval);
  assertFrozen=await errorFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const pool=await connectSavedBatchPool();
  try{
    await acknowledgeServerError({pool,plan,root,assertFrozen});
    const extras={};
    for(const f of ['approval.json','error-acknowledgment.json'])extras[root+'/'+f]=digest(await fs.readFile(root+'/'+f));
    assertFrozen=await errorFrozen(root,plan,extras);
    console.log(JSON.stringify({phase:'saved_error_skipped_without_retry',remaining:plan.maximumCalls,maximumRemainingCents:plan.maximumSpendCents}));
    for(const group of plan.groups){
      await assertFrozen();const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);
      const a=errorGroupApproval(plan,approval,group);
      await durableStageFile(folder+'/plan.json',JSON.stringify(group,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      const checkGroup=frozenFileVerifier(Object.fromEntries(await Promise.all(
        ['plan.json','approval.json'].map(async f=>[folder+'/'+f,digest(await fs.readFile(folder+'/'+f))]))));
      await executeMixedCaptures({root:folder,plan:group,approval:a,pool,targetCatalogChecks:true,holdIdentityConflicts:true,
        credential:process.env.SCRAPECREATORS_API_KEY,
        approvalCheck:(g,b)=>{assert.deepEqual(g,group);assert.deepEqual(b,errorGroupApproval(plan,approval,group));},
        readinessCheck:async(c,g,options)=>{
          await assertErrorHistory(c,plan,true);
          await boundedHoldReadiness(c,plan,g,x=>errorGroupApproval(plan,approval,x),options);
        },
        checkCatalog:targetedCatalogCheck(group),
        assertFrozen:async()=>{await assertFrozen();await checkGroup();}});
      console.log(JSON.stringify({phase:'group_completed',group:group.groupIndex+1,totalGroups:plan.groups.length}));
    }
    const c=await pool.connect();
    try{
      await c.query('BEGIN READ ONLY');await assertErrorHistory(c,plan,true);
      const snapshot=await sourceChannelSnapshot(c,plan);assert.equal(snapshot.runs.length,plan.groups.length);
      let paid=0,held=0,unspent=0;
      for(const g of plan.groups){
        assert.equal(snapshot.runs.find(r=>r.id===g.id)?.status,'completed');
        const rows=snapshot.admissions.filter(a=>a.run_id===g.id);
        await verifyCompletedHoldGroup(plan,g,rows);paid+=rows.length;
        const result=await read(root+'/part-'+(g.groupIndex+1)+'/returns.json');
        held+=result.returns.filter(r=>r.held).length;unspent+=result.returns.filter(r=>!r.paid).length;
      }
      assert.equal(paid+unspent,plan.maximumCalls);assert.ok(plan.priorReservedCents+paid*2<=plan.combinedCapCents);
      await c.query('COMMIT');
      await durableStageFile(root+'/summary.json',JSON.stringify({status:'completed',newPaidChecks:paid,
        newHeldChecks:held,unspentHeldChecks:unspent,previousServerErrors:1,noErrorRetries:true,
        reservedCents:plan.priorReservedCents+paid*2,combinedCapCents:plan.combinedCapCents,
        ownershipAccepted:0,catalogWrites:0,modelCalls:0,paidReplays:0}));
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
