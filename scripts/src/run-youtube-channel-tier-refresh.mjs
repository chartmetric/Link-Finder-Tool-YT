import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {tierRefreshPlan,approveTierRefresh,tierGroupApproval} from './youtube-channel-tier-refresh.mjs';
import {assertErrorHistory,verifyErrorReceipts} from './run-youtube-channel-error-continuation.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {boundedHoldReadiness} from './run-youtube-channel-speed-switch.mjs';
import {verifyCompletedHoldGroup} from './run-youtube-channel-hold-continuation.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function tierHistory(c,plan){
  await assertErrorHistory(c,plan.sourcePlan,true);
  assert.deepEqual(await sourceChannelSnapshot(c,plan.sourcePlan),{runs:[],admissions:[]});
}
export async function tierFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'));
  deepFreeze(plan);assert.deepEqual(tierRefreshPlan(plan),plan);
  assert.deepEqual(await read(root+'/plan.json'),plan);
  const files={...plan.sourceFiles,...extras,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json'))};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const check=frozenFileVerifier(files);await check();return check;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-channel-tier-refresh-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  let check=await tierFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveTierRefresh(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await read(root+'/approval.json'));
  assert.deepEqual(approveTierRefresh(plan,approval),approval);
  check=await tierFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  await verifyErrorReceipts(plan.sourcePlan);
  const pool=await connectSavedBatchPool();
  try{
    for(const g of plan.groups){
      await check();const folder=root+'/part-'+(g.groupIndex+1);await fs.mkdir(folder);
      const a=tierGroupApproval(plan,approval,g);
      await durableStageFile(folder+'/plan.json',JSON.stringify(g,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      const groupCheck=frozenFileVerifier(Object.fromEntries(await Promise.all(
        ['plan.json','approval.json'].map(async f=>[folder+'/'+f,digest(await fs.readFile(folder+'/'+f))]))));
      await executeMixedCaptures({root:folder,plan:g,approval:a,pool,targetCatalogChecks:true,holdIdentityConflicts:true,
        credential:process.env.SCRAPECREATORS_API_KEY,
        approvalCheck:(p,a)=>{assert.deepEqual(p,g);assert.deepEqual(a,tierGroupApproval(plan,approval,g));},
        readinessCheck:async(c,p,options)=>{await tierHistory(c,plan);
          await boundedHoldReadiness(c,plan,p,x=>tierGroupApproval(plan,approval,x),options);},
        checkCatalog:targetedCatalogCheck(g),assertFrozen:async()=>{await check();await groupCheck();}});
      console.log(JSON.stringify({phase:'group_completed',group:g.groupIndex+1,totalGroups:plan.groups.length}));
    }
    const c=await pool.connect();
    try{
      await c.query('BEGIN READ ONLY');await tierHistory(c,plan);
      const snapshot=await sourceChannelSnapshot(c,plan);
      assert.equal(snapshot.runs.length,plan.groups.length);
      let paid=0,held=0,unspent=0;
      for(const g of plan.groups){
        const rows=snapshot.admissions.filter(a=>a.run_id===g.id);
        assert.equal(snapshot.runs.find(r=>r.id===g.id)?.status,'completed');
        await verifyCompletedHoldGroup(plan,g,rows);paid+=rows.length;
        const result=await read(root+'/part-'+(g.groupIndex+1)+'/returns.json');
        held+=result.returns.filter(r=>r.held).length;unspent+=result.returns.filter(r=>!r.paid).length;
      }
      assert.equal(paid+unspent,plan.maximumCalls);assert.ok(plan.priorReservedCents+paid*2<=plan.combinedCapCents);
      await c.query('COMMIT');
      await durableStageFile(root+'/summary.json',JSON.stringify({status:'completed',newPaidChecks:paid,
        newHeldChecks:held,unspentHeldChecks:unspent,reservedCents:plan.priorReservedCents+paid*2,
        combinedCapCents:plan.combinedCapCents,ownershipAccepted:0,catalogWrites:0,modelCalls:0,paidReplays:0}));
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
