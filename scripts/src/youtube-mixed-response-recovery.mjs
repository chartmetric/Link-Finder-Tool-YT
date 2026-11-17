// Pure audit contract. Never fetches, writes, refunds, claims ownership or retries.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertMixedApproval} from './youtube-mixed-capture-readiness.mjs';
import {normalizeYoutubeChannel,providerStopReason} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';
export const RECOVERY='exact-mixed-saved-response-recovery-v1';
export const CONTINUATION='exact-mixed-saved-response-suffix-v1';
const sha=/^[a-f0-9]{64}$/;
export function auditMixedSavedResponses(evidence){
  const {plan,approval,run,admissions,savedResponses,claims}=evidence;
  assertMixedApproval(plan,approval);
  assert.equal(run.id,plan.id);assert.equal(run.status,'stopped');
  assert.ok(typeof run.owner==='string'&&run.owner.length);
  for(const [k,v] of Object.entries({plan_sha256:digest(plan),approval_sha256:digest(approval),
    execution_sha256:digest(plan.runtimeFiles),cap_cents:plan.maximumSpendCents,
    reserved_cents:admissions.length*2}))assert.equal(run[k],v);
  assert.ok(admissions.length>0&&run.reserved_cents<=run.cap_cents);
  assert.equal(new Set(admissions.map(a=>a.operation_key)).size,admissions.length);
  assert.equal(savedResponses.length,admissions.length);
  assert.equal(new Set(savedResponses.map(s=>s.receipt.operationKey)).size,savedResponses.length);
  assert.ok(Array.isArray(claims),'Offline identity-claim snapshot required');
  // The unmodified mixed runner is sequential, with no pre-dispatch holds.
  assert.equal(admissions.length,plan.operations.slice(0,admissions.length).filter(o=>
    admissions.some(a=>a.operation_key===o.key)).length,'Admissions must be the exact paid prefix');
  const captures=[],recoverable=[];
  for(const [i,op] of plan.operations.slice(0,admissions.length).entries()){
    const row=admissions.find(a=>a.operation_key===op.key);assert.ok(row);
    for(const [k,v] of Object.entries({run_id:plan.id,profile_id:op.profileId,cm_artist:op.cmArtist,
      channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2}))
      assert.equal(row[k],v);
    const saved=savedResponses.find(s=>s.receipt.operationKey===op.key);assert.ok(saved);
    const {receipt}=saved,raw=Buffer.from(saved.rawBodyBase64,'base64');
    assert.equal(raw.toString('base64'),saved.rawBodyBase64);
    assert.ok(raw.length>0&&raw.length<=2*1024*1024);
    assert.match(saved.receiptFileSha256,sha);
    for(const [k,v] of Object.entries({runId:plan.id,planSha256:digest(plan),
      approvalSha256:digest(approval),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
      kind:'metadata',targetUrl:op.targetUrl,inputSha256:op.inputSha256,status:200,
      rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)}))assert.equal(receipt[k],v);
    assert.deepEqual(receipt.request,op.request);assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
    const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    assert.equal(body.success,true);
    assert.equal(providerStopReason({status:200,data:body}),null,'Provider failure remains unresolved');
    assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1,
      'Unknown or failed charge remains unresolved');
    const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound,'Unbound response remains unresolved');
    if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
    const observed=bound.aliases.map(alias=>({alias,channelId:bound.body.channelId,
      profileId:op.profileId,cmArtist:op.cmArtist}));
    assertNoNewIdentityClaims(observed,claims);
    if(row.status==='returned'){
      assert.equal(row.http_status,200);assert.equal(row.receipt_sha256,digest(receipt));
      assert.equal(row.raw_sha256,digest(raw));
    }else{
      assert.equal(row.status,'admitted');assert.equal(i,admissions.length-1);
      for(const k of ['http_status','receipt_sha256','raw_sha256'])assert.equal(row[k],null);
      recoverable.push(op.key);
    }
    captures.push({operationKey:op.key,receiptSha256:digest(receipt),rawSha256:digest(raw),
      capture,observed,ownershipAccepted:false,importEligible:false});
  }
  // Also reject conflicting aliases among the saved responses themselves.
  const observed=captures.flatMap(c=>c.observed);
  for(const claim of observed)assertNoNewIdentityClaims([claim],observed);
  assert.equal(recoverable.length,1,'Exactly one saved but unacknowledged response required');
  const pending=plan.operations.slice(admissions.length);
  assert.equal(run.reserved_cents+pending.length*2,plan.maximumSpendCents);
  return {evidenceSha256:digest(evidence),sourceRunId:plan.id,sourceOwner:run.owner,
    recoverableOperationKey:recoverable[0],captures,pending,
    priorReservedCents:run.reserved_cents,maximumAdditionalCents:pending.length*2,
    combinedCapCents:plan.maximumSpendCents,providerRequests:0,catalogWrites:0,
    ownershipAccepted:false,importEligible:false};
}
export function mixedRecoveryPlan(input){
  assert.match(input.id??'',/^youtube-mixed-response-recovery-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  const audit=auditMixedSavedResponses(input.evidence);
  assert.ok(input.runtimeFiles&&Object.keys(input.runtimeFiles).length);
  for(const [f,h] of Object.entries(input.runtimeFiles)){
    assert.match(f,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(h,sha);
  }
  return {version:RECOVERY,id:input.id,preparedAt:input.preparedAt,evidence:input.evidence,
    runtimeFiles:input.runtimeFiles,audit,maximumAdditionalCents:0,providerRequests:0,
    createOwnershipClaims:false,keepSourceStopped:true,catalogWrites:0};
}
export function approveMixedRecovery(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(mixedRecoveryPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,0);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256,capCents,approvedAt,explicitApproval:true,
    scope:'acknowledge_exact_saved_valid_response_only_no_dispatch_no_claims'};
}
export function mixedRecoveryContinuation(input){
  const {recoveryPlan,recoveryApproval}=input;
  assert.deepEqual(approveMixedRecovery(recoveryPlan,recoveryApproval),recoveryApproval);
  assert.match(input.id??'',/^youtube-mixed-captures-recovered-[a-z0-9-]{4,60}$/);
  assert.ok(Date.parse(input.preparedAt)>=Date.parse(recoveryApproval.approvedAt));
  const {audit,evidence}=recoveryPlan,source=evidence.plan;
  assert.ok(audit.pending.length,'No untouched remainder');
  assert.ok(input.runtimeFiles&&Object.keys(input.runtimeFiles).length);
  for(const [f,h] of Object.entries(input.runtimeFiles)){
    assert.match(f,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(h,sha);
  }
  const profiles=new Set(audit.pending.map(o=>o.profileId));
  return {version:CONTINUATION,id:input.id,preparedAt:input.preparedAt,recoveryPlan,recoveryApproval,
    runtimeFiles:input.runtimeFiles,operations:audit.pending,
    selections:source.selections.filter(s=>profiles.has(s.profileId)),maximumCalls:audit.pending.length,
    maximumSpendCents:audit.maximumAdditionalCents,priorReservedCents:audit.priorReservedCents,
    combinedCapCents:audit.combinedCapCents,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0};
}
export function approveMixedRecoveryContinuation(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(mixedRecoveryContinuation(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  assert.equal(plan.priorReservedCents+capCents,plan.combinedCapCents);
  return {id:plan.id,planSha256,capCents,approvedAt,explicitApproval:true,
    combinedCapCents:plan.combinedCapCents,scope:'exact_untouched_metadata_suffix_only_no_retries'};
}
