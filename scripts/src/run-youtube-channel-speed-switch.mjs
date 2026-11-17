import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {speedSwitchPlan,approveSpeedSwitch,speedSuffix,speedGroupApproval} from './youtube-channel-speed-switch.mjs';
import {sourceChannelSnapshot,verifySourceChannelReceipts} from './youtube-channel-fast-live.mjs';
import {assertHoldHistory,verifyCompletedHoldGroup} from './run-youtube-channel-hold-continuation.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {assertZeroOriginalChannelAttempt} from './youtube-accounted-channel-groups.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function readSourceHolds(source){
  const holds=[],files={};
  for(const group of source.groups){
    const folder='generated-artifacts/'+source.id+'/part-'+(group.groupIndex+1);
    for(const op of group.operations){
      const file=folder+'/receipts/'+digest(op.key)+'.held.json';
      let raw;
      try{raw=await fs.readFile(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      const h=JSON.parse(raw);
      assert.equal(h.operationKey,op.key);assert.equal(h.profileId,op.profileId);assert.equal(h.cmArtist,op.cmArtist);
      assert.equal(h.ownershipAccepted,false);assert.equal(h.importEligible,false);
      assert.equal(typeof h.paid,'boolean');assert.ok(h.conflicts.length);
      if(!h.paid)assert.equal(h.capture,null);
      files[file]=digest(raw);holds.push({...h,runId:group.id});
    }
  }
  return {holds,files};
}
export async function speedFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  deepFreeze(plan);assert.deepEqual(speedSwitchPlan(plan),plan);
  assert.deepEqual(await read(root+'/plan.json'),plan);
  const files={...plan.sourceFiles,...extras,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json'))};
  for(const [file,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+file]=sha;
  const verify=frozenFileVerifier(files);await verify();return verify;
}
export async function switchAtBoundary({pool,plan,root,assertFrozen,waitMs=240000,
  delay=ms=>new Promise(r=>setTimeout(r,ms)),checkHistory=assertHoldHistory,
  verifyReceipts=verifySourceChannelReceipts,deriveSuffix=speedSuffix}){
  const start=Date.now(),source=plan.sourcePlan;
  for(;;){
    await assertFrozen();const c=await pool.connect();let waiting=false;
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[MIXED_PARENT])).rows[0]?.status,'stopped');
      await assertZeroOriginalChannelAttempt(c,source.predecessor.sourcePlan);
      await checkHistory(c,source,true);
      const snapshot=await sourceChannelSnapshot(c,source),ids=source.groups.map(g=>g.id);
      assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_runs
        WHERE status='running' AND id<>ALL($1::text[])`,[ids])).rows[0].n,0);
      assert.equal((await sourceChannelSnapshot(c,{groups:Array.from(
        {length:Math.ceil(plan.maximumPotentialCalls/20)},(_,i)=>({id:plan.id+'-part-'+(i+1)}))})).runs.length,0);
      assert.ok(snapshot.runs.filter(r=>r.status==='running').length<=1);
      const betweenGroups=!snapshot.runs.some(r=>r.status==='running'||r.status==='stopped')
        &&snapshot.runs.filter(r=>r.status==='completed').length<source.groups.length;
      if(snapshot.admissions.some(a=>a.status!=='returned')||betweenGroups){
        await c.query('ROLLBACK');waiting=true;
      }else{
        const running=snapshot.runs.find(r=>r.status==='running'),fenced=structuredClone(snapshot);
        if(running)fenced.runs.find(r=>r.id===running.id).status='stopped';
        const {holds,files}=await readSourceHolds(source);
        const suffix=deriveSuffix(plan,deepFreeze(fenced),deepFreeze(holds));
        await verifyReceipts(source,fenced);
        for(const run of fenced.runs){
          const g=source.groups.find(g=>g.id===run.id),folder='generated-artifacts/'+source.id+'/part-'+(g.groupIndex+1);
          for(const name of ['plan.json','approval.json'])files[folder+'/'+name]=digest(await fs.readFile(folder+'/'+name));
          assert.deepEqual(await read(folder+'/plan.json'),g);
          for(const row of fenced.admissions.filter(a=>a.run_id===run.id)){
            for(const ext of ['json','raw']){
              const f=folder+'/receipts/'+digest(row.operation_key)+'.'+ext;files[f]=digest(await fs.readFile(f));
            }
          }
          if(run.status==='completed')await verifyCompletedHoldGroup(source,g,
            fenced.admissions.filter(a=>a.run_id===run.id));
        }
        const cutover={planSha256:digest(plan),snapshot:fenced,holds,files,
          at:new Date().toISOString(),priorReservedCents:suffix.priorReservedCents,
          remaining:suffix.remaining,maximumRemainingCents:suffix.maximumRemainingCents,
          noRequestsInFlight:true,noPaidReplays:true};
        await durableStageFile(root+'/cutover.json',JSON.stringify(cutover,null,2));
        if(running)assert.equal((await c.query(`UPDATE youtube_video_identity_runs SET status='stopped'
          WHERE id=$1 AND owner=$2 AND status='running'`,[running.id,running.owner])).rowCount,1);
        await c.query('COMMIT');return deepFreeze(cutover);
      }
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    assert.ok(waiting&&Date.now()-start<waitMs,'Unacknowledged request blocks the switch; no paid request repeated');
    await delay(1000);
  }
}
export async function speedReadiness(c,plan,approval,cutover,suffix,group,{ownRun=false}={}){
  await assertHoldHistory(c,plan.sourcePlan,true);
  await assertZeroOriginalChannelAttempt(c,plan.sourcePlan.predecessor.sourcePlan);
  assert.deepEqual(await sourceChannelSnapshot(c,plan.sourcePlan),cutover.snapshot);
  await boundedHoldReadiness(c,{id:plan.id,groups:suffix.groups,priorReservedCents:cutover.priorReservedCents,
    combinedCapCents:plan.combinedCapCents},group,g=>speedGroupApproval(plan,approval,cutover,g),{ownRun});
}
export async function boundedHoldReadiness(c,context,group,approvalFor,{ownRun=false}={}){
  await accountedChannelReadiness(c,group,{ownRun,holdIdentityConflicts:true});
  const snapshot=await sourceChannelSnapshot(c,{groups:context.groups});
  let spent=context.priorReservedCents;
  for(const run of snapshot.runs){
    const g=context.groups.find(g=>g.id===run.id);assert.ok(g&&g.groupIndex<=group.groupIndex);
    const a=approvalFor(g),rows=snapshot.admissions.filter(r=>r.run_id===run.id);
    for(const [k,v] of Object.entries({plan_sha256:digest(g),approval_sha256:digest(a),
      execution_sha256:digest(g.runtimeFiles),cap_cents:g.maximumSpendCents,reserved_cents:rows.length*2}))
      assert.equal(run[k],v);
    assert.ok(run.reserved_cents<=run.cap_cents);spent+=run.reserved_cents;
    if(g.groupIndex===group.groupIndex)assert.ok(ownRun&&run.status==='running');
    else{
      assert.equal(run.status,'completed');
      await verifyCompletedHoldGroup({id:context.id},g,rows);
    }
  }
  for(const g of context.groups.slice(0,group.groupIndex))assert.ok(snapshot.runs.some(r=>r.id===g.id&&r.status==='completed'));
  assert.ok(spent<=context.combinedCapCents);
  for(const row of snapshot.admissions){
    const g=context.groups.find(g=>g.id===row.run_id),op=g?.operations.find(o=>o.key===row.operation_key);assert.ok(op);
    for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
      channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,
      reserved_cents:2,status:'returned',http_status:200}))assert.equal(row[k],v);
    assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(row.raw_sha256,/^[a-f0-9]{64}$/);
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-channel-speed-switch-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  let assertFrozen=await speedFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveSpeedSwitch(plan,{planSha256:value('plan-sha256'),
      combinedCapCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await read(root+'/approval.json'));
  assert.deepEqual(approveSpeedSwitch(plan,approval),approval);
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  assertFrozen=await speedFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  const pool=await connectSavedBatchPool();
  try{
    const cutover=await switchAtBoundary({pool,plan,root,assertFrozen});
    const suffix=speedSuffix(plan,cutover.snapshot,cutover.holds);
    const extras={...cutover.files};
    for(const f of ['approval.json','cutover.json'])extras[root+'/'+f]=digest(await fs.readFile(root+'/'+f));
    assertFrozen=await speedFrozen(root,plan,extras);
    console.log(JSON.stringify({phase:'speed_switch',remaining:suffix.remaining,
      maximumRemainingCents:suffix.maximumRemainingCents,combinedCapCents:plan.combinedCapCents}));
    for(const group of suffix.groups){
      await assertFrozen();const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);
      const a=speedGroupApproval(plan,approval,cutover,group);
      await durableStageFile(folder+'/plan.json',JSON.stringify(group,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      const groupVerify=frozenFileVerifier(Object.fromEntries(await Promise.all(
        ['plan.json','approval.json'].map(async f=>[folder+'/'+f,digest(await fs.readFile(folder+'/'+f))]))));
      await executeMixedCaptures({root:folder,plan:group,approval:a,pool,targetCatalogChecks:true,holdIdentityConflicts:true,
        credential:process.env.SCRAPECREATORS_API_KEY,
        approvalCheck:(g,b)=>{assert.deepEqual(g,group);assert.deepEqual(b,speedGroupApproval(plan,approval,cutover,group));},
        readinessCheck:(c,g,options)=>speedReadiness(c,plan,approval,cutover,suffix,g,options),
        checkCatalog:targetedCatalogCheck(group),
        assertFrozen:async()=>{await assertFrozen();await groupVerify();}});
      console.log(JSON.stringify({phase:'group_completed',group:group.groupIndex+1,totalGroups:suffix.groups.length}));
    }
    const c=await pool.connect();
    try{
      await c.query('BEGIN READ ONLY');
      await assertHoldHistory(c,plan.sourcePlan,true);
      assert.deepEqual(await sourceChannelSnapshot(c,plan.sourcePlan),cutover.snapshot);
      const snapshot=await sourceChannelSnapshot(c,{groups:suffix.groups});
      assert.equal(snapshot.runs.length,suffix.groups.length);
      let paid=0,held=2+cutover.holds.length;
      for(const g of suffix.groups){
        assert.equal(snapshot.runs.find(r=>r.id===g.id)?.status,'completed');
        const rows=snapshot.admissions.filter(r=>r.run_id===g.id);
        await verifyCompletedHoldGroup({id:plan.id},g,rows);paid+=rows.length;
        const result=await read(root+'/part-'+(g.groupIndex+1)+'/returns.json');
        held+=result.returns.filter(r=>r.held).length;
      }
      assert.ok(cutover.priorReservedCents+paid*2<=plan.combinedCapCents);
      await c.query('COMMIT');
      await durableStageFile(root+'/summary.json',JSON.stringify({status:'completed',newPaidChecks:paid,
        heldIncludingPrior:held,reservedCents:cutover.priorReservedCents+paid*2,combinedCapCents:plan.combinedCapCents,
        ownershipAccepted:0,catalogWrites:0,modelCalls:0,paidReplays:0}));
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
