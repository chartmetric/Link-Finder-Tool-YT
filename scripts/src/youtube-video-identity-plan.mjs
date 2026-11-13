// Preparation and source review only. No dispatcher or spending gate is provided.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {verifyIdentityUploaderSource,identityBytes,identityJson,identityArchivePath} from './youtube-video-identity-source.mjs';
import {youtubeVerificationInput,boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {assembleYoutubeOwnershipEvidence} from './youtube-ownership-evidence.mjs';
import {evaluateYoutubeLink,YOUTUBE_LINK_POLICY} from './youtube-topic-links.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision} from './youtube-ownership-transport.mjs';

export const VIDEO_IDENTITY_POLICY='exact-video-channel-identity-preparation-v1';
export const VIDEO_CHANNEL_SELECTION='first-distinct-uploader-in-frozen-operation-order-v1';
export const VIDEO_IDENTITY_MODEL={model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
  expectedModel:'typesafe/jev-1.13',maxRequestBytes:6000}};
const sha=/^[a-f0-9]{64}$/;
const clone=x=>JSON.parse(JSON.stringify(x));
function header(input,stage){
  assert.match(input.id,/^youtube-video-identity-[a-z0-9-]{4,80}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.ok(input.runtimeFiles&&Object.keys(input.runtimeFiles).length);
  for(const [name,hash] of Object.entries(input.runtimeFiles)){
    identityArchivePath(name);assert.ok(name.startsWith('runtime/'));assert.match(hash,sha);
  }
  return {version:VIDEO_IDENTITY_POLICY,id:input.id,stage,preparedAt:input.preparedAt,
    runtimeFiles:clone(input.runtimeFiles),
    executable:false,explicitApproval:false,inheritsApproval:false,
    approvalStatus:'requires_fresh_exact_plan_spending_approval',
    noAutomaticRetries:true,noCatalogWrites:true,noOldResultRewrites:true,
    fullCampaignRemainsPaused:true,ownershipAccuracy:null,
    accuracyStatus:'unmeasured_until_independent_source_review',
    linkPolicy:YOUTUBE_LINK_POLICY};
}
function totals(operations){
  return {maximumCalls:operations.length,maximumSpendCents:operations.length*2,
    perOperationReservationCents:2,operations};
}
const metadataRequest=url=>({method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'
  +new URLSearchParams({url})});
function operation(kind,a,channelId,request,bindings){
  return {key:`${kind}-${a.profileId}-${a.cmArtist}-${channelId}`,kind,
    profileId:a.profileId,cmArtist:a.cmArtist,channelId,request:clone(request),
    inputSha256:digest(request),reservationCents:2,...bindings};
}
export function prepareVideoChannelCaptures(input){
  const base=header(input,'channel_captures'),source=verifyIdentityUploaderSource(input.source);
  const owners=new Map();
  for(const o of source.observations){
    const pairs=owners.get(o.channelId)??new Map();
    pairs.set(o.profileId,{profileId:o.profileId,cmArtist:o.cmArtist});owners.set(o.channelId,pairs);
  }
  const selections=source.artists.map(a=>{
    const alternatives=[];
    for(const o of source.observations.filter(o=>o.profileId===a.profileId)){
      let c=alternatives.find(c=>c.channelId===o.channelId);
      if(!c){c={channelId:o.channelId,url:o.url,observations:[],
        sharedChannelClaims:[...owners.get(o.channelId).values()],
        sharedChannelConflict:owners.get(o.channelId).size>1};alternatives.push(c);}
      c.observations.push(o);
    }
    assert.ok(alternatives.length);
    return {profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,tier:a.tier,
      catalogEvidenceSha256:a.evidenceSha256,selectedChannelId:alternatives[0].channelId,
      alternatives:alternatives.map((c,i)=>({...c,selected:i===0,
        disposition:i===0?'selected_for_capture':'deferred_by_one_channel_cap',
        identityStatus:'unresolved',artistOwned:false,ownershipAccepted:false}))};
  });
  const operations=selections.map(s=>{
    const c=s.alternatives[0];
    return operation('metadata',s,c.channelId,metadataRequest(c.url),{
      catalogEvidenceSha256:s.catalogEvidenceSha256,
      provenanceSha256:digest(c.observations),sharedChannelConflict:c.sharedChannelConflict,
      sharedChannelClaims:c.sharedChannelClaims});
  });
  return {...base,source:clone(input.source),sourceBinding:{
    id:source.id,planSha256:source.planSha256,approvalSha256:source.approvalSha256,
    summarySha256:source.summarySha256,filesSha256:source.filesSha256},
    selectionPolicy:VIDEO_CHANNEL_SELECTION,
    selectionRule:'For each artist, keep unique channel IDs in frozen uploader-operation order; capture the first. No name, role, ownership answer or Topic preference changes that order.',
    breadthTradeoff:'At most one channel captured per artist, rather than the previous two-channel test. Every other uploader remains visible but uncaptured and unresolved; no automatic fallback.',
    sharedChannelScope:'All uploader alternatives in this source cohort, including deferred ones. Outside-cohort catalog/channel claims are not checked offline.',
    executionPreconditions:['Fresh exact-plan spending approval','Separate transactional, non-replayable execution gate',
      'Recheck current catalog identity/eligibility, outside-cohort shared-channel claims and stopped parent campaign before dispatch'],
    selections,...totals(operations),perArtistMaximumCalls:1,allowedKinds:['metadata'],searchCalls:0,videoUploaderCalls:0,
    modelCalls:0,unknownModelRequestsApproved:false,
    nextStage:'After immutable channel returns, freeze exact model bodies and request another exact-plan approval'};
}
export function validateVideoChannelCaptures(plan){
  assert.deepEqual(prepareVideoChannelCaptures(plan),plan);return plan;
}

// A local review authorization record, not a live spending gate or a resumed run.
export function approveVideoIdentityPlan(plan,{expectedPlanSha256,capCents,approvedAt}){
  validateVideoIdentityPlan(plan);
  assert.match(expectedPlanSha256,sha);assert.equal(digest(plan),expectedPlanSha256,'Exact plan hash required');
  assert.equal(capCents,plan.maximumSpendCents,'Exact operation-specific cap required');
  assert.ok(Number.isFinite(Date.parse(approvedAt)));
  return {id:plan.id,policy:VIDEO_IDENTITY_POLICY,stage:plan.stage,planSha256:expectedPlanSha256,
    capCents,approvedAt,explicitApproval:true,executionEnabled:false,
    operationAllocationsSha256:digest(plan.operations),
    scope:'only_exact_frozen_requests_no_retries_no_substitution'};
}
export function assertVideoIdentityApproval(plan,approval){
  assert.deepEqual(approveVideoIdentityPlan(plan,{expectedPlanSha256:approval.planSha256,
    capCents:approval.capCents,approvedAt:approval.approvedAt}),approval);
}
// Contract for a future separately approved executor. Missing/uncertain returns stop
// preparation rather than being retried or silently counted as no-match.
function verifiedReturns(plan,returns){
  assertVideoIdentityApproval(plan,returns.approval);
  assert.deepEqual(returns.summary,{id:plan.id,planSha256:digest(plan),status:'completed',
    returnedCalls:plan.operations.length});
  assert.equal(returns.receipts.length,plan.operations.length);
  const keys=new Set();
  return returns.receipts.map(saved=>{
    const bytes=identityBytes(saved.receiptBytesBase64),r=identityJson(bytes);
    const op=plan.operations.find(o=>o.key===r.operationKey);assert.ok(op,'Unplanned returned operation');
    assert.ok(!keys.has(op.key),'Duplicate return');keys.add(op.key);
    assert.equal(r.runId,plan.id);assert.equal(r.planSha256,digest(plan));
    assert.equal(r.approvalSha256,digest(returns.approval));
    for(const key of ['profileId','cmArtist','channelId','kind','inputSha256'])assert.equal(r[key],op[key]);
    assert.deepEqual(r.request,op.request);
    assert.equal(r.rawPath,'receipts/'+digest(op.key)+'.raw');
    assert.equal(r.status,200);
    assert.ok(Number.isFinite(Date.parse(r.capturedAt)));
    const raw=identityBytes(saved.rawBodyBase64);
    assert.ok(raw.length>0&&raw.length<=2*1024*1024);
    assert.equal(digest(raw),r.rawBodySha256);
    const data=identityJson(raw);
    assert.ok(!data.error);
    return {op,packet:{at:r.capturedAt,status:r.status,kind:r.kind,operationKey:r.operationKey,
      request:r.request,inputSha256:r.inputSha256,data},receiptFileSha256:digest(bytes),
      rawBodySha256:digest(raw)};
  });
}
function category(decision){
  return decision.status==='supported_topic'?'supported_topic':
    decision.status==='likely_artist_owned'?'artist_owned_suggestion':'unresolved';
}
function result(decision,extra={}){
  return {category:category(decision),decision,artistOwned:decision.status==='likely_artist_owned',
    channelTypeLabel:decision.channelType==='topic'?'Topic — auto-generated':decision.channelType,
    ownershipAccepted:false,liveLinkAccepted:false,ownershipAccuracy:null,
    accuracyStatus:'unmeasured_until_independent_source_review',...extra};
}
export function prepareVideoIdentityModels(input){
  const base=header(input,'identity_models');
  const capturePlan=validateVideoChannelCaptures(input.capturePlan);
  assert.notEqual(input.id,capturePlan.id,'New stage needs its own ID');
  const source=verifyIdentityUploaderSource(capturePlan.source);
  const captures=verifiedReturns(capturePlan,input.captureReturns);
  const aliases=new Map(),selections=clone(capturePlan.selections);
  // A newly captured shared handle is a conflict even if uploader IDs differed.
  for(const returned of captures){
    const {op,packet}=returned,s=selections.find(s=>s.profileId===op.profileId),c=s.alternatives[0];
    assert.equal(packet.data.success,true);
    assert.ok(Number.isInteger(packet.data.credits_charged)&&packet.data.credits_charged>=0
      &&packet.data.credits_charged<=1,'Unknown/increased channel credit charge');
    returned.capture=normalizeYoutubeChannel(packet,c.url);
    assert.ok(returned.capture&&returned.capture.body.channelId===c.channelId,'Unbound or changed channel identity');
    for(const alias of boundYoutubeCapture(c.url,returned.capture).aliases){
      const claims=aliases.get(alias)??new Map();
      claims.set(op.profileId,{profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId});
      aliases.set(alias,claims);
    }
  }
  for(const returned of captures){
    const s=selections.find(s=>s.profileId===returned.op.profileId),c=s.alternatives[0];
    c.capturedAliasConflicts=boundYoutubeCapture(c.url,returned.capture).aliases
      .filter(alias=>aliases.get(alias).size>1)
      .map(alias=>({alias,claims:[...aliases.get(alias).values()]}));
    if(c.capturedAliasConflicts.length){
      c.sharedChannelConflict=true;
      const claims=new Map(c.sharedChannelClaims.map(p=>[p.profileId,p]));
      for(const conflict of c.capturedAliasConflicts)for(const {profileId,cmArtist} of conflict.claims)
        claims.set(profileId,{profileId,cmArtist});
      c.sharedChannelClaims=[...claims.values()];
    }
  }
  const operations=[],assessments=[];
  for(const selection of selections){
    const returned=captures.find(c=>c.op.profileId===selection.profileId);assert.ok(returned);
    const {op,packet}=returned,selected=selection.alternatives[0];
    const capture=returned.capture;
    const a=source.artists.find(a=>a.profileId===selection.profileId);
    const first=selected.observations[0],clue=first.sources[0];
    const candidate={url:selected.url,capture,title:clue.title,snippet:clue.snippet,sourceUrl:first.videoUrl};
    // Canonical JSON evidence before hashing: optional catalog timestamps can be
    // undefined in the assembler, but are absent once an immutable plan is read.
    const artist=clone({...a.artist,ownershipEvidence:{
      ...assembleYoutubeOwnershipEvidence(a.artist,a.catalogPacket,candidate),
      videoUploaderDiscovery:{role:'video_to_channel_discovery_not_artist_ownership',
        channelId:selected.channelId,observations:selected.observations.map(o=>({
          videoId:o.videoId,videoUrl:o.videoUrl,uploaderName:o.uploaderName,
          receiptSha256:o.receiptSha256,rawBodySha256:o.rawBodySha256}))}}});
    const decision=evaluateYoutubeLink(artist,candidate,{sharedChannel:selected.sharedChannelConflict});
    let prepared=null,hold=null;
    if(decision.status==='needs_identity_check'){
      const modelInput=youtubeVerificationInput(artist,candidate);
      const request=youtubeDecisionRequest(modelInput,VIDEO_IDENTITY_MODEL);
      if(!request.ready)hold='exact_model_body_exceeds_6000_bytes_no_silent_truncation';
      else{
        prepared={input:modelInput,requestSha256:request.inputSha256,bytes:request.bytes};
        operations.push(operation('model',selection,selected.channelId,request.request,{
          catalogEvidenceSha256:selection.catalogEvidenceSha256,provenanceSha256:digest(selected.observations),
          captureOperationKey:op.key,captureReceiptFileSha256:returned.receiptFileSha256,
          captureRawBodySha256:returned.rawBodySha256,policyInputSha256:modelInput.inputSha256,
          sharedChannelConflict:selected.sharedChannelConflict,sharedChannelClaims:selected.sharedChannelClaims}));
      }
    }
    assessments.push({profileId:selection.profileId,cmArtist:selection.cmArtist,
      channelId:selected.channelId,artist,candidate,prepared,hold,
      ...result(decision),captureReceiptFileSha256:returned.receiptFileSha256,
      captureRawBodySha256:returned.rawBodySha256});
  }
  return {...base,capturePlan:clone(capturePlan),captureReturns:clone(input.captureReturns),
    capturePlanSha256:digest(capturePlan),captureReturnsSha256:digest(input.captureReturns),
    model:clone(VIDEO_IDENTITY_MODEL.model),assessments,...totals(operations),
    perArtistMaximumCalls:1,allowedKinds:['model'],searchCalls:0,videoUploaderCalls:0,channelMetadataCalls:0,
    selections,unknownDownstreamRequestsApproved:false};
}
export function validateVideoIdentityPlan(plan){
  if(plan.stage==='channel_captures')return validateVideoChannelCaptures(plan);
  assert.equal(plan.stage,'identity_models');
  assert.deepEqual(prepareVideoIdentityModels(plan),plan);return plan;
}
export function reviewVideoIdentityAnswers(plan,returns){
  validateVideoIdentityPlan(plan);assert.equal(plan.stage,'identity_models');
  const answers=verifiedReturns(plan,returns);
  return plan.assessments.map(a=>{
    const returned=answers.find(r=>r.op.profileId===a.profileId);
    if(!a.prepared){assert.equal(returned,undefined);return clone(a);}
    assert.ok(returned);
    const answer=parseYoutubeDecision(returned.packet,a.prepared.input,{model:plan.model},returned.op.inputSha256);
    // Explicitly keep shared-channel constraints at review time too.
    const selection=plan.selections.find(s=>s.profileId===a.profileId).alternatives[0];
    const decision=evaluateYoutubeLink(a.artist,a.candidate,{sharedChannel:selection.sharedChannelConflict,answer});
    return {...clone(a),...result(decision),recordedAnswer:answer,
      modelReceiptFileSha256:returned.receiptFileSha256,modelRawBodySha256:returned.rawBodySha256};
  });
}
