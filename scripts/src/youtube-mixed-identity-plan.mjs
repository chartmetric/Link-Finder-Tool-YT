// Offline model-request proposal only. No executor, authorization writer or DB.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityArchivePath} from './youtube-video-identity-source.mjs';
import {verifyMixedIdentitySource} from './youtube-mixed-identity-source.mjs';
import {assembleYoutubeOwnershipEvidence} from './youtube-ownership-evidence.mjs';
import {youtubeOwnershipUrl,youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {evaluateYoutubeLink,YOUTUBE_LINK_POLICY} from './youtube-topic-links.mjs';
import {youtubeDecisionRequest} from './youtube-ownership-transport.mjs';

export const MIXED_IDENTITY_POLICY='exact-mixed-capture-identity-preparation-v1';
const clone=x=>JSON.parse(JSON.stringify(x));
const pair=x=>JSON.stringify([x.profileId,x.cmArtist]);
const aliasKey=x=>youtubeOwnershipUrl(x)?.toLowerCase();
const model={endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13'};

export function prepareMixedIdentityPlan(input){
  assert.match(input.id??'',/^youtube-mixed-identity-[a-z0-9-]{4,80}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.ok(input.runtimeFiles&&Object.keys(input.runtimeFiles).length);
  for(const [name,hash] of Object.entries(input.runtimeFiles)){
    identityArchivePath(name);assert.ok(name.startsWith('runtime/'));assert.match(hash,/^[a-f0-9]{64}$/);
  }
  const source=verifyMixedIdentitySource(input.source),p=source.plan;
  assert.ok(source.captures.every(c=>Date.parse(c.capture.capturedAt)<=Date.parse(input.preparedAt)));
  const claims=new Map();
  const add=(url,claim)=>{
    const key=aliasKey(url);if(!key)return;
    const owners=claims.get(key)??new Map();owners.set(pair(claim),{
      profileId:claim.profileId,cmArtist:claim.cmArtist});claims.set(key,owners);
  };
  // Include held/deferred leads and originals, not just the selected channels.
  for(const a of p.alternatives)add(a.url,a);
  for(const a of p.cohortClaims??[])add(a.url,a);
  for(const c of source.captures)for(const alias of c.aliases)add(alias,c.op);
  const operations=[],assessments=[];
  for(const c of source.captures){
    const a=source.artists.find(a=>pair(a.artist)===pair(c.op));assert.ok(a);
    const selection=p.selections.find(s=>pair(s)===pair(c.op));assert.ok(selection);
    const lead=p.alternatives.find(s=>pair(s)===pair(c.op)&&s.url===selection.url);
    assert.ok(lead&&lead.disposition==='selected_for_capture');
    const aliasConflicts=c.aliases.filter(url=>claims.get(aliasKey(url)).size>1)
      .map(alias=>({alias,claims:[...claims.get(aliasKey(alias)).values()]}));
    const direct=lead.observations.find(o=>o.source==='saved_direct_search');
    const candidate={url:selection.url,capture:c.capture,
      title:direct?.provenance.title??'',snippet:direct?.provenance.snippet??'',
      sourceUrl:direct?.provenance.sourceUrl??selection.url};
    // Preserve original discovery kinds. In particular, direct-search channels
    // must not be made to look as though a video uploader was ever observed.
    const artist=clone({...a.artist,ownershipEvidence:{
      ...assembleYoutubeOwnershipEvidence(a.artist,a.catalogPacket,candidate),
      mixedSourceDiscovery:{role:'discovery_not_independent_artist_ownership',
        sourceCapturePlanSha256:source.sourceBinding.planSha256,
        observations:lead.observations}}});
    const decision=evaluateYoutubeLink(artist,candidate,{sharedChannel:aliasConflicts.length>0});
    let prepared=null;
    if(decision.status==='needs_identity_check'){
      const policyInput=youtubeVerificationInput(artist,candidate);
      // Measure and freeze the complete request, never silently compact it to
      // fit the old 6 KB transport. This is a NEW byte-allowance proposal only.
      const request=youtubeDecisionRequest(policyInput,{model:{...model,maxRequestBytes:Number.MAX_SAFE_INTEGER}});
      prepared={input:policyInput,requestSha256:request.inputSha256,bytes:request.bytes,
        exceedsLegacy6000Bytes:request.bytes>6000};
      operations.push({key:`model-${c.op.profileId}-${c.op.cmArtist}-${c.channelId}`,kind:'model',
        profileId:c.op.profileId,cmArtist:c.op.cmArtist,channelId:c.channelId,
        request:request.request,inputSha256:request.inputSha256,policyInputSha256:policyInput.inputSha256,
        requestBodySha256:digest(Buffer.from(JSON.stringify(request.request.body))),
        requestBytes:request.bytes,reservationCents:2,
        catalogPacketSha256:a.catalogPacketSha256,discoveryEvidenceSha256:digest(lead),
        captureRunId:p.id,captureOperationKey:c.op.key,
        captureReceiptFileSha256:c.receiptFileSha256,captureRawBodySha256:c.rawBodySha256,
        // Independent kind-scoped non-replay identities, not just request hash.
        nonReplayKeys:{profileId:c.op.profileId,cmArtist:c.op.cmArtist,channelId:c.channelId},
        preservedMetadataAllocation:{runId:p.id,key:c.op.key,channelKey:c.op.allocationChannelKey,reservedCents:2}});
    }
    assessments.push({profileId:c.op.profileId,cmArtist:c.op.cmArtist,artistName:a.artist.name,tier:a.tier,
      channelId:c.channelId,aliases:c.aliases,aliasConflicts,
      catalogPacketSha256:a.catalogPacketSha256,discovery:clone(lead),artist,candidate,prepared,decision,
      category:decision.status==='supported_topic'?'supported_topic':
        decision.status==='likely_artist_owned'?'artist_owned_suggestion':'unresolved',
      channelTypeLabel:decision.channelType==='topic'?'Topic — auto-generated':decision.channelType,
      topicAssociationStatus:decision.channelType==='topic'
        ?decision.status==='supported_topic'?'supported':'unverified':null,
      artistOwned:decision.status==='likely_artist_owned',
      ownershipAccepted:false,liveLinkAccepted:false,importEligible:false,
      captureReceiptFileSha256:c.receiptFileSha256,captureRawBodySha256:c.rawBodySha256});
  }
  const proposedMaximumRequestBytes=Math.max(0,...operations.map(o=>o.requestBytes));
  return {version:MIXED_IDENTITY_POLICY,id:input.id,preparedAt:input.preparedAt,
    stage:'mixed_capture_identity_models',runtimeFiles:clone(input.runtimeFiles),source:clone(input.source),
    sourceBinding:source.sourceBinding,linkPolicy:YOUTUBE_LINK_POLICY,
    executable:false,explicitApproval:false,inheritsApproval:false,
    approvalStatus:'requires_separate_exact_model_cost_and_byte_allowance_approval',
    noAutomaticRetries:true,noCatalogWrites:true,noOldResultRewrites:true,fullCampaignRemainsPaused:true,
    ownershipAccuracy:null,accuracyStatus:'unmeasured_until_independent_source_review',
    model:{...model,legacyMaximumRequestBytes:6000,proposedMaximumRequestBytes,
      legacyExecutorsCompatible:false},
    assessments,operations,operationAllocationsSha256:digest(operations),
    allowedKinds:['model'],maximumCalls:operations.length,perOperationReservationCents:2,
    proposedMaximumSpendCents:operations.length*2,searchCalls:0,videoUploaderCalls:0,channelMetadataCalls:0,
    deferredAndHeldAlternatives:clone(p.alternatives.filter(a=>a.disposition!=='selected_for_capture')),
    uncapturedArtists:p.artists.filter(a=>!p.selections.some(s=>pair(s)===pair(a))).map(a=>({
      profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,status:'deferred_no_capture',
      noMatch:false,ownershipAccepted:false,importEligible:false})),
    preservedCaptureAllocations:p.operations.map(op=>({runId:p.id,key:op.key,kind:'metadata',
      profileId:op.profileId,cmArtist:op.cmArtist,channelKey:op.allocationChannelKey,
      inputSha256:op.inputSha256,reservedCents:op.reservationCents})),
    budget:{captureReservedCents:p.maximumSpendCents,captureBilledCredits:source.captures.reduce((n,c)=>n+c.billedCredits,0),
      proposedAdditionalModelReservationCents:operations.length*2,priorAllocationsReset:false,
      reservationIsNotInvoice:true,pricingConfirmed:false,
      warning:'Two cents per full-body model request is a proposed reservation, not a provider-enforced price ceiling. Confirm pricing and approve exact bodies, byte allowance and total cost separately before dispatch.'},
    executionPreconditions:[
      'Fresh explicit approval binding this plan hash, allocation hash, full request bytes, byte ceiling and model cost ceiling.',
      'Separate sealed mixed-source model executor; legacy video identity and 6000-byte transports are incompatible.',
      'Locked reconciliation of every prior source charge and all 13 capture receipts against the coordinator; local returns are not a fresh ledger attestation.',
      'Preserve all prior/uncertain reservations. Transactionally reject prior model allocations independently by profile, Chartmetric artist and canonical channel across runs.',
      'Recheck catalog identity/eligibility, current and historical channel/alias claims and stopped parent campaign; changes stop dispatch, never substitute requests.',
      'No searches, uploader calls, recaptures, redirects, alternate candidates, retries, catalog writes or automatic acceptance.',
    ]};
}
export function validateMixedIdentityPlan(plan){
  assert.deepEqual(prepareMixedIdentityPlan(plan),plan);return plan;
}

export function mixedIdentityApprovalProposal(plan){
  validateMixedIdentityPlan(plan);
  return {id:plan.id,policy:plan.version,planSha256:digest(plan),
    operationAllocationsSha256:plan.operationAllocationsSha256,
    status:'not_approved',explicitApproval:false,executionEnabled:false,
    exactModelCalls:plan.maximumCalls,proposedMaximumSpendCents:plan.proposedMaximumSpendCents,
    proposedMaximumRequestBytes:plan.model.proposedMaximumRequestBytes,
    requests:plan.operations.map(o=>({key:o.key,profileId:o.profileId,cmArtist:o.cmArtist,
      channelId:o.channelId,inputSha256:o.inputSha256,requestBodySha256:o.requestBodySha256,
      bytes:o.requestBytes,reservationCents:o.reservationCents})),
    pricingConfirmed:false,inheritsCaptureApproval:false,
    warning:plan.budget.warning,executionPreconditions:plan.executionPreconditions};
}
