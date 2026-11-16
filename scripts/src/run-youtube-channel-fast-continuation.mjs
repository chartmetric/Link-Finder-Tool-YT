import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {fastChannelPlan,approveFastChannels,channelSuffix,fastGroupApproval} from './youtube-channel-fast-continuation.mjs';
import {handoverChannels,fastChannelReadiness} from './youtube-channel-fast-live.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);for(const v of Object.values(value))deepFreeze(v);
  }return value;
}
export async function makeFastFrozenCheck(root,plan,extraFiles={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(fastChannelPlan(plan),plan);
  const raw=await fs.readFile(root+'/plan.json');assert.deepEqual(JSON.parse(raw),plan);
  deepFreeze(plan);
  const files={...plan.sourceFiles,[root+'/plan.json']:digest(raw),...extraFiles};
  for(const [file,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+file]=sha;
  const verify=frozenFileVerifier(files);await verify();return verify;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-channel-fast-continuation-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  let assertFrozen=await makeFastFrozenCheck(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveFastChannels(plan,{planSha256:value('plan-sha256'),
      combinedCapCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');assert.deepEqual(approveFastChannels(plan,approval),approval);
  deepFreeze(approval);
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const pool=await connectSavedBatchPool();
  try{
    // All new run IDs must be untouched before the controlled handover.
    const c=await pool.connect();
    try{
      await c.query('BEGIN READ ONLY');
      assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
        [Array.from({length:Math.ceil(plan.maximumCalls/20)},(_,i)=>plan.id+'-part-'+(i+1))])).rows[0].n,0);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    const cutover=await handoverChannels({pool,plan,root,assertFrozen}),suffix=channelSuffix(plan,cutover.snapshot);
    deepFreeze(cutover);deepFreeze(suffix);
    const extraFiles={};
    for(const file of ['approval.json','cutover.json'])
      extraFiles[root+'/'+file]=digest(await fs.readFile(root+'/'+file));
    assertFrozen=await makeFastFrozenCheck(root,plan,extraFiles);
    let completed=cutover.paidCount;
    console.log(JSON.stringify({phase:'safe_handover',previouslyCompleted:completed,
      remaining:suffix.pendingCount,combinedCapCents:plan.combinedMaximumSpendCents}));
    for(const group of suffix.groups){
      await assertFrozen();
      const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);
      const a=fastGroupApproval(plan,approval,cutover,group);
      await durableStageFile(folder+'/plan.json',JSON.stringify(group,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      const groupFiles={};
      for(const file of ['plan.json','approval.json'])groupFiles[folder+'/'+file]=digest(await fs.readFile(folder+'/'+file));
      const verifyGroup=frozenFileVerifier(groupFiles);
      await executeMixedCaptures({root:folder,plan:group,approval:a,pool,targetCatalogChecks:true,
        approvalCheck:(p,b)=>{assert.deepEqual(p,group);assert.deepEqual(b,fastGroupApproval(plan,approval,cutover,group));},
        readinessCheck:(c,p,options)=>fastChannelReadiness(c,plan,cutover,suffix,p,options),
        checkCatalog:targetedCatalogCheck(group),credential:process.env.SCRAPECREATORS_API_KEY,
        assertFrozen:async()=>{await assertFrozen();await verifyGroup();}});
      completed+=group.maximumCalls;
      console.log(JSON.stringify({phase:'fast_channel_checks',completed,total:plan.maximumCalls}));
    }
    await durableStageFile(root+'/summary.json',JSON.stringify({id,status:'completed',
      channelChecks:completed,previouslyCompleted:cutover.paidCount,newlyCompleted:suffix.pendingCount,
      combinedMaximumCents:plan.combinedMaximumSpendCents,modelCalls:0,uploaderCalls:0,catalogWrites:0,
      paidReplays:0,ownershipAccepted:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
