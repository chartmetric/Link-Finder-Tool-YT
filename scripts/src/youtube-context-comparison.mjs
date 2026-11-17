// Exact, separately approved model-only comparison. Never an import route.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {boundUploaderContext,revisedContextRequest} from './youtube-context-revision.mjs';
import {parseCombinedResponse} from './youtube-combined-ownership.mjs';
import {reviewedVerificationPlan,approveReviewedVerification,reviewedVerificationResult,
  reviewedVerificationReadiness,reviewedVerificationSnapshot} from './youtube-reviewed-verification.mjs';
import {boundedComparisonGate} from './youtube-ownership-comparison-gate.mjs';

export const CONTEXT_COMPARISON='youtube-reviewed-context-comparison-v1';
export function contextComparisonOperation(previous,row,packets,baselineResult,admission){
  assert.equal(previous.caseId,row.caseId);
  const contexts=packets.map(p=>boundUploaderContext(row,p.result,p.receipt,Buffer.from(p.rawBase64,'base64')));
  const proposal=revisedContextRequest(previous.proposal.originalOperation,row.capture,contexts);
  assert.notEqual(proposal.requestSha256,previous.inputSha256,'Never repeat a paid baseline request');
  for(const [key,value] of Object.entries({operation_key:previous.key,profile_id:row.profileId,
    kind:'model',input_sha256:previous.inputSha256,reserved_cents:2,status:'returned',http_status:200}))
    assert.equal(admission[key],value);
  for(const key of ['profileId','cmArtist','channelId'])assert.equal(baselineResult[key],previous[key]);
  return {key:'context-'+row.caseId,kind:'model',caseId:row.caseId,profileId:row.profileId,
    cmArtist:row.cmArtist,channelId:row.channelId,proposal,request:proposal.request,
    inputSha256:proposal.requestSha256,requestBytes:proposal.requestBytes,proposedReservationCents:2,
    baselineResult,baselineAdmission:admission,ownershipAccepted:false,importEligible:false};
}

