import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {holdChannelPlan,approveHoldChannels,holdGroupApproval} from './youtube-channel-hold-continuation.mjs';
import {sourceChannelSnapshot,verifySourceChannelReceipts} from './youtube-channel-fast-live.mjs';
import {channelSuffix} from './youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async p=>JSON.parse(await fs.readFile(p));
export function previousFastGroups(plan){
  return {id:plan.predecessor.id,groups:channelSuffix(plan.predecessor,plan.cutover.snapshot).groups};
}
export async function assertHoldHistory(c,plan,recovered){
  assert.deepEqual(await sourceChannelSnapshot(c,plan.predecessor.sourcePlan),plan.originalSnapshot);
  assert.deepEqual(await sourceChannelSnapshot(c,previousFastGroups(plan)),
    recovered?plan.projectedSnapshot:plan.fastSnapshot);
}
export async function verifyHoldReceipts(plan){
  await verifySourceChannelReceipts(plan.predecessor.sourcePlan,plan.originalSnapshot);
  await verifySourceChannelReceipts(previousFastGroups(plan),plan.projectedSnapshot);
}
export async function holdReadiness(c,plan,approval,group,{ownRun=false}={}){
  await assertHoldHistory(c,plan,true);
  await accountedChannelReadiness(c,group,{ownRun,holdIdentityConflicts:true});
  const snapshot=await sourceChannelSnapshot(c,plan);
  let spent=plan.priorReservedCents;
  for(const run of snapshot.runs){
    const g=plan.groups.find(g=>g.id===run.id);assert.ok(g&&g.groupIndex<=group.groupIndex);
    const a=holdGroupApproval(plan,approval,g),rows=snapshot.admissions.filter(r=>r.run_id===run.id);
    for(const [k,v] of Object.entries({plan_sha256:digest(g),approval_sha256:digest(a),
      execution_sha256:digest(g.runtimeFiles),cap_cents:g.maximumSpendCents,reserved_cents:rows.length*2}))
      assert.equal(run[k],v);
    assert.ok(run.reserved_cents<=run.cap_cents);spent+=run.reserved_cents;
    if(g.groupIndex===group.groupIndex)assert.ok(ownRun&&run.status==='running');
    else{
      assert.equal(run.status,'completed');
      await verifyCompletedHoldGroup(plan,g,rows);
    }
  }
  for(const g of plan.groups.slice(0,group.groupIndex))
    assert.ok(snapshot.runs.some(r=>r.id===g.id&&r.status==='completed'));
  assert.ok(spent<=plan.combinedCapCents);
  for(const row of snapshot.admissions){
    const g=plan.groups.find(g=>g.id===row.run_id),op=g?.operations.find(o=>o.key===row.operation_key);assert.ok(op);
    for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
      channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,
      reserved_cents:2,status:'returned',http_status:200}))assert.equal(row[k],v);
    assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(row.raw_sha256,/^[a-f0-9]{64}$/);
  }
}
export async function verifyCompletedHoldGroup(plan,group,rows){
  const folder='generated-artifacts/'+plan.id+'/part-'+(group.groupIndex+1);
  const result=await read(folder+'/returns.json');
  assert.equal(result.planSha256,digest(group));assert.equal(result.returns.length,group.operations.length);
  for(const [i,op] of group.operations.entries()){
    const outcome=result.returns[i],row=rows.find(r=>r.operation_key===op.key);
    assert.equal(outcome.operationKey,op.key);assert.equal(outcome.ownershipAccepted,false);
    assert.equal(outcome.importEligible,false);
    if(outcome.paid){
      assert.ok(row);assert.equal(digest(outcome.receipt),row.receipt_sha256);
      const raw=await fs.readFile(folder+'/receipts/'+digest(op.key)+'.raw');assert.equal(digest(raw),row.raw_sha256);
    }else assert.ok(!row&&outcome.held);
    if(outcome.held){
      assert.equal(outcome.capture,null);
      assert.equal(outcome.heldEvidencePath,'receipts/'+digest(op.key)+'.held.json');
      const hold=await read(folder+'/'+outcome.heldEvidencePath);
      assert.equal(hold.operationKey,op.key);assert.equal(hold.paid,outcome.paid);
      assert.equal(hold.importEligible,false);assert.equal(hold.ownershipAccepted,false);assert.ok(hold.conflicts.length);
    }
  }
  assert.equal(rows.length,result.returns.filter(r=>r.paid).length);
}
export async function applyHoldRecovery(pool,plan,root,assertFrozen){
  await assertFrozen();await verifyHoldReceipts(plan);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[MIXED_PARENT])).rows[0]?.status,'stopped');
    await assertHoldHistory(c,plan,false);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await sourceChannelSnapshot(c,plan)).runs.length,0);
    const r=plan.recovery;
    await durableStageFile(root+'/recovery-applied.json',JSON.stringify({
      planSha256:digest(plan),runId:r.runId,operationKey:r.operationKey,transportReceivedOnly:true,
      ownershipAccepted:false,importEligible:false,priorHeldResponse:plan.cutover.heldResponse,
      heldEvidence:r,at:new Date().toISOString()},null,2));
    assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
      receipt_sha256=$3,raw_sha256=$4,http_status=200 WHERE run_id=$1 AND operation_key=$2
      AND status='admitted' AND receipt_sha256 IS NULL AND raw_sha256 IS NULL AND http_status IS NULL`,
    [r.runId,r.operationKey,r.receiptSha256,r.rawSha256])).rowCount,1);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function holdFrozenCheck(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  deepFreeze(plan);assert.deepEqual(holdChannelPlan(plan),plan);
  const files={...plan.sourceFiles,...extras,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json'))};
  assert.deepEqual(await read(root+'/plan.json'),plan);
  for(const [file,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+file]=sha;
  const verify=frozenFileVerifier(files);await verify();return verify;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-channel-hold-continuation-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  let assertFrozen=await holdFrozenCheck(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveHoldChannels(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');assert.deepEqual(approveHoldChannels(plan,approval),approval);
  deepFreeze(approval);
  assertFrozen=await holdFrozenCheck(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const pool=await connectSavedBatchPool();
  try{
    await applyHoldRecovery(pool,plan,root,assertFrozen);
    assertFrozen=await holdFrozenCheck(root,plan,Object.fromEntries(await Promise.all(
      ['approval.json','recovery-applied.json'].map(async f=>[root+'/'+f,digest(await fs.readFile(root+'/'+f))]))));
    console.log(JSON.stringify({phase:'saved_receipt_held',remaining:plan.maximumCalls,maximumRemainingCents:plan.maximumSpendCents}));
    for(const group of plan.groups){
      await assertFrozen();const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);
      const a=holdGroupApproval(plan,approval,group);
      await durableStageFile(folder+'/plan.json',JSON.stringify(group,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      const verifyGroup=frozenFileVerifier(Object.fromEntries(await Promise.all(
        ['plan.json','approval.json'].map(async f=>[folder+'/'+f,digest(await fs.readFile(folder+'/'+f))]))));
      await executeMixedCaptures({root:folder,plan:group,approval:a,pool,targetCatalogChecks:true,holdIdentityConflicts:true,
        credential:process.env.SCRAPECREATORS_API_KEY,
        approvalCheck:(g,b)=>{assert.deepEqual(g,group);assert.deepEqual(b,holdGroupApproval(plan,approval,group));},
        readinessCheck:(c,g,options)=>holdReadiness(c,plan,approval,g,options),
        checkCatalog:targetedCatalogCheck(group),
        assertFrozen:async()=>{await assertFrozen();await verifyGroup();}});
      console.log(JSON.stringify({phase:'group_completed',group:group.groupIndex+1,totalGroups:plan.groups.length}));
    }
    const c=await pool.connect();
    try{
      await c.query('BEGIN READ ONLY');
      await assertHoldHistory(c,plan,true);
      const snapshot=await sourceChannelSnapshot(c,plan);
      assert.equal(snapshot.runs.length,plan.groups.length);
      let held=2,paid=0,unspent=0;
      for(const group of plan.groups){
        assert.equal(snapshot.runs.find(r=>r.id===group.id)?.status,'completed');
        const rows=snapshot.admissions.filter(r=>r.run_id===group.id);
        await verifyCompletedHoldGroup(plan,group,rows);paid+=rows.length;
        const result=await read(root+'/part-'+(group.groupIndex+1)+'/returns.json');
        held+=result.returns.filter(r=>r.held).length;unspent+=result.returns.filter(r=>!r.paid).length;
      }
      assert.equal(paid+unspent,plan.maximumCalls);
      assert.ok(plan.priorReservedCents+paid*2<=plan.combinedCapCents);
      await c.query('COMMIT');
      await durableStageFile(root+'/summary.json',JSON.stringify({status:'completed',newPaidChecks:paid,
        heldIncludingPrior:held,unspentHeldChecks:unspent,reservedCents:plan.priorReservedCents+paid*2,
        combinedCapCents:plan.combinedCapCents,ownershipAccepted:0,catalogWrites:0,modelCalls:0,paidReplays:0}));
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
