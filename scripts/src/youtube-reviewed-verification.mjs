// Historical-feedback diagnostic only. No acceptance or ownership-claim writes.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {combinedOwnershipRequest,parseCombinedOwnership} from './youtube-combined-ownership.mjs';
import {reviewedInput,reviewedCohort,reviewedCapturePlan,approveReviewedCaptures,
  reviewedCaptureResult,validateReviewedRecovery} from './youtube-reviewed-test.mjs';
import {boundedComparisonGate,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';

export const REVIEWED_VERIFICATION_POLICY='historical-reviewed-youtube-single-choice-v1';
const sorted=rows=>[...rows].sort((a,b)=>String(a.id??a.run_id).localeCompare(String(b.id??b.run_id))||
  String(a.operation_key??'').localeCompare(String(b.operation_key??'')));
export function reviewedVerificationEvidence(sourceRoot,source,approval,responses){
  assert.equal(sourceRoot,'generated-artifacts/'+source.id);
  assert.deepEqual(reviewedCapturePlan(source),source);
  assert.deepEqual(approveReviewedCaptures(source,approval),approval);
  const recovered=validateReviewedRecovery(source),group=source.groups[0];
  assert.equal(responses.length,source.operations.length);
  assert.equal(new Set(responses.map(r=>r.operationKey)).size,responses.length);
  const captured=new Map(),admissions=[recovered.admission];
  for(const op of source.operations){
    const r=responses.find(r=>r.operationKey===op.key);assert.ok(r);
    const {receipt}=r,raw=Buffer.from(r.rawBodyBase64,'base64');
    assert.equal(receipt.approvalSha256,digest(approval));
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const result=reviewedCaptureResult(source,op,receipt,raw);
    captured.set(op.profileId,{capture:result.capture,refs:[
      sourceRoot+'/part-1/receipts/'+digest(op.key)+'.json',sourceRoot+'/part-1/'+receipt.rawPath]});
    admissions.push({run_id:group.id,operation_key:op.key,profile_id:op.profileId,kind:'metadata',
      input_sha256:op.inputSha256,reserved_cents:2,status:'returned',receipt_sha256:digest(receipt),http_status:200});
  }
  const inputs=source.inputs.map(i=>{
    if(i.channelCaptureAvailable)return i;
    const saved=captured.get(i.profileId);assert.ok(saved);
    return reviewedInput({...i,capture:saved.capture,sourceRefs:[...i.sourceRefs,...saved.refs]});
  });
  const grading=source.grading,cohort=reviewedCohort(inputs,grading);
  assert.equal(cohort.summary.examples,14);assert.equal(cohort.summary.savedChannelCaptures,14);
  return {inputs,grading,sourceLedgerSnapshot:{runs:sorted([recovered.run,{
    id:group.id,status:'completed',scope_sha256:digest({group,approval,runtimeFiles:source.runtimeFiles}),
    cap_cents:group.maximumSpendCents,reserved_cents:group.operations.length*2}]),admissions:sorted(admissions)}};
}
export function reviewedVerificationOperation(row){
  assert.deepEqual(reviewedInput(row),row);assert.ok(row.channelCaptureAvailable);
  const prepared=youtubeDecisionRequest(row.inputPreview,{model:{expectedModel:'typesafe/jev-1.13',
    endpoint:'https://openrouter.ai/api/alpha/decisions',maxRequestBytes:262143}});
  const template={key:'unsent-template-'+row.caseId,kind:'model',profileId:row.profileId,
    cmArtist:row.cmArtist,channelId:row.channelId,request:prepared.request,
    inputSha256:digest(prepared.request),policyInputSha256:row.inputPreview.inputSha256,
    requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),
    requestBytes:Buffer.byteLength(JSON.stringify(prepared.request.body)),proposedReservationCents:2};
  const proposal=combinedOwnershipRequest(template,row.capture);
  return {key:'reviewed-model-'+row.caseId,kind:'model',profileId:row.profileId,cmArtist:row.cmArtist,
    channelId:row.channelId,caseId:row.caseId,sourceInputSha256:digest(row),proposal,
    request:proposal.request,inputSha256:proposal.requestSha256,requestBytes:proposal.requestBytes,
    proposedReservationCents:2,templateRequestWasNeverSent:true,ownershipAccepted:false,importEligible:false};
}
export const reviewedVerificationPlan=immutableValidationCache(function(p){
  assert.equal(p.version,REVIEWED_VERIFICATION_POLICY);
  assert.match(p.id,/^youtube-reviewed-verification-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(p.preparedAt)));
  const evidence=reviewedVerificationEvidence(p.sourceRoot,p.captureSourcePlan,p.captureSourceApproval,p.captureResponses);
  for(const key of ['inputs','grading','sourceLedgerSnapshot'])assert.deepEqual(p[key],evidence[key]);
  assert.equal(p.operations.length,14);assert.equal(p.maximumSpendCents,28);
  assert.equal(p.selections.length,14);
  for(const key of ['key','profileId','cmArtist','channelId'])
    assert.equal(new Set(p.operations.map(o=>o[key])).size,14);
  let tier=0;
  for(const op of p.operations){
    const row=p.inputs.find(i=>i.caseId===op.caseId);assert.ok(row);
    assert.deepEqual(op,reviewedVerificationOperation(row));
    const s=p.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);
    assert.ok(s&&[1,2,3,4,5].includes(s.tier)&&s.tier>=tier);
    assert.equal(s.artist,row.artist.name);tier=s.tier;
  }
  assert.equal(p.maximumRequestBytes,Math.max(...p.operations.map(o=>o.requestBytes)));
  const q=p.pricing;assert.equal(q.id,'typesafe/jev-1.13');
  assert.equal(q.endpoint,'https://openrouter.ai/api/v1/models?output_modalities=decisions');
  assert.ok(Number.isFinite(Date.parse(q.observedAt)));
  assert.ok(Number(q.promptUsdPerToken)>0&&Number(q.promptUsdPerToken)<=.000000042);
  assert.equal(Number(q.completionUsdPerToken),0);
  assert.ok(q.contextTokens>=262144&&p.maximumRequestBytes<q.contextTokens);
  assert.match(p.coordinatorSchemaSha256,/^[a-f0-9]{64}$/);
  assert.equal(p.coordinatorSchemaSha256,p.captureSourcePlan.coordinatorSchemaSha256);
  assert.ok(Object.keys(p.sourceFiles).length&&Object.keys(p.runtimeFiles).length);
  for(const [name,sha] of Object.entries(p.sourceFiles)){
    assert.ok(name.startsWith('generated-artifacts/')&&!name.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [name,sha] of Object.entries(p.runtimeFiles)){
    assert.match(name,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [name,sha] of Object.entries(p.captureSourcePlan.sourceFiles))assert.equal(p.sourceFiles[name],sha);
  for(const [name,sha] of Object.entries(p.captureSourcePlan.runtimeFiles))assert.equal(p.sourceFiles[p.sourceRoot+'/'+name],sha);
  for(const name of ['plan.json','approval.json','summary.json','results.json','recovery.json'])
    assert.match(p.sourceFiles[p.sourceRoot+'/'+name]??'',/^[a-f0-9]{64}$/);
  for(const r of p.captureResponses){
    const op=p.captureSourcePlan.operations.find(o=>o.key===r.operationKey);
    assert.equal(p.sourceFiles[p.sourceRoot+'/part-1/'+r.receipt.rawPath],digest(Buffer.from(r.rawBodyBase64,'base64')));
    assert.equal(p.sourceFiles[p.sourceRoot+'/part-1/receipts/'+digest(op.key)+'.json'],
      digest(Buffer.from(JSON.stringify(r.receipt))));
  }
  return {...p,groups:[{id:p.id+'-part-1',groupIndex:0,operations:p.operations,
    maximumCalls:14,maximumSpendCents:28}],executionEnabled:false,requiresFreshSpendingApproval:true,
    modelOnly:true,noRetries:true,searchCalls:0,metadataCalls:0,catalogWrites:0,channelClaimWrites:0,
    ownershipAccepted:false,importEligible:false,gradingHiddenFromRequests:true,experimental:true,
    heldOut:false,ownershipAccuracyScorable:false,labelsReadjudicated:false,templateRequestsWereNeverSent:true,
    evaluationPolicy:'Compare raw model assessments with historical user feedback only. Batch-level positive feedback is not individually adjudicated ownership. Report abstentions separately; never count them as correct rejections. Existing user-review safety vetoes are reported separately and cannot improve feedback-agreement counts. No population accuracy, production acceptance or policy activation.'};
});
export function approveReviewedVerification(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(reviewedVerificationPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,28);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    maximumRequestBytes:plan.maximumRequestBytes,operationAllocationsSha256:digest(plan.operations),
    runtimeSha256:digest(plan.runtimeFiles),
    scope:'Exactly 14 new single-choice Jev requests on the fixed reviewed examples, including intentionally incorrect pairs. Historical feedback stays outside requests. Diagnostic ledger only; no ownership-claim registration. No searches, captures, retries, historical request replay, source-trust declarations, grading refresh, accuracy calibration, policy activation, acceptance or catalog writes.'};
}
export async function reviewedVerificationSnapshot(c,ids){
  return {
    runs:(await c.query(`SELECT id,status,scope_sha256,cap_cents,reserved_cents FROM youtube_discovery_test_runs
      WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows,
    admissions:(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
      status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
      WHERE run_id=ANY($1::text[]) ORDER BY run_id,operation_key`,[ids])).rows};
}
export async function rejectReviewedVerificationReplay(c,operations,ownRun=''){
  for(const op of operations){
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE kind='model' AND (profile_id=$1 OR cm_artist=$2 OR channel_id=$3)`,
    [op.profileId,op.cmArtist,op.channelId])).rows[0].n,0);
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions
      WHERE kind='model' AND profile_id=$1`,[op.profileId])).rows[0].n,0);
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
      WHERE kind='model' AND (profile_id=$1 OR input_sha256=$3) AND run_id<>$2`,
    [op.profileId,ownRun,op.inputSha256])).rows[0].n,0);
  }
}
export async function reviewedVerificationReadiness(c,plan,options={}){
  const rows=await boundedExperimentReadiness(c,plan,options);
  assert.deepEqual(await reviewedVerificationSnapshot(c,plan.sourceLedgerSnapshot.runs.map(r=>r.id)),
    plan.sourceLedgerSnapshot,'Saved transport evidence changed');
  return rows;
}
export function reviewedVerificationGate({pool,plan,approval,owner,checkCatalog}){
  // Intentionally wrong diagnostic pairs must not seed or pass ownership claims.
  return boundedComparisonGate({pool,plan,approval,owner,readiness:reviewedVerificationReadiness,
    rejectReplay:rejectReviewedVerificationReplay,checkClaims:async(c,operations)=>{
      for(const op of operations)await checkCatalog(op);
    }});
}
export function reviewedVerificationResult(plan,op,receipt,raw){
  assert.deepEqual(op,plan.operations.find(o=>o.key===op.key));
  for(const [key,value] of Object.entries({runId:plan.groups[0].id,parentId:plan.id,
    planSha256:digest(plan.groups[0]),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
    channelId:op.channelId,kind:'model',inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw)}))
    assert.equal(receipt[key],value);
  assert.deepEqual(receipt.request,op.request);
  const parsed=parseCombinedOwnership(op.proposal,{...receipt,data:JSON.parse(raw)});
  const feedback=plan.grading.find(g=>g.caseId===op.caseId);
  const category=parsed.modelAssessment.category;
  const outcome=['artist_managed_supported','topic_identity_supported'].includes(category)?'supports_link':
    ['third_party_channel','different_artist'].includes(category)?'rejects_link':'unresolved';
  const agrees=outcome==='unresolved'?null:outcome===(feedback.userFeedback==='rejected'?'rejects_link':'supports_link');
  const row=plan.inputs.find(i=>i.caseId===op.caseId);
  const capturedTopic=row.capture.body.isAutoGenerated===true||/[-–—]\s*topic$/iu.test(row.capture.body.displayName);
  return {...parsed,channelTypeLabel:capturedTopic?'Topic — auto-generated':parsed.channelTypeLabel,
    feedbackComparison:{historicalFeedback:feedback.userFeedback,labelScope:feedback.labelScope,
      rawModelOutcome:outcome,agreesWithHistoricalFeedback:agrees,
      productionSafetyStatus:parsed.decision.status,safetyVetoCountedAsAgreement:false,
      heldOut:false,ownershipAccuracyScorable:false},channelClaimWrites:0};
}
