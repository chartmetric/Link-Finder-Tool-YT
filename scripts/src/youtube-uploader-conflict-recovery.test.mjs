import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,SMALL_VIDEO_STAGE_POLICY,approveVideoStage} from './youtube-video-stage.mjs';
import {validateConflictRecovery,validateConflictResponse,assertConflictLedger,CONFLICT_RECOVERY_POLICY}
  from './youtube-uploader-conflict-recovery.mjs';
import {conflictExecutionApproval,acknowledgeConflictReceipt} from './run-youtube-uploader-conflict-recovery.mjs';

function fixture(){
  const artists=[1,2].map(i=>({profileId:String(i),cmArtist:String(i+10),name:'Artist '+i,
    tier:2,snapshotAt:'2026-11-13T01:00:00Z'}));
  const operations=[0,1,2].map(i=>{
    const a=artists[i<2?0:1],videoId='v'+String(i).padStart(10,'0');
    const videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {profileId:a.profileId,cmArtist:a.cmArtist,kind:'video_uploader',
      key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,videoId,videoUrl,
      request:proposedUploaderRequest(videoUrl)};
  });
  const previousPlan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,
    id:'youtube-video-review-conflict-source',preparedAt:'2026-11-13T20:00:00Z',
    sourceRunId:'youtube-test-synthetic-source',sourcePlanSha256:'a'.repeat(64),
    artists,operations,evidenceFiles:{'evidence/source-plan.json':'b'.repeat(64)},
    runtimeFiles:{'runtime/run.mjs':'c'.repeat(64)}});
  const previousApproval=approveVideoStage(previousPlan,{expectedPlanSha256:digest(previousPlan),
    capCents:6,approvedAt:'2026-11-13T20:01:00Z'});
  const rawBody=Buffer.from(JSON.stringify({success:true,id:operations[1].videoId,credits_charged:1,
    channel:{id:'UC'+'a'.repeat(22)},uploader:{channelId:'UC'+'b'.repeat(22)},
    ownerByline:{channelId:'UC'+'a'.repeat(22)}}));
  const op=previousPlan.operations[1],receipt={runId:previousPlan.id,planSha256:digest(previousPlan),
    operationKey:op.key,kind:'video_uploader',profileId:op.profileId,cmArtist:op.cmArtist,
    videoId:op.videoId,request:op.request,inputSha256:op.inputSha256,status:200,
    rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(rawBody)};
  const admissions=previousPlan.operations.slice(0,2).map((o,i)=>({
    run_id:previousPlan.id,operation_key:o.key,profile_id:o.profileId,cm_artist:o.cmArtist,
    video_id:o.videoId,input_sha256:o.inputSha256,status:i?'admitted':'returned',
    receipt_sha256:i?null:'d'.repeat(64),raw_sha256:i?null:'e'.repeat(64),http_status:i?null:200}));
  const sourceFiles={};
  for(const a of admissions){
    sourceFiles['receipts/'+digest(a.operation_key)+'.json']='f'.repeat(64);
    sourceFiles['receipts/'+digest(a.operation_key)+'.raw']='f'.repeat(64);
    if(a.status==='returned')sourceFiles['results/'+digest(a.operation_key)+'.json']='f'.repeat(64);
  }
  const evidence={version:CONFLICT_RECOVERY_POLICY,continuationId:'youtube-video-review-conflict-suffix',
    previousPlan,previousApproval,previousSummary:{id:previousPlan.id,status:'stopped',returnedCalls:1},
    previousRun:{id:previousPlan.id,status:'stopped',owner:'old-owner',reserved_cents:4,cap_cents:6,
      plan_sha256:digest(previousPlan),approval_sha256:digest(previousApproval)},
    admissions,sourceFiles,receipt,rawBodyBase64:rawBody.toString('base64'),
    conflictReview:validateConflictResponse(op,receipt,rawBody)};
  const plan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id:evidence.continuationId,
    preparedAt:'2026-11-13T21:00:00Z',sourceRunId:previousPlan.sourceRunId,
    sourcePlanSha256:previousPlan.sourcePlanSha256,artists:[artists[1]],
    operations:previousPlan.operations.slice(2),
    evidenceFiles:{'evidence/conflict-recovery.json':digest(JSON.stringify(evidence))},
    runtimeFiles:{'runtime/run.mjs':'c'.repeat(64)}});
  return {plan,evidence,rawBody};
}
const rebind=(plan,evidence)=>({...plan,evidenceFiles:{
  ...plan.evidenceFiles,'evidence/conflict-recovery.json':digest(JSON.stringify(evidence))}});

