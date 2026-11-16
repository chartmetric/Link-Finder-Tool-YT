import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {accountedChannelGroups,approveAccountedGroups,groupApproval,accountedGroupReadiness,
  assertZeroOriginalChannelAttempt} from './youtube-accounted-channel-groups.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function assertAccountedGroupsFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(accountedChannelGroups(plan),plan);
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(root+'/'+name)),sha);
  for(const [file,sha] of Object.entries(plan.sourceFiles)){
    assert.equal(await fs.realpath(file),path.resolve(file));assert.equal(digest(await fs.readFile(file)),sha);
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-accounted-channel-groups-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertAccountedGroupsFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveAccountedGroups(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
  const approval=await read(root+'/approval.json');
  assert.deepEqual(approveAccountedGroups(plan,approval),approval);
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const pool=await connectSavedBatchPool();
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [MIXED_PARENT])).rows[0]?.status,'stopped');
      await assertZeroOriginalChannelAttempt(c,plan);
      assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
        [plan.groups.map(g=>g.id)])).rows[0].n,0,'Cannot replay a group');
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    let completed=0;
    for(const group of plan.groups){
      await assertAccountedGroupsFrozen(root,plan);
      const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);
      const a=groupApproval(plan,approval,group);
      await durableStageFile(folder+'/plan.json',JSON.stringify(group,null,2));
      await durableStageFile(folder+'/approval.json',JSON.stringify(a,null,2));
      await executeMixedCaptures({root:folder,plan:group,approval:a,pool,
        approvalCheck:(p,b)=>{assert.deepEqual(p,group);assert.deepEqual(b,groupApproval(plan,approval,group));},
        readinessCheck:(c,p,options)=>accountedGroupReadiness(c,plan,p,options),
        checkCatalog:identityCatalogCheck(group),credential:process.env.SCRAPECREATORS_API_KEY,
        assertFrozen:async()=>{
          await assertAccountedGroupsFrozen(root,plan);
          assert.deepEqual(await read(root+'/approval.json'),approval);
          assert.deepEqual(await read(folder+'/plan.json'),group);assert.deepEqual(await read(folder+'/approval.json'),a);
        }});
      completed+=group.maximumCalls;
      console.log(JSON.stringify({phase:'accounted_channel_groups',completed,total:plan.maximumCalls}));
    }
    await durableStageFile(root+'/summary.json',JSON.stringify({id,status:'completed',channelChecks:completed,
      maximumSpendCents:plan.maximumSpendCents,modelCalls:0,uploaderCalls:0,catalogWrites:0,ownershipAccepted:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
