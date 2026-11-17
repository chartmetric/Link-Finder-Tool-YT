// User-feedback diagnostic, not independently adjudicated ownership ground truth.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundedComparisonGate,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';

export const REVIEWED_TEST_POLICY='reviewed-youtube-transport-only-captures-v1';
function noFeedback(value){
  if(!value||typeof value!=='object')return;
  const forbidden=new Set(['userreview','userfeedback','grading','grade','groundtruth',
    'ownershipadjudication','labelscope','feedbackstrength','expectedlabel','expectedoutcome',
    'expectedverdict','expectedownership','expectedlink']);
  for(const [key,child] of Object.entries(value)){
    assert.ok(!forbidden.has(key.replace(/[_-]/g,'').toLowerCase()),'Feedback must not enter checker evidence');
    noFeedback(child);
  }
}
export function reviewedInput({artist,url,capture=null,sourceObservedAt,sourceRefs,startingTier}){
  assert.ok(sourceRefs?.length&&Number.isFinite(Date.parse(sourceObservedAt)));
  assert.ok([1,2,3,4,5].includes(startingTier));
  noFeedback({artist,capture});
  const input=youtubeVerificationInput(artist,{url,capture});
  assert.equal(input.state.artist.profileId,artist.profileId);
  const channelId=url.match(/^https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1];
  assert.ok(channelId);
  if(capture)assert.ok(input.readyForModel,'A saved channel capture must be bound, not replaced by a video uploader');
  return {caseId:artist.profileId+'-'+channelId,profileId:artist.profileId,cmArtist:artist.cmArtist,
    artist,channelId,url,capture,sourceObservedAt,sourceRefs,startingTier,inputPreview:input,
    channelCaptureAvailable:!!capture,modelRequestSent:false};
}
export function reviewedCohort(inputs,grading){
  assert.ok(inputs.length>=4&&inputs.length<=16&&inputs.length%2===0);
  assert.equal(grading.length,inputs.length);
  assert.equal(new Set(inputs.map(x=>x.profileId)).size,inputs.length);
  assert.equal(new Set(inputs.map(x=>x.channelId)).size,inputs.length);
  for(const row of inputs){
    assert.deepEqual(row,reviewedInput(row));
    const label=grading.find(g=>g.caseId===row.caseId);assert.ok(label);
    assert.ok(['looks_correct','rejected'].includes(label.userFeedback));
    assert.equal(label.ownershipAdjudication,null);
    assert.equal(label.labelScope,'historical_user_feedback');
    assert.equal(label.catalogWritesAuthorized,false);
    assert.ok(label.sourceRefs.length);
  }
  const half=inputs.length/2;
  assert.equal(grading.filter(g=>g.userFeedback==='looks_correct').length,half);
  assert.equal(grading.filter(g=>g.userFeedback==='rejected').length,half);
  return {inputs,grading,summary:{examples:inputs.length,positiveFeedback:half,explicitRejections:half,
    savedChannelCaptures:inputs.filter(i=>i.channelCaptureAvailable).length,
    missingChannelCaptures:inputs.filter(i=>!i.channelCaptureAvailable).length,
    positiveTopicExamples:inputs.filter(i=>grading.find(g=>g.caseId===i.caseId).userFeedback==='looks_correct'&&
      /[-–—]\s*topic$/iu.test(i.capture?.body.displayName??'')).length,
    notHeldOut:true,ownershipAccuracyScorable:false,currentLabelsReadjudicated:false,
    holdsAreNotRejections:true,gradingExcludedFromModelInputs:true,
    futureScoring:'Compare raw model assessments with historical user feedback; report review-based safety overrides separately. Abstentions are not correct rejections. No ownership-accuracy or population claims.',
    catalogWrites:0,paidCalls:0,modelCalls:0}};
}
export function reviewedCaptureOperation(row){
  assert.deepEqual(row,reviewedInput(row));assert.equal(row.channelCaptureAvailable,false);
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(row.url)};
  return {key:'review-capture-'+row.caseId,kind:'metadata',profileId:row.profileId,cmArtist:row.cmArtist,
    channelId:row.channelId,targetUrl:row.url,request,inputSha256:digest(request),reservationCents:2,
    transportOnly:true,ownershipAccepted:false,importEligible:false};
}
export const reviewedCapturePlan=immutableValidationCache(function(p){
  assert.equal(p.version,REVIEWED_TEST_POLICY);
  assert.match(p.id,/^youtube-reviewed-test-captures-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(p.preparedAt)));
  const cohort=reviewedCohort(p.inputs,p.grading);
  assert.deepEqual(p.operations,p.inputs.filter(i=>!i.channelCaptureAvailable).map(reviewedCaptureOperation));
  assert.ok(p.operations.length>0&&p.operations.length<=8);
  assert.equal(p.maximumSpendCents,p.operations.length*2);
  assert.equal(p.selections.length,p.operations.length);
  for(const op of p.operations){
    const s=p.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);
    assert.ok(s&&[1,2,3,4,5].includes(s.tier));
    assert.equal(s.artist,p.inputs.find(i=>i.profileId===op.profileId).artist.name);
  }
  assert.match(p.coordinatorSchemaSha256,/^[a-f0-9]{64}$/);
  assert.ok(Object.keys(p.sourceFiles).length&&Object.keys(p.runtimeFiles).length);
  for(const [f,sha] of Object.entries(p.sourceFiles)){
    assert.ok(f.startsWith('generated-artifacts/')&&!f.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [f,sha] of Object.entries(p.runtimeFiles)){
    assert.match(f,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return {...p,groups:[{id:p.id+'-part-1',groupIndex:0,operations:p.operations,
    maximumCalls:p.operations.length,maximumSpendCents:p.maximumSpendCents}],
    cohortSummary:cohort.summary,executionEnabled:false,requiresFreshSpendingApproval:true,
    noRetries:true,modelCalls:0,searchCalls:0,catalogWrites:0,channelClaimWrites:0,
    labelsRefreshed:false,modelStageApproved:false,ownershipAccuracyScorable:false};
});
export function approveReviewedCaptures(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(reviewedCapturePlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    runtimeSha256:digest(plan.runtimeFiles),operationsSha256:digest(plan.operations),
    scope:'Exact named channel metadata only for a historical user-feedback diagnostic. No models, searches, retries, ownership claims, grading-label refresh, policy activation or catalog writes. Model requests require separate preparation and approval.'};
}
export async function rejectReviewedCaptureReplay(c,operations,ownRun=''){
  for(const op of operations){
    for(const table of ['youtube_video_identity_admissions','youtube_link_campaign_admissions'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
        WHERE kind='metadata' AND profile_id=$1`,[op.profileId])).rows[0].n,0,'Prior metadata allocation: reuse or explicitly reconcile, never repeat');
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE kind='metadata' AND channel_id=$1`,[op.channelId])).rows[0].n,0);
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
      WHERE kind='metadata' AND (profile_id=$1 OR input_sha256=$3) AND run_id<>$2`,
    [op.profileId,ownRun,op.inputSha256])).rows[0].n,0);
  }
}
export function reviewedCaptureGate({pool,plan,approval,owner,checkCatalog}){
  return boundedComparisonGate({pool,plan,approval,owner,
    readiness:boundedExperimentReadiness,rejectReplay:rejectReviewedCaptureReplay,
    // These are intentionally correct AND incorrect artist/channel associations.
    // Validate the catalog identity, not ownership; persist no channel claims.
    checkClaims:async(c,ops)=>{for(const op of ops)await checkCatalog(op);}});
}
export function reviewedCaptureResult(plan,op,receipt,raw){
  assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
  const group=plan.groups[0];
  for(const [key,value] of Object.entries({runId:group.id,parentId:plan.id,planSha256:digest(group),
    operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
    kind:'metadata',inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw)}))assert.equal(receipt[key],value);
  assert.deepEqual(receipt.request,op.request);
  const data=JSON.parse(raw);assert.equal(data.success,true);assert.ok(!data.error);
  assert.ok(Number.isInteger(data.credits_charged)&&data.credits_charged>=0&&data.credits_charged<=1);
  const capture=normalizeYoutubeChannel({...receipt,at:receipt.capturedAt,data},op.targetUrl);
  assert.equal(capture?.body.channelId,op.channelId);
  return {profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,youtubeUrl:op.targetUrl,capture,
    transportOnly:true,ownershipAccepted:false,importEligible:false,catalogWritten:false,
    reviewLabelsChanged:false,channelClaimsWritten:false};
}