export const contextComparisonPlan=immutableValidationCache(function(p){
  assert.equal(p.version,CONTEXT_COMPARISON);
  assert.match(p.id,/^youtube-context-comparison-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(p.preparedAt)));
  assert.deepEqual(reviewedVerificationPlan(p.baselinePlan),p.baselinePlan);
  assert.deepEqual(approveReviewedVerification(p.baselinePlan,p.baselineApproval),p.baselineApproval);
  assert.equal(p.baselineResponses.length,14);assert.equal(p.operations.length,14);
  assert.equal(p.selections.length,14);assert.equal(p.maximumSpendCents,28);
  assert.equal(p.coordinatorSchemaSha256,p.baselinePlan.coordinatorSchemaSha256);
  const oldGroup=p.baselinePlan.groups[0],admissions=[];
  assert.equal(p.baselineLedgerSnapshot.runs.length,1);
  assert.deepEqual(p.baselineLedgerSnapshot.runs[0],{id:oldGroup.id,status:'completed',
    scope_sha256:digest({group:oldGroup,approval:p.baselineApproval,runtimeFiles:p.baselinePlan.runtimeFiles}),
    cap_cents:28,reserved_cents:28});
  assert.equal(new Set(p.baselineResponses.map(r=>r.operationKey)).size,14);
  assert.equal(new Set(p.videoPackets.map(r=>r.caseId)).size,p.videoPackets.length);
  assert.ok(p.videoPackets.every(v=>p.baselinePlan.inputs.some(i=>i.caseId===v.caseId)));
  for(const field of ['key','profileId','cmArtist','channelId'])
    assert.equal(new Set(p.operations.map(o=>o[field])).size,14);
  let tier=0;
  for(const previous of p.baselinePlan.operations){
    const row=p.baselinePlan.inputs.find(i=>i.caseId===previous.caseId);
    const saved=p.baselineResponses.find(r=>r.operationKey===previous.key);assert.ok(saved);
    assert.equal(saved.receipt.approvalSha256,digest(p.baselineApproval));
    assert.equal(saved.receipt.rawPath,'receipts/'+digest(previous.key)+'.raw');
    const raw=Buffer.from(saved.rawBase64,'base64');
    const result=reviewedVerificationResult(p.baselinePlan,previous,saved.receipt,raw);
    const admission={run_id:oldGroup.id,operation_key:previous.key,profile_id:previous.profileId,
      kind:'model',input_sha256:previous.inputSha256,reserved_cents:2,status:'returned',
      receipt_sha256:digest(saved.receipt),http_status:200};
    admissions.push(admission);
    const packets=p.videoPackets.find(v=>v.caseId===row.caseId)?.packets??[];
    const op=p.operations.find(o=>o.caseId===row.caseId);assert.ok(op);
    assert.deepEqual(op,contextComparisonOperation(previous,row,packets,result,admission));
    const s=p.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);
    assert.ok(s&&[1,2,3,4,5].includes(s.tier));assert.equal(s.artist,row.artist.name);
    assert.doesNotMatch(JSON.stringify(op.request.body),
      /"(?:userFeedback|userReview|grading|expectedVerdict|labelScope)"\s*:/i);
    const folder=p.baselineRoot+'/part-1/receipts/'+digest(previous.key);
    assert.equal(p.sourceFiles[folder+'.json'],digest(Buffer.from(JSON.stringify(saved.receipt))));
    assert.equal(p.sourceFiles[folder+'.raw'],digest(raw));
  }
  assert.deepEqual([...admissions].sort((a,b)=>a.operation_key.localeCompare(b.operation_key)),
    p.baselineLedgerSnapshot.admissions);
  for(const op of p.operations){
    const s=p.selections.find(s=>s.profileId===op.profileId);
    assert.ok(s.tier>=tier);tier=s.tier;
  }
  assert.equal(p.baselineRoot,'generated-artifacts/'+p.baselinePlan.id);
  for(const [f,sha] of Object.entries(p.baselinePlan.sourceFiles))assert.equal(p.sourceFiles[f],sha);
  for(const [f,sha] of Object.entries(p.baselinePlan.runtimeFiles))assert.equal(p.sourceFiles[p.baselineRoot+'/'+f],sha);
  assert.ok(Object.keys(p.runtimeFiles).length);
  for(const [f,sha] of Object.entries(p.runtimeFiles)){
    assert.match(f,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [f,sha] of Object.entries(p.sourceFiles)){
    assert.ok(f.startsWith('generated-artifacts/')&&!f.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.equal(p.pricing.id,'typesafe/jev-1.13');
  assert.ok(Number(p.pricing.promptUsdPerToken)>0&&Number(p.pricing.promptUsdPerToken)<=.000000042);
  assert.equal(Number(p.pricing.completionUsdPerToken),0);
  assert.ok(p.pricing.contextTokens>=262144);
  assert.equal(p.maximumRequestBytes,Math.max(...p.operations.map(o=>o.requestBytes)));
  assert.ok(p.maximumRequestBytes<p.pricing.contextTokens);
  return {...p,groups:[{id:p.id+'-part-1',groupIndex:0,operations:p.operations,maximumCalls:14,maximumSpendCents:28}],
    executionEnabled:false,requiresFreshSpendingApproval:true,experimental:true,noRetries:true,
    searchCalls:0,metadataCalls:0,catalogWrites:0,channelClaimWrites:0,ownershipAccepted:false,importEligible:false,
    ownershipAccuracyScorable:false,heldOut:false,policyActivated:false,
    caveat:'Historical-feedback diagnostic, not held-out accuracy. Newly included saved uploader context exists for seven rejected examples only. Compare raw answers, report abstentions separately, and do not credit known-review safety vetoes as model agreement.'};
});
export function approveContextComparison(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(contextComparisonPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,28);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    runtimeSha256:digest(plan.runtimeFiles),operationAllocationsSha256:digest(plan.operations),
    scope:'Exactly 14 changed single-choice Jev requests on the frozen reviewed pairs. Intentionally incorrect pairs use the diagnostic ledger only, without ownership-claim registration. Compare against exact returned baselines. No paid baseline replay, new evidence collection, sourcing, retries, substitutions, policy activation, acceptance, grading changes or catalog writes.'};
}
export async function rejectContextReplay(c,operations,ownRun=''){
  for(const op of operations){
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE kind='model' AND (profile_id=$1 OR cm_artist=$2 OR channel_id=$3)`,
    [op.profileId,op.cmArtist,op.channelId])).rows[0].n,0);
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions
      WHERE kind='model' AND profile_id=$1`,[op.profileId])).rows[0].n,0);
    const prior=(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
      status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
      WHERE kind='model' AND (profile_id=$1 OR input_sha256=$3) AND run_id<>$2 ORDER BY run_id,operation_key`,
    [op.profileId,ownRun,op.inputSha256])).rows;
    assert.deepEqual(prior,[op.baselineAdmission],'Only the exact returned reviewed baseline is permitted');
  }
}
export async function contextReadiness(c,plan,options={}){
  const rows=await reviewedVerificationReadiness(c,{...plan.baselinePlan,
    coordinatorSchemaSha256:plan.coordinatorSchemaSha256,
    runtimeFiles:plan.runtimeFiles,maximumSpendCents:28},options);
  assert.deepEqual(await reviewedVerificationSnapshot(c,plan.baselineLedgerSnapshot.runs.map(r=>r.id)),
    plan.baselineLedgerSnapshot,'Paid baseline changed');
  return rows;
}
export function contextComparisonGate({pool,plan,approval,owner,checkCatalog}){
  return boundedComparisonGate({pool,plan,approval,owner,checkCatalog,readiness:contextReadiness,
    rejectReplay:rejectContextReplay,checkClaims:async(c,ops)=>{for(const op of ops)await checkCatalog(op);}});
}
export function contextComparisonResult(plan,op,receipt,raw){
  assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
  for(const [k,v] of Object.entries({runId:plan.groups[0].id,parentId:plan.id,
    planSha256:digest(plan.groups[0]),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
    channelId:op.channelId,kind:'model',inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw)}))
    assert.equal(receipt[k],v);
  assert.deepEqual(receipt.request,op.request);
  const previous=plan.baselinePlan.operations.find(o=>o.caseId===op.caseId),row=plan.baselinePlan.inputs.find(i=>i.caseId===op.caseId);
  const contexts=(plan.videoPackets.find(v=>v.caseId===op.caseId)?.packets??[])
    .map(p=>boundUploaderContext(row,p.result,p.receipt,Buffer.from(p.rawBase64,'base64')));
  assert.deepEqual(op.proposal,revisedContextRequest(previous.proposal.originalOperation,row.capture,contexts));
  const result=parseCombinedResponse({...op.proposal,originalOperation:previous.proposal.originalOperation,
    originalCapture:row.capture,stateSha256:digest({policy:CONTEXT_COMPARISON,state:op.request.body.state})},
  {...receipt,data:JSON.parse(raw)});
  const category=result.modelAssessment.category;
  const outcome=['artist_managed_supported','topic_identity_supported'].includes(category)?'supports_link':
    ['third_party_channel','different_artist'].includes(category)?'rejects_link':'unresolved';
  const feedback=plan.baselinePlan.grading.find(g=>g.caseId===op.caseId);
  const capturedTopic=row.capture.body.isAutoGenerated===true||/[-–—]\s*topic$/iu.test(row.capture.body.displayName);
  return {...result,channelTypeLabel:capturedTopic?'Topic — auto-generated':result.channelTypeLabel,
    baselineAssessment:op.baselineResult.modelAssessment,
    feedbackComparison:{historicalFeedback:feedback.userFeedback,rawModelOutcome:outcome,
      agreesWithHistoricalFeedback:outcome==='unresolved'?null:
        outcome===(feedback.userFeedback==='rejected'?'rejects_link':'supports_link'),
      safetyVetoCountedAsAgreement:false,heldOut:false,ownershipAccuracyScorable:false},channelClaimWrites:0};
}
