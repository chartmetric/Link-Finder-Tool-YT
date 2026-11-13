// Exact saved-video stage only. Unknown channel/model requests require a later approval.
import assert from 'node:assert/strict';
import {digest,proposedUploaderRequest,normalizeDiscoveryVideo} from './youtube-video-discovery-offline.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
const sha=/^[a-f0-9]{64}$/;
export const VIDEO_STAGE_POLICY='exact-saved-video-uploaders-v1';
export const SMALL_VIDEO_STAGE_POLICY='exact-saved-video-uploaders-small-v1';
export const VIDEO_PARENT='full-tiers-1-5-no-youtube-uncapped';
// Old campaign filenames hash the JSON representation of a key string, not its raw bytes.
export const archivedSearchReceiptName=profileId=>evidenceDigest('search-'+profileId+'-0')+'.json';
const copy=x=>JSON.parse(JSON.stringify(x));
function files(value){
  assert.ok(value&&Object.keys(value).length);
  for(const [name,hash] of Object.entries(value)){
    assert.match(name,/^[A-Za-z0-9_./-]+$/);
    assert.ok(!name.startsWith('/')&&!name.split('/').some(x=>['','..','.'].includes(x)));
    assert.match(hash,sha);
  }
  return copy(value);
}
export function videoStagePlan(input){
  const version=input.version??VIDEO_STAGE_POLICY;
  assert.ok([VIDEO_STAGE_POLICY,SMALL_VIDEO_STAGE_POLICY].includes(version));
  const small=version===SMALL_VIDEO_STAGE_POLICY;
  assert.match(input.id,/^youtube-video-review-[a-z0-9-]{4,80}$/);
  assert.match(input.sourcePlanSha256,sha);
  assert.ok(typeof input.sourceRunId==='string'&&input.sourceRunId.length);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  if(small){
    assert.ok(input.artists.length>=1&&input.artists.length<=20);
    assert.equal(input.recovery,undefined,'Small fresh stages cannot inherit recovery spending');
  }else assert.equal(input.artists.length,20,'This reviewed stage is exactly 20 artists');
  const artists=input.artists.map(a=>{
    assert.match(a.profileId,/^\d+$/);assert.match(a.cmArtist,/^\d+$/);
    assert.ok(typeof a.name==='string'&&a.name.trim());
    assert.ok(Number.isInteger(a.tier)&&a.tier>=1&&a.tier<=5);
    assert.ok(typeof a.snapshotAt==='string'&&Number.isFinite(Date.parse(a.snapshotAt)));
    return {profileId:a.profileId,cmArtist:a.cmArtist,name:a.name,tier:a.tier,snapshotAt:a.snapshotAt};
  });
  assert.equal(new Set(artists.map(a=>a.profileId)).size,artists.length);
  assert.equal(new Set(artists.map(a=>a.cmArtist)).size,artists.length);
  assert.ok(artists.every((a,i)=>!i||artists[i-1].tier<=a.tier),'Strict tier order');
  const keys=new Set(),counts=new Map();
  const operations=input.operations.map(o=>{
    const artist=artists.find(a=>a.profileId===o.profileId&&a.cmArtist===o.cmArtist);assert.ok(artist);
    assert.equal(o.kind,'video_uploader');
    const video=normalizeDiscoveryVideo(o.videoUrl);
    assert.ok(video&&video.videoId===o.videoId&&video.url===o.videoUrl);
    assert.equal(o.key,`video_uploader-${o.profileId}-${o.cmArtist}-${o.videoId}`);
    assert.deepEqual(o.request,proposedUploaderRequest(o.videoUrl));
    assert.ok(!keys.has(o.key),'Duplicate request');keys.add(o.key);
    counts.set(o.profileId,(counts.get(o.profileId)??0)+1);
    assert.ok(counts.get(o.profileId)<=2,'At most two frozen videos per artist');
    return {profileId:o.profileId,cmArtist:o.cmArtist,kind:'video_uploader',key:o.key,
      videoId:o.videoId,videoUrl:o.videoUrl,request:copy(o.request),inputSha256:digest(o.request),reservationCents:2};
  });
  assert.ok(operations.length>0
    &&(input.recovery||artists.every(a=>counts.has(a.profileId)))&&operations.length<=40);
  let recovery;
  if(input.recovery){
    const r=input.recovery;
    assert.match(r.previousRunId,/^youtube-video-review-[a-z0-9-]{4,80}$/);assert.notEqual(r.previousRunId,input.id);
    for(const key of ['previousPlanSha256','previousApprovalSha256','rawSha256','receiptSha256','mappedSha256'])
      assert.match(r[key],sha);
    assert.ok(typeof r.previousOwner==='string'&&r.previousOwner.length);
    assert.ok(typeof r.completedOperationKey==='string'&&!keys.has(r.completedOperationKey));
    assert.ok([2,4].includes(r.previousReservedCents));assert.equal(r.originalMaximumCents,80);
    assert.equal(operations.length,40-r.previousReservedCents/2);
    assert.equal(operations.length*2+r.previousReservedCents,r.originalMaximumCents);
    recovery={previousRunId:r.previousRunId,previousPlanSha256:r.previousPlanSha256,
      previousApprovalSha256:r.previousApprovalSha256,previousOwner:r.previousOwner,
      completedOperationKey:r.completedOperationKey,previousReservedCents:r.previousReservedCents,originalMaximumCents:80,
      rawSha256:r.rawSha256,receiptSha256:r.receiptSha256,mappedSha256:r.mappedSha256};
  }
  return {version,id:input.id,parentId:VIDEO_PARENT,
    preparedAt:input.preparedAt,sourceRunId:input.sourceRunId,sourcePlanSha256:input.sourcePlanSha256,
    artists,operations,evidenceFiles:files(input.evidenceFiles),runtimeFiles:files(input.runtimeFiles),
    maximumCalls:operations.length,maximumSpendCents:operations.length*2,
    allowedKinds:['video_uploader'],searchCalls:0,channelMetadataCalls:0,modelCalls:0,
    noAutomaticRetries:true,noCatalogWrites:true,fullCampaignRemainsPaused:true,
    unknownDownstreamRequestsApproved:false,topicChannelsIncludedAsDiscoveryClues:true,
    nextStage:'Freeze discovered channels and identity-check requests, then request separate spending approval',
    candidateBreadth:'All resolved uploaders retained; proposed later selection is at most one channel per artist, not the prior two-channel breadth',
    explicitApproval:false,approvalStatus:'awaiting_exact_saved_video_stage_approval',
    ...(recovery?{recovery}:{} )};
}
export function validateVideoStagePlan(plan){assert.deepEqual(videoStagePlan(plan),plan);return plan;}
export function approveVideoStage(plan,{expectedPlanSha256,capCents,approvedAt}){
  validateVideoStagePlan(plan);
  assert.equal(digest(plan),expectedPlanSha256,'Exact pending plan hash required');
  assert.equal(capCents,plan.maximumSpendCents,'Exact spending cap required');
  assert.ok(Number.isFinite(Date.parse(approvedAt)));
  return {id:plan.id,policy:plan.version,planSha256:digest(plan),capCents,approvedAt,
    explicitApproval:true,operationScope:'video_uploader_only_exact_saved_requests',
    ...(plan.recovery?{savedResponseRecoveryApproved:true,combinedMaximumSpendCents:80}:{} )};
}
export function assertVideoStageApproval(plan,approval){
  assert.deepEqual(approveVideoStage(plan,{expectedPlanSha256:approval.planSha256,
    capCents:approval.capCents,approvedAt:approval.approvedAt}),approval);
}
export function assertVideoStageAdmission(plan,approval,run,op,history,owner){
  assertVideoStageApproval(plan,approval);
  assert.equal(run.id,plan.id);assert.equal(run.owner,owner);assert.equal(run.status,'running');
  assert.equal(run.plan_sha256,digest(plan));assert.equal(run.approval_sha256,digest(approval));
  assert.equal(Number(run.cap_cents),plan.maximumSpendCents);
  const exact=plan.operations.find(p=>p.key===op.key);assert.deepEqual(op,exact,'Only frozen exact requests');
  assert.ok(history.every(h=>h.status==='returned'&&h.http_status===200),'Uncertain/failed call blocks dispatch');
  assert.equal(new Set(history.map(h=>h.operation_key)).size,history.length);
  for(const h of history){
    const prior=plan.operations.find(p=>p.key===h.operation_key);
    assert.ok(prior&&prior.inputSha256===h.input_sha256&&prior.profileId===h.profile_id
      &&prior.cmArtist===h.cm_artist&&prior.videoId===h.video_id);
    assert.match(h.receipt_sha256,sha);assert.match(h.raw_sha256,sha);
  }
  assert.equal(Number(run.reserved_cents),history.length*2);
  assert.ok(!history.some(h=>h.operation_key===op.key),'Never replay an admission');
  assert.ok(history.length<plan.maximumCalls&&Number(run.reserved_cents)+2<=plan.maximumSpendCents);
}
