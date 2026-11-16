// Fresh exact scope only. Preparation never invokes this dispatch mode.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {accountedChannelPlan,approveAccountedChannels} from './youtube-accounted-channel-plan.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {videoIdentitySchema} from './youtube-video-identity-gate.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function assertAccountedChannelFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.equal(plan.sourceRoot,root);
  assert.deepEqual(accountedChannelPlan(plan),plan);
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries(plan.runtimeFiles))
    assert.equal(digest(await fs.readFile(root+'/'+name)),sha);
  for(const [file,sha] of Object.entries(plan.sourceFiles)){
    assert.equal(await fs.realpath(file),path.resolve(file),'Symlink evidence is not allowed');
    assert.equal(digest(await fs.readFile(file)),sha,'Changed source: '+file);
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-accounted-channel-checks-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertAccountedChannelFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveAccountedChannels(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');
  const approvalCheck=(p,a)=>assert.deepEqual(approveAccountedChannels(p,a),a);
  approvalCheck(plan,approval);
  // Fail before setup or dispatch if this one-shot runner has been attempted.
  await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const pool=await connectSavedBatchPool();
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [MIXED_PARENT])).rows[0]?.status,'stopped');
      await accountedChannelReadiness(c,plan,{preparationOnly:true});
      await c.query(videoIdentitySchema);await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    await executeMixedCaptures({root,plan,approval,pool,approvalCheck,
      readinessCheck:accountedChannelReadiness,checkCatalog:identityCatalogCheck(plan),
      credential:process.env.SCRAPECREATORS_API_KEY,
      assertFrozen:async()=>{
        await assertAccountedChannelFrozen(root,plan);assert.deepEqual(await read(root+'/approval.json'),approval);
      }});
    await durableStageFile(root+'/summary.json',JSON.stringify({id,status:'completed',
      channelChecks:plan.maximumCalls,maximumSpendCents:plan.maximumSpendCents,
      uploaderCalls:0,modelCalls:0,catalogWrites:0,ownershipAccepted:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