test('conflicting receipt stays held while only the untouched suffix is proposed',()=>{
  const {plan,evidence}=fixture(),r=validateConflictRecovery(plan,evidence);
  assert.equal(r.returnedCalls,1);assert.equal(r.remainingCalls,1);
  assert.equal(r.priorReservedCents,4);assert.equal(r.combinedMaximumCents,6);
  assert.equal(evidence.conflictReview.selectedChannel,null);
  assert.equal(evidence.conflictReview.importEligible,false);
  assert.equal(evidence.conflictReview.ownershipAccepted,false);
  assertConflictLedger(evidence,evidence.previousRun,evidence.admissions);
});
test('wrong video, unknown price, non-conflicting identities and changed raw bytes fail closed',()=>{
  const {evidence,rawBody}=fixture(),op=evidence.previousPlan.operations[1];
  for(const mutate of [
    b=>b.id='other-video',b=>b.credits_charged=2,
    b=>b.uploader.channelId=b.channel.id,b=>b.success=false,
  ]){
    const body=JSON.parse(rawBody);mutate(body);const raw=Buffer.from(JSON.stringify(body));
    assert.throws(()=>validateConflictResponse(op,{...evidence.receipt,rawBodySha256:digest(raw)},raw));
  }
  assert.throws(()=>validateConflictResponse(op,evidence.receipt,Buffer.from('{}')));
  assert.throws(()=>validateConflictResponse(op,{...evidence.receipt,status:500},rawBody));
});
test('recovery cannot refund charges, replay the prefix, accept a channel or lose completed receipts',()=>{
  for(const mutate of [
    e=>e.previousRun.reserved_cents=2,
    e=>e.previousRun.status='running',
    e=>e.admissions[0].status='admitted',
    e=>e.admissions[0].receipt_sha256=null,
    e=>e.conflictReview.selectedChannel='UC'+'a'.repeat(22),
    e=>e.conflictReview.ownershipAccepted=true,
    e=>e.conflictReview.importEligible=true,
    e=>delete e.sourceFiles['results/'+digest(e.admissions[0].operation_key)+'.json'],
  ]){
    const {plan,evidence}=fixture();mutate(evidence);
    assert.throws(()=>validateConflictRecovery(rebind(plan,evidence),evidence));
  }
  const {plan,evidence}=fixture();
  assert.throws(()=>validateConflictRecovery({...plan,operations:evidence.previousPlan.operations.slice(0,1)},evidence));
});
test('locked ledger changes fail; an exact prior acknowledgment is idempotent without changing reservations',()=>{
  const {evidence}=fixture();
  for(const mutate of [
    (r,a)=>r.owner='new-owner',(r,a)=>r.reserved_cents=0,
    (r,a)=>a[0].raw_sha256='0'.repeat(64),(r,a)=>a.push({...a[0],operation_key:'extra'}),
    (r,a)=>a[1].input_sha256='0'.repeat(64),
  ]){
    const run=structuredClone(evidence.previousRun),rows=structuredClone(evidence.admissions);
    mutate(run,rows);assert.throws(()=>assertConflictLedger(evidence,run,rows));
  }
  const rows=structuredClone(evidence.admissions);
  Object.assign(rows[1],{status:'returned',http_status:200,
    receipt_sha256:digest(evidence.receipt),raw_sha256:evidence.receipt.rawBodySha256});
  assertConflictLedger(evidence,evidence.previousRun,rows);
  rows[1].raw_sha256='0'.repeat(64);
  assert.throws(()=>assertConflictLedger(evidence,evidence.previousRun,rows));
});
test('acknowledgment requires a separate exact supplement before touching a database',async()=>{
  const {plan,evidence}=fixture();
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:2,
    approvedAt:'2026-11-13T21:01:00Z'});
  const supplement=conflictExecutionApproval(plan,approval);
  assert.equal(supplement.allowRetry,false);assert.equal(supplement.allowAmbiguousChannelSelection,false);
  let connects=0;
  const pool={async connect(){connects++;throw Error('unexpected database access');}};
  await assert.rejects(()=>acknowledgeConflictReceipt({pool,plan,evidence,approval}));
  await assert.rejects(()=>acknowledgeConflictReceipt({pool,plan,evidence,approval,
    supplement:{...supplement,allowRetry:true}}));
  assert.equal(connects,0);
});
test('approved acknowledgment updates only the exact receipt and never reservations or catalog rows',async()=>{
  const {plan,evidence}=fixture();
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:2,
    approvedAt:'2026-11-13T21:01:00Z'});
  const queries=[];
  const pool={async connect(){return {release(){},async query(sql,params){
    queries.push({sql,params});
    if(sql.includes('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.includes('SELECT count(*)'))return {rows:[{n:0}]};
    if(sql.includes('SELECT * FROM youtube_video_stage_runs'))return {rows:[evidence.previousRun]};
    if(sql.includes('SELECT * FROM youtube_video_stage_admissions'))return {rows:evidence.admissions};
    if(sql.includes('SELECT run_id,operation_key'))return {rows:[evidence.admissions[1]]};
    return {rowCount:1,rows:[]};
  }};}};
  await acknowledgeConflictReceipt({pool,plan,evidence,approval,supplement:conflictExecutionApproval(plan,approval)});
  const writes=queries.filter(q=>/^\s*(?:UPDATE|INSERT|DELETE)\b/.test(q.sql));
  assert.equal(writes.length,1);assert.match(writes[0].sql,/UPDATE youtube_video_stage_admissions/);
  assert.ok(!writes[0].sql.includes('reserved_cents'));
  assert.deepEqual(writes[0].params,[evidence.previousPlan.id,evidence.receipt.operationKey,
    digest(evidence.receipt),evidence.receipt.rawBodySha256]);
  assert.equal(queries.at(-1).sql,'COMMIT');
});
