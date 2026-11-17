// New model-only execution policy. Historical metadata/model workers are unchanged.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {YOUTUBE_OWNERSHIP_POLICY,youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {youtubeDecisionRequest,parseYoutubeDecision} from './youtube-ownership-transport.mjs';
import {evaluateYoutubeLink} from './youtube-topic-links.mjs';
export const SAVED_MODEL_POLICY='exact-saved-channel-model-execution-v1';
export function savedModelInput(op){
  const body=op.request.body,{evidenceRules,...state}=body.state;
  const input={policy:YOUTUBE_OWNERSHIP_POLICY,rules:evidenceRules,state,
    inputSha256:op.policyInputSha256,readyForModel:true};
  assert.equal(digest({policy:input.policy,rules:input.rules,state:input.state}),input.inputSha256);
  const capture=state.candidate.channelCapture;assert.ok(capture);
  assert.equal(capture.bodySha256,digest(capture.body));
  assert.ok(capture.aliases.includes('https://www.youtube.com/channel/'+capture.body.channelId));
  return input;
}
export function validateSavedModelOperation(op,maxBytes,capture){
  assert.equal(op.kind,'model');assert.match(op.profileId,/^\d+$/);assert.match(op.cmArtist,/^\d+$/);
  assert.match(op.channelId,/^UC[A-Za-z0-9_-]{22}$/);
  assert.equal(op.request.method,'POST');assert.equal(op.request.url,'https://openrouter.ai/api/alpha/decisions');
  assert.equal(op.request.body.model,'typesafe/jev-1.13');
  assert.equal(op.inputSha256,digest(op.request));
  assert.equal(op.requestBodySha256,digest(Buffer.from(JSON.stringify(op.request.body))));
  assert.equal(op.requestBytes,Buffer.byteLength(JSON.stringify(op.request.body)));
  assert.ok(op.requestBytes>0&&op.requestBytes<=maxBytes);
  assert.equal(op.proposedReservationCents,2);
  const input=savedModelInput(op);
  assert.equal(input.state.artist.profileId,op.profileId);assert.equal(input.state.artist.cmArtist,op.cmArtist);
  assert.equal(input.state.candidate.channelCapture.body.channelId,op.channelId);
  if(capture){
    const s=input.state;
    assert.deepEqual(youtubeVerificationInput(s.artist,{url:s.candidate.url,capture,
      ...s.candidate.searchEvidence}),input,'Restore the original capture packet, not the model-readable summary');
  }
  assert.deepEqual(youtubeDecisionRequest(input,{model:{expectedModel:'typesafe/jev-1.13',
    endpoint:op.request.url,maxRequestBytes:maxBytes}}).request,op.request);
  return input;
}
export const savedModelPlan=immutableValidationCache(function(input){
  assert.equal(input.version,SAVED_MODEL_POLICY);
  assert.match(input.id,/^youtube-saved-model-checks-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.match(input.sourceProposalPath,/^generated-artifacts\/youtube-saved-batch-verification-[a-z0-9-]+\/plan.json$/);
  assert.match(input.sourceProposalSha256,/^[a-f0-9]{64}$/);
  assert.match(input.sourceProposalFileSha256,/^[a-f0-9]{64}$/);
  const q=input.pricing;
  assert.equal(q.id,'typesafe/jev-1.13');assert.equal(q.endpoint,'https://openrouter.ai/api/v1/models?output_modalities=decisions');
  assert.ok(Number.isFinite(Date.parse(q.observedAt)));
  assert.ok(Number(q.promptUsdPerToken)>0&&Number(q.promptUsdPerToken)<=0.000000042);
  assert.equal(Number(q.completionUsdPerToken),0);assert.ok(q.contextTokens>=262144);
  assert.equal(input.maximumRequestBytes,Math.max(...input.operations.map(o=>o.requestBytes)));
  assert.ok(input.maximumRequestBytes<q.contextTokens);
  assert.equal(input.maximumSpendCents,input.operations.length*2);
  assert.ok(input.operations.length>0&&input.operations.length<=168);
  for(const field of ['key','profileId','cmArtist','channelId'])
    assert.equal(new Set(input.operations.map(o=>o[field])).size,input.operations.length,'Duplicate '+field);
  assert.equal(Object.keys(input.capturePackets).length,input.operations.length);
  for(const op of input.operations){
    assert.ok(input.capturePackets[op.key]);
    validateSavedModelOperation(op,input.maximumRequestBytes,input.capturePackets[op.key]);
  }
  assert.equal(input.selections.length,input.operations.length);
  let previousTier=0;
  for(const op of input.operations){
    const s=input.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);assert.ok(s);
    assert.ok([1,2,3,4,5].includes(s.tier));
    assert.equal(s.artist,op.request.body.state.artist.name);
    assert.ok(s.tier>=previousTier,'Verification priority remains Tier 1, then 2–5');
    previousTier=s.tier;
  }
  assert.ok(Object.keys(input.runtimeFiles).length);
  for(const [f,sha] of Object.entries(input.runtimeFiles)){
    assert.match(f,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  const groups=[];
  for(let at=0;at<input.operations.length;at+=20){
    const operations=input.operations.slice(at,at+20);
    groups.push({id:input.id+'-part-'+(groups.length+1),groupIndex:groups.length,
      operations,maximumCalls:operations.length,maximumSpendCents:operations.length*2});
  }
  return {...input,groups,modelOnly:true,metadataCalls:0,searchCalls:0,uploaderCalls:0,noRetries:true,
    noCatalogWrites:true,noAutomaticAcceptance:true,executionEnabled:false,explicitApproval:false,
    tierPolicy:'Same artist identity, currently Tier 1–5; movement within these tiers does not substitute an artist.',
    budgetWarning:'Two cents per request is a conservative local reservation, not a provider-enforced dollar ceiling. A missing or excessive reported charge stops all further requests.'};
});
export function approveSavedModels(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(savedModelPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    maximumRequestBytes:plan.maximumRequestBytes,operationAllocationsSha256:digest(plan.operations),
    runtimeSha256:digest(plan.runtimeFiles),scope:'Only the exact saved model requests; no new sourcing, retries, substitutions or catalog additions.'};
}
export function savedModelResult(plan,op,receipt,raw){
  const data=JSON.parse(raw),input=validateSavedModelOperation(op,plan.maximumRequestBytes,plan.capturePackets[op.key]);
  const packet={at:receipt.capturedAt,status:receipt.status,kind:'model',operationKey:op.key,
    request:op.request,inputSha256:op.inputSha256,data};
  const parsed=parseYoutubeDecision(packet,input,{model:{expectedModel:'typesafe/jev-1.13',
    endpoint:op.request.url,maxRequestBytes:plan.maximumRequestBytes}},op.inputSha256);
  const s=input.state;
  const decision=evaluateYoutubeLink(s.artist,{url:s.candidate.url,capture:plan.capturePackets[op.key],
    ...s.candidate.searchEvidence},{answer:parsed});
  return {profileId:op.profileId,cmArtist:op.cmArtist,artist:s.artist.name,
    youtubeUrl:'https://www.youtube.com/channel/'+op.channelId,channelId:op.channelId,
    channelTypeLabel:decision.channelType==='topic'?'Topic — auto-generated':decision.channelType,
    decision,modelAnswer:parsed,ownershipAccepted:false,importEligible:false,catalogWritten:false};
}
