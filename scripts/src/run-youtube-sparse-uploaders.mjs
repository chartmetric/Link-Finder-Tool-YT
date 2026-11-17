// New sealed runtime only. No legacy uploader proposal validator is bypassed or modified.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveVideoStage} from './youtube-video-stage.mjs';
import {uploaderConflictHandlingApproval} from './youtube-uploader-conflict-handling.mjs';
import {executeVideoStage,durableStageFile} from './youtube-video-stage-execution.mjs';
import {SPARSE_ID,json,assertSourceFiles,validateSparseReceipts,assertUploaderIdle,
  historicalUploaderConflict,uploaderCoordinatorSnapshot} from './youtube-sparse-uploader-source.mjs';
import {sparseUploaderPlan,approveSparseUploaders} from './youtube-sparse-uploader-plan.mjs';
import {sparseUploaderGate} from './youtube-sparse-uploader-gate.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

export async function assertSparseFrozen(root,plan){
  assert.deepEqual(sparseUploaderPlan(plan),plan);
  assert.equal(digest(await json(root+'/plan.json')),digest(plan));
  for(const part of [{folder:root,plan},...plan.children.map(c=>({folder:'generated-artifacts/'+c.id,plan:c.plan}))]){
    assert.equal(digest(await json(part.folder+'/plan.json')),digest(part.plan));
    for(const [file,sha] of Object.entries({...part.plan.evidenceFiles,...part.plan.runtimeFiles}))
      assert.equal(digest(await fs.readFile(part.folder+'/'+file)),sha,'Changed frozen evidence/runtime: '+file);
  }
  const sources=await json(root+'/evidence/source-bindings.json');
  assert.equal(digest(sources.parent),plan.sourcePlanSha256);
  await assertSourceFiles(sources.sourceFiles);
  const snapshot=(await json(root+'/evidence/readiness.json')).snapshot;
  for(const child of plan.children)for(const artist of child.plan.artists){
    const c=sources.cases.find(c=>c.profileId===artist.profileId&&c.cmArtist===artist.cmArtist);
    assert.ok(c&&!c.directSelected&&c.resolutionQueue.length&&!historicalUploaderConflict(c,snapshot.history));
    assert.deepEqual(child.plan.operations.filter(o=>o.profileId===c.profileId),c.resolutionQueue.map(v=>({
      profileId:c.profileId,cmArtist:c.cmArtist,kind:'video_uploader',key:v.operation.key,videoId:v.videoId,
      videoUrl:v.url,request:v.operation.request,inputSha256:digest(v.operation.request),reservationCents:2,
    })));
  }
  return sources;
}
export async function sparseReadiness(pool,sources,child){
  const eligible=await currentEligible(child.plan.artists);
  assert.ok(child.plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Eligibility changed; prepare a new exact scope, never substitute');
  const c=await pool.connect();
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assertUploaderIdle(c);
    const snapshot=await uploaderCoordinatorSnapshot(c);
    await validateSparseReceipts(sources,snapshot);
    for(const a of child.plan.artists){
      const source=sources.cases.find(c=>c.profileId===a.profileId);
      assert.ok(!historicalUploaderConflict(source,snapshot.history),'Historical uploader allocation');
    }
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function absent(file){
  try{await fs.lstat(file);assert.fail('Existing approval/attempt cannot be overwritten');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:plan-sha256|approve-cents)=[a-z0-9]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));
  assert.equal(modes.length,1);
  const root='generated-artifacts/'+SPARSE_ID,plan=await json(root+'/plan.json');
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use newly sealed aggregate runtime');
  const sources=await assertSparseFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    await absent(root+'/approval.json');await absent(root+'/run-started.json');
    const approval=approveSparseUploaders(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await json(root+'/approval.json');
  assert.deepEqual(approveSparseUploaders(plan,approval),approval);
  await absent(root+'/run-started.json');
  const pool=await connectSavedBatchPool();
  try{
    // Validate the whole proposed cohort before creating a one-shot attempt.
    for(const child of plan.children)await sparseReadiness(pool,sources,child);
    await durableStageFile(root+'/run-started.json',JSON.stringify({at:new Date().toISOString(),planSha256:digest(plan)}));
    for(const child of plan.children){
      await sparseReadiness(pool,sources,child);
      const a=approveVideoStage(child.plan,{expectedPlanSha256:child.planSha256,
        capCents:child.capCents,approvedAt:approval.approvedAt});
      const gate=sparseUploaderGate({pool,plan:child.plan,approval:a,owner:randomUUID()});
      await executeVideoStage({root:'generated-artifacts/'+child.id,plan:child.plan,approval:a,gate,
        credential:process.env.SCRAPECREATORS_API_KEY,
        conflictHandlingApproval:uploaderConflictHandlingApproval(child.plan,a),
        assertFrozen:async()=>{
          await assertSparseFrozen(root,plan);
          assert.equal(digest(await json(root+'/approval.json')),digest(approval));
          const eligible=await currentEligible(child.plan.artists);
          assert.ok(child.plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Eligibility changed');
        }});
    }
    await durableStageFile(root+'/summary.json',JSON.stringify({id:plan.id,status:'completed',
      uploaderCalls:plan.maximumCalls,maximumSpendCents:plan.maximumSpendCents,searchCalls:0,
      channelCalls:0,modelCalls:0,acceptedArtistChannels:0,catalogWrites:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
