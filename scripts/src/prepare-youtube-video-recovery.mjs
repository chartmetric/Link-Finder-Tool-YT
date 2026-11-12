// Offline preparation only: one saved first-response recovery and the 39 untouched requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {videoStagePlan,validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {validateVideoRecovery} from './youtube-video-stage-recovery.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function main(){
  const args=process.argv.slice(2);
  assert.equal(args.length,3);assert.ok(args.includes('--prepare-only'));
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,3);
  assert.ok(args.every(a=>a==='--prepare-only'||/^--(?:id|previous-id)=youtube-video-review-[a-z0-9-]{4,80}$/.test(a)));
  const value=key=>args.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3);
  const id=value('id'),previousId=value('previous-id');
  assert.ok(id&&previousId&&id!==previousId);assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const root='generated-artifacts/'+id,oldRoot='generated-artifacts/'+previousId;
  const previousPlan=await read(oldRoot+'/plan.json'),previousApproval=await read(oldRoot+'/approval.json');
  validateVideoStagePlan(previousPlan);assertVideoStageApproval(previousPlan,previousApproval);
  assert.equal(previousPlan.maximumCalls,40);assert.equal(previousPlan.maximumSpendCents,80);
  assert.equal(previousPlan.recovery,undefined);assert.equal((await read(oldRoot+'/summary.json')).status,'stopped');
  const pool=await connectSavedBatchPool();let oldRun,admission;
  try{
    oldRun=(await pool.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1',[previousId])).rows[0];
    assert.ok(oldRun&&oldRun.status==='stopped'&&oldRun.plan_sha256===digest(previousPlan)
      &&oldRun.approval_sha256===digest(previousApproval));
    assert.equal(oldRun.reserved_cents,2);
    const rows=(await pool.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1',[previousId])).rows;
    assert.equal(rows.length,1);admission=rows[0];assert.equal(admission.status,'admitted');
    assert.equal((await pool.query("SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'")).rows[0].n,0);
    const pending=(await pool.query("SELECT run_id,operation_key FROM youtube_video_stage_admissions WHERE status='admitted'")).rows;
    assert.equal(pending.length,1);assert.equal(pending[0].run_id,previousId);
    assert.equal((await pool.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[previousPlan.parentId])).rows[0]?.status,'stopped');
  }finally{await pool.end();}
  const op=previousPlan.operations.find(o=>o.key===admission.operation_key);
  assert.ok(op&&op.profileId===admission.profile_id&&op.cmArtist===admission.cm_artist
    &&op.videoId===admission.video_id&&op.inputSha256===admission.input_sha256);
  const receipt=await read(oldRoot+'/receipts/'+digest(op.key)+'.json');
  assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
  const rawBody=await fs.readFile(oldRoot+'/'+receipt.rawPath);
  const artistEvidence=await read(oldRoot+'/evidence/'+op.profileId+'.json');
  const clue=artistEvidence.videoPlan.resolutionQueue.find(v=>v.videoId===op.videoId);
  const mapped=mapSavedVideoUploader(artistEvidence.artist,clue,{...receipt,rawBody},
    {runId:previousId,planSha256:digest(previousPlan)});
  const evidence={previousPlan,previousApproval,receipt,rawBodyBase64:rawBody.toString('base64'),artistEvidence,mapped,
    reviewStatus:'Offline validated saved response; acknowledgment still requires recovery approval'};
  const eligible=await currentEligible(previousPlan.artists);
  assert.ok(previousPlan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Catalog eligibility changed');
  // Verify every original sealed byte without ever editing the old runtime.
  for(const [file,hash] of Object.entries({...previousPlan.evidenceFiles,...previousPlan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(oldRoot+'/'+file)),hash);
  await fs.mkdir(root);
  for(const d of ['evidence','receipts','results','inputs'])await fs.mkdir(root+'/'+d);
  const evidenceFiles={};
  for(const [file,hash] of Object.entries(previousPlan.evidenceFiles)){
    const bytes=await fs.readFile(oldRoot+'/'+file);
    await durableStageFile(root+'/'+file,bytes);evidenceFiles[file]=hash;
  }
  const recoveryBytes=JSON.stringify(evidence);
  await durableStageFile(root+'/evidence/recovery.json',recoveryBytes);
  evidenceFiles['evidence/recovery.json']=digest(recoveryBytes);
  const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'run-youtube-video-stage.mjs');
  const modules=await freezeLocalModules(entry,root+'/runtime'),runtimeFiles={};
  for(const file of modules){const relative='runtime/'+path.basename(file);runtimeFiles[relative]=digest(await fs.readFile(root+'/'+relative));}
  const plan=videoStagePlan({...previousPlan,id,preparedAt:new Date().toISOString(),
    operations:previousPlan.operations.filter(o=>o.key!==op.key),evidenceFiles,runtimeFiles,
    recovery:{previousRunId:previousId,previousPlanSha256:digest(previousPlan),
      previousApprovalSha256:digest(previousApproval),previousOwner:oldRun.owner,completedOperationKey:op.key,
      previousReservedCents:2,originalMaximumCents:80,rawSha256:digest(rawBody),
      receiptSha256:digest(receipt),mappedSha256:digest(mapped)}});
  validateVideoRecovery(plan,evidence);
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const columns=['artist','tier','profile_id','cm_artist','video_url','request_status'];
  const rows=plan.operations.map(o=>{
    const a=plan.artists.find(a=>a.profileId===o.profileId);
    return [a.name,a.tier,o.profileId,o.cmArtist,o.videoUrl,'Not attempted — new approval required'];
  });
  const cell=v=>{let s=String(v);if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  await durableStageFile(root+'/remaining-video-requests.csv','\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  console.log(JSON.stringify({preparedOnly:true,id,remainingRequests:39,remainingMaximumUsd:.78,
    priorReservationUsd:.02,combinedMaximumUsd:.8,planSha256:digest(plan),paidCalls:0,
    savedResponseUploader:mapped.url,savedResponseAcknowledged:false,catalogWrites:0}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
