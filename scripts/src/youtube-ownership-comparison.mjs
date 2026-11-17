// A separately approved, model-only experiment, never an import route.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {clarifiedOwnershipRequest} from './youtube-ownership-clarity.mjs';
import {parseBoundYoutubeDecision} from './youtube-ownership-transport.mjs';
import {evaluateYoutubeLink} from './youtube-topic-links.mjs';

export const COMPARISON_POLICY='saved-youtube-ownership-comparison-bounded-v2';
export function comparisonOperation(original,capture,result,row){
  const draft=clarifiedOwnershipRequest(original,capture);
  assert.ok(draft.matchingSpotifyIds.length,'Only the investigated exact-Spotify cohort');
  assert.equal(result.decision.status,'needs_identity_check');
  assert.equal(result.modelAnswer.requestSha256,original.inputSha256);
  assert.equal(result.modelAnswer.inputSha256,original.policyInputSha256);
  for(const key of ['profileId','cmArtist','channelId'])assert.equal(result[key],original[key]);
  const request=draft.request;
  return {key:'compare-'+original.profileId+'-'+original.channelId,kind:'model',
    profileId:original.profileId,cmArtist:original.cmArtist,channelId:original.channelId,request,
    inputSha256:digest(request),comparisonStateSha256:digest({policy:COMPARISON_POLICY,state:request.body.state}),
    requestBytes:draft.proposedRequestBytes,proposedReservationCents:2,
    baseline:{operation:original,capture,result,admission:row},ownershipAccepted:false,importEligible:false};
}
export const comparisonPlan=immutableValidationCache(function(p){
  assert.equal(p.version,COMPARISON_POLICY);
  assert.match(p.id,/^youtube-ownership-comparison-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(p.preparedAt)));
  assert.ok(p.operations.length>0&&p.operations.length<=13);
  assert.equal(p.maximumSpendCents,p.operations.length*2);
  assert.equal(p.maximumRequestBytes,Math.max(...p.operations.map(o=>o.requestBytes)));
  assert.equal(p.pricing.id,'typesafe/jev-1.13');
  assert.ok(Number(p.pricing.promptUsdPerToken)>0&&Number(p.pricing.promptUsdPerToken)<=0.000000042);
  assert.equal(Number(p.pricing.completionUsdPerToken),0);
  assert.ok(p.pricing.contextTokens>=262144&&p.maximumRequestBytes<p.pricing.contextTokens);
  assert.ok(Object.keys(p.runtimeFiles).length&&Object.keys(p.sourceFiles).length);
  assert.match(p.coordinatorSchemaSha256,/^[a-f0-9]{64}$/);
  assert.equal(p.failedLaunch.status,'stopped');assert.equal(p.failedLaunch.reservedCents,0);
  assert.equal(p.failedLaunch.admissions,0);
  assert.match(p.failedLaunch.id,/^youtube-ownership-comparison-[a-z0-9-]+-part-1$/);
  assert.match(p.failedLaunch.scopeSha256,/^[a-f0-9]{64}$/);
  for(const [f,sha] of Object.entries(p.runtimeFiles)){
    assert.match(f,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [f,sha] of Object.entries(p.sourceFiles)){
    assert.ok(f.startsWith('generated-artifacts/')&&!f.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const field of ['key','profileId','cmArtist','channelId'])
    assert.equal(new Set(p.operations.map(o=>o[field])).size,p.operations.length);
  assert.equal(p.selections.length,p.operations.length);
  let previousTier=0;
  for(const op of p.operations){
    const b=op.baseline;
    assert.deepEqual(op,comparisonOperation(b.operation,b.capture,b.result,b.admission));
    assert.notEqual(op.inputSha256,b.operation.inputSha256,'Never repeat the original paid request');
    const s=p.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);
    assert.ok(s&&[1,2,3,4,5].includes(s.tier)&&s.tier>=previousTier);
    assert.equal(s.artist,op.request.body.state.artist.name);previousTier=s.tier;
    const expected={operation_key:b.operation.key,profile_id:op.profileId,cm_artist:op.cmArtist,
      channel_id:op.channelId,kind:'model',input_sha256:b.operation.inputSha256,reserved_cents:2,
      status:'returned',http_status:200};
    for(const [key,v] of Object.entries(expected))assert.equal(b.admission[key],v);
    assert.match(b.admission.receipt_sha256,/^[a-f0-9]{64}$/);
    assert.match(b.admission.raw_sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(p.baselineLedgerSnapshot.admissions.find(a=>a.run_id===b.admission.run_id&&
      a.operation_key===b.admission.operation_key),b.admission);
    assert.equal(p.baselineLedgerSnapshot.runs.find(r=>r.id===b.admission.run_id)?.status,'completed');
  }
  return {...p,groups:[{id:p.id+'-part-1',groupIndex:0,operations:p.operations,
    maximumCalls:p.operations.length,maximumSpendCents:p.maximumSpendCents}],
    executionEnabled:false,requiresFreshSpendingApproval:true,experimental:true,noRetries:true,
    catalogWrites:0,importEligible:false,baselineIsGroundTruth:false};
});
export function approveComparison(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(comparisonPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    maximumRequestBytes:plan.maximumRequestBytes,operationAllocationsSha256:digest(plan.operations),
    runtimeSha256:digest(plan.runtimeFiles),
    scope:'One changed, exact question set per listed previously checked artist/channel pair. Compare with saved baselines; no baseline replay, sourcing, retries, evidence changes, substitutions or catalog updates.'};
}
export async function rejectComparisonReplay(c,operations,ownRun=''){
  for(const op of operations){
    const rows=(await c.query(`SELECT run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,
      reserved_cents,status,http_status,receipt_sha256,raw_sha256 FROM youtube_video_identity_admissions
      WHERE kind='model' AND run_id<>$1 AND (profile_id=$2 OR cm_artist=$3 OR channel_id=$4)`,
    [ownRun,op.profileId,op.cmArtist,op.channelId])).rows;
    assert.equal(rows.length,1,'Only the exact returned baseline allocation is permitted; no repeat comparison');
    assert.deepEqual(rows[0],op.baseline.admission);
    for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE kind='model' AND profile_id=$1`,
        [op.profileId])).rows[0].n,0);
  }
}
export function comparisonResult(plan,op,receipt,raw){
  const b=op.baseline;assert.deepEqual(op,comparisonOperation(b.operation,b.capture,b.result,b.admission));
  assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
  for(const [key,v] of Object.entries({runId:plan.groups[0].id,parentId:plan.id,
    planSha256:digest(plan.groups[0]),
    operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
    kind:'model',inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw)}))assert.equal(receipt[key],v);
  assert.deepEqual(receipt.request,op.request);
  const data=JSON.parse(raw),packet={...receipt,data,at:receipt.capturedAt};
  const parsed=parseBoundYoutubeDecision(packet,{requestHash:op.inputSha256,
    inputSha256:op.comparisonStateSha256,expectedModel:'typesafe/jev-1.13'});
  const reason=data.answers?.ownership_reason?.choice;
  assert.ok(Object.hasOwn(op.request.body.questions.ownership_reason.criteria,reason),'Missing or invalid decision reason');
  const s=b.operation.request.body.state;
  // Safety evaluation deliberately gets no new answer. Never relabel the new
  // answer's input hash as the old policy input to make it pass an old evaluator.
  const safety=evaluateYoutubeLink(s.artist,{url:s.candidate.url,capture:b.capture,...s.candidate.searchEvidence});
  const a=parsed.answer;
  const supported=['needs_identity_check','likely_artist_owned'].includes(safety.status)&&
    a.verdict==='likely'&&a.channelType==='artist_owned'&&reason==='combined_identity_and_control';
  const topic=safety.channelType==='topic'||a.channelType==='topic'||reason==='topic_presence';
  return {profileId:op.profileId,cmArtist:op.cmArtist,artist:s.artist.name,
    youtubeUrl:'https://www.youtube.com/channel/'+op.channelId,channelId:op.channelId,
    channelTypeLabel:topic?'Topic — auto-generated':a.channelType,
    decision:{status:supported?'experimental_support':'experimental_hold',reason,channelType:a.channelType,
      reviewSuggestion:false,verified:false,liveLinkAccepted:false},
    modelAnswer:{...parsed,reasonCode:reason,reasonCategory:op.request.body.questions.ownership_reason.criteria[reason]},
    safety,baseline:b.result,experimental:true,baselineIsGroundTruth:false,
    ownershipAccepted:false,importEligible:false,catalogWritten:false};
}
