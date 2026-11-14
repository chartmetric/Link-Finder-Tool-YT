// Read-only catalog/coordinator inspection; writes a NEW local preparation
// only. Never acknowledges a receipt, authorizes spending or dispatches.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,SMALL_VIDEO_STAGE_POLICY,validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {validateConflictResponse,validateConflictRecovery,CONFLICT_RECOVERY_POLICY} from './youtube-uploader-conflict-recovery.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE} from './youtube-uploader-conflict-handling.mjs';

export async function prepareConflictRecovery(previousId,id,{holdChannelConflicts=false}={}){
  for(const value of [previousId,id])assert.match(value,/^youtube-video-review-[a-z0-9-]{4,80}$/);
  assert.notEqual(previousId,id);
  const source='generated-artifacts/'+previousId,root='generated-artifacts/'+id,sourceFiles={};
  const bytes=async name=>{const b=await fs.readFile(source+'/'+name);sourceFiles[name]=digest(b);return b;};
  const read=async name=>JSON.parse(await bytes(name));
  const previousPlan=await read('plan.json'),previousApproval=await read('approval.json'),previousSummary=await read('summary.json');
  validateVideoStagePlan(previousPlan);assertVideoStageApproval(previousPlan,previousApproval);
  assert.equal(previousPlan.id,previousId);assert.equal(previousSummary.status,'stopped');
  for(const [name,sha] of Object.entries({...previousPlan.evidenceFiles,...previousPlan.runtimeFiles}))
    assert.equal(digest(await bytes(name)),sha);
  const pool=await connectSavedBatchPool();let c,previousRun,admissions;
  try{
    c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    previousRun=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1',[previousId])).rows[0];
    admissions=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1 ORDER BY created_at,operation_key',[previousId])).rows;
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[previousPlan.parentId])).rows[0]?.status,'stopped');
    for(const sql of [
      "SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'",
      "SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'",
      "SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE status='admitted'",
      "SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'",
    ])assert.equal((await c.query(sql)).rows[0].n,0);
    const pending=(await c.query("SELECT run_id,operation_key FROM youtube_video_stage_admissions WHERE status='admitted'")).rows;
    assert.equal(pending.length,1);assert.equal(pending[0].run_id,previousId);
    await c.query('COMMIT');
  }catch(error){if(c)await c.query('ROLLBACK');throw error;}finally{c?.release();await pool.end();}
  const pending=admissions.filter(a=>a.status==='admitted');assert.equal(pending.length,1);
  const admitted=new Set(admissions.map(a=>a.operation_key));
  const remaining=previousPlan.operations.filter(o=>!admitted.has(o.key));
  assert.ok(remaining.length);
  const artists=previousPlan.artists.filter(a=>remaining.some(o=>o.profileId===a.profileId));
  const eligible=await currentEligible(artists);
  assert.ok(artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Remaining artist eligibility changed');
  let receipt,rawBody;
  for(const row of admissions){
    const op=previousPlan.operations.find(o=>o.key===row.operation_key);assert.ok(op);
    const saved=await read('receipts/'+digest(op.key)+'.json'),raw=await bytes(saved.rawPath);
    assert.equal(saved.runId,previousId);assert.equal(saved.planSha256,digest(previousPlan));
    assert.equal(saved.rawBodySha256,digest(raw));assert.equal(saved.inputSha256,op.inputSha256);
    if(row.status==='admitted'){receipt=saved;rawBody=raw;continue;}
    assert.equal(row.receipt_sha256,digest(saved));assert.equal(row.raw_sha256,digest(raw));
    const result=await read('results/'+digest(op.key)+'.json');
    const artistEvidence=await read('evidence/'+op.profileId+'.json');
    const clue=artistEvidence.videoPlan.resolutionQueue.find(v=>v.videoId===op.videoId);
    const mapped=mapSavedVideoUploader(artistEvidence.artist,clue,{...saved,rawBody:raw},
      {runId:previousId,planSha256:digest(previousPlan)});
    for(const [key,value] of Object.entries(mapped))assert.deepEqual(result[key],value);
    assert.equal(result.ownershipAccepted,false);
  }
  const pendingOp=previousPlan.operations.find(o=>o.key===pending[0].operation_key);
  const conflictReview=validateConflictResponse(pendingOp,receipt,rawBody);
  const evidence=JSON.parse(JSON.stringify({version:CONFLICT_RECOVERY_POLICY,continuationId:id,
    previousPlan,previousApproval,previousSummary,previousRun,admissions,sourceFiles,
    receipt,rawBodyBase64:rawBody.toString('base64'),conflictReview,
    reviewedAt:new Date().toISOString(),explicitApproval:false,executable:false}));
  for(const [name,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(source+'/'+name)),sha);
  await fs.mkdir(root);
  for(const dir of ['evidence','inputs','receipts','results'])await fs.mkdir(root+'/'+dir);
  const evidenceFiles={};
  for(const [name,sha] of Object.entries(previousPlan.evidenceFiles)){
    // Preserve the old manifest in sourceFiles, not as this run's recovery.
    // A new conflict policy must be explicitly requested, never inherited.
    if(name==='evidence/conflict-recovery.json'||name===CONFLICT_HANDLING_FILE)continue;
    const b=await fs.readFile(source+'/'+name);assert.equal(digest(b),sha);
    await durableStageFile(root+'/'+name,b);evidenceFiles[name]=sha;
  }
  const recoveryBytes=JSON.stringify(evidence);
  await durableStageFile(root+'/evidence/conflict-recovery.json',recoveryBytes);
  evidenceFiles['evidence/conflict-recovery.json']=digest(recoveryBytes);
  if(holdChannelConflicts){
    const policyBytes=JSON.stringify(CONFLICT_HANDLING_SCOPE);
    await durableStageFile(root+'/'+CONFLICT_HANDLING_FILE,policyBytes);
    evidenceFiles[CONFLICT_HANDLING_FILE]=digest(policyBytes);
  }
  const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'run-youtube-uploader-conflict-recovery.mjs');
  const modules=await freezeLocalModules(entry,root+'/runtime'),runtimeFiles={};
  for(const file of modules){const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));}
  const plan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id,preparedAt:new Date().toISOString(),
    sourceRunId:previousPlan.sourceRunId,sourcePlanSha256:previousPlan.sourcePlanSha256,
    artists,operations:remaining,evidenceFiles,runtimeFiles});
  const checked=validateConflictRecovery(plan,evidence);
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=remaining.map(o=>[artists.find(a=>a.profileId===o.profileId).name,o.profileId,o.cmArtist,
    o.videoUrl,2,'Untouched request — separate approval required']);
  await durableStageFile(root+'/remaining-requests.csv','\ufeff'+[
    ['artist','profile_id','cm_artist','video_url','reservation_cents','status'],...rows
  ].map(r=>r.map(cell).join(',')).join('\r\n'));
  return {status:'prepared_not_approved',id,...checked,maximumAdditionalUsd:plan.maximumSpendCents/100,
    planSha256:digest(plan),holdNewChannelConflicts:holdChannelConflicts,
    paidCalls:0,ledgerWrites:0,catalogWrites:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  assert.ok(args.length===3||args.length===4);assert.ok(args.includes('--prepare-only'));
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>['--prepare-only','--hold-channel-conflicts'].includes(a)
    ||/^--(?:id|previous-id)=youtube-video-review-[a-z0-9-]{4,80}$/.test(a)));
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  console.log(JSON.stringify(await prepareConflictRecovery(value('previous-id'),value('id'),
    {holdChannelConflicts:args.includes('--hold-channel-conflicts')})));
}
