// A separately approved, model-only comparison. Never an import route.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {clarifiedOwnershipRequest} from './youtube-ownership-clarity.mjs';
import {COMPARISON_POLICY} from './youtube-ownership-comparison.mjs';
import {combinedOwnershipRequest,parseCombinedOwnership} from './youtube-combined-ownership.mjs';
import {comparisonReadiness,boundedComparisonGate} from './youtube-ownership-comparison-gate.mjs';

export const COMBINED_COMPARISON_POLICY='saved-youtube-combined-comparison-v1';
export function combinedOperation(draft,previousResult,originalAdmission,comparisonAdmission){
  assert.deepEqual(draft,combinedOwnershipRequest(draft.originalOperation,draft.originalCapture));
  const original=draft.originalOperation;
  const previous=clarifiedOwnershipRequest(original,draft.originalCapture);
  for(const key of ['profileId','cmArtist','channelId']){
    assert.equal(previousResult[key],original[key]);
    assert.equal(previousResult.baseline[key],original[key]);
  }
  assert.equal(previousResult.modelAnswer.requestSha256,digest(previous.request));
  assert.equal(previousResult.modelAnswer.inputSha256,digest({policy:COMPARISON_POLICY,state:previous.request.body.state}));
  assert.equal(previousResult.baseline.modelAnswer.requestSha256,original.inputSha256);
  assert.equal(previousResult.baseline.modelAnswer.inputSha256,original.policyInputSha256);
  assert.equal(previousResult.ownershipAccepted,false);assert.equal(previousResult.importEligible,false);
  for(const [row,expected] of [
    [originalAdmission,{operation_key:original.key,profile_id:original.profileId,cm_artist:original.cmArtist,
      channel_id:original.channelId,kind:'model',input_sha256:original.inputSha256,
      reserved_cents:2,status:'returned',http_status:200}],
    [comparisonAdmission,{operation_key:'compare-'+original.profileId+'-'+original.channelId,
      profile_id:original.profileId,kind:'model',input_sha256:digest(previous.request),
      reserved_cents:2,status:'returned',http_status:200}],
  ]){
    for(const [key,value] of Object.entries(expected))assert.equal(row[key],value);
    assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);
  }
  assert.match(originalAdmission.raw_sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(draft.requestSha256,original.inputSha256);
  assert.notEqual(draft.requestSha256,previousResult.modelAnswer.requestSha256);
  return {key:'combined-'+original.profileId+'-'+original.channelId,kind:'model',
    profileId:original.profileId,cmArtist:original.cmArtist,channelId:original.channelId,
    request:draft.request,inputSha256:draft.requestSha256,requestBytes:draft.requestBytes,
    proposedReservationCents:2,draft,
    baseline:{previousResult,originalAdmission,comparisonAdmission},
    ownershipAccepted:false,importEligible:false};
}
export const combinedComparisonPlan=immutableValidationCache(function(p){
  assert.equal(p.version,COMBINED_COMPARISON_POLICY);
  assert.match(p.id,/^youtube-combined-comparison-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(p.preparedAt)));
  assert.ok(p.operations.length>0&&p.operations.length<=13);
  assert.equal(p.maximumSpendCents,p.operations.length*2);
  assert.equal(p.maximumRequestBytes,Math.max(...p.operations.map(o=>o.requestBytes)));
  assert.equal(p.pricing.id,'typesafe/jev-1.13');
  assert.ok(Number(p.pricing.promptUsdPerToken)>0&&Number(p.pricing.promptUsdPerToken)<=.000000042);
  assert.equal(Number(p.pricing.completionUsdPerToken),0);
  assert.ok(p.pricing.contextTokens>=262144&&p.maximumRequestBytes<p.pricing.contextTokens);
  assert.ok(Object.keys(p.runtimeFiles).length&&Object.keys(p.sourceFiles).length);
  for(const [name,sha] of Object.entries(p.runtimeFiles)){
    assert.match(name,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [name,sha] of Object.entries(p.sourceFiles)){
    assert.ok(name.startsWith('generated-artifacts/')&&!name.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.match(p.coordinatorSchemaSha256,/^[a-f0-9]{64}$/);
  assert.equal(p.failedLaunch.status,'stopped');assert.equal(p.failedLaunch.reservedCents,0);
  assert.equal(p.failedLaunch.admissions,0);assert.match(p.failedLaunch.scopeSha256,/^[a-f0-9]{64}$/);
  assert.match(p.failedLaunch.id,/^youtube-ownership-comparison-[a-z0-9-]+-part-1$/);
  assert.ok(p.priorBoundedLedgerSnapshot.runs.length);
  for(const row of p.priorBoundedLedgerSnapshot.runs){
    const admissions=p.priorBoundedLedgerSnapshot.admissions.filter(a=>a.run_id===row.id);
    assert.equal(row.status,'completed');assert.equal(row.reserved_cents,admissions.length*2);
    assert.ok(row.cap_cents>=row.reserved_cents);
  }
  for(const field of ['key','profileId','cmArtist','channelId'])
    assert.equal(new Set(p.operations.map(o=>o[field])).size,p.operations.length);
  assert.equal(p.selections.length,p.operations.length);let previousTier=0;
  for(const op of p.operations){
    const b=op.baseline;
    assert.deepEqual(op,combinedOperation(op.draft,b.previousResult,b.originalAdmission,b.comparisonAdmission));
    const selection=p.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);
    assert.ok(selection&&[1,2,3,4,5].includes(selection.tier)&&selection.tier>=previousTier);
    assert.equal(selection.artist,op.request.body.state.artist.name);previousTier=selection.tier;
    for(const [snapshot,admission] of [
      [p.baselineLedgerSnapshot,b.originalAdmission],[p.priorBoundedLedgerSnapshot,b.comparisonAdmission],
    ]){
      assert.deepEqual(snapshot.admissions.find(a=>a.run_id===admission.run_id&&a.operation_key===admission.operation_key),admission);
      assert.equal(snapshot.runs.find(r=>r.id===admission.run_id)?.status,'completed');
    }
  }
  return {...p,groups:[{id:p.id+'-part-1',groupIndex:0,operations:p.operations,
    maximumCalls:p.operations.length,maximumSpendCents:p.maximumSpendCents}],
    executionEnabled:false,requiresFreshSpendingApproval:true,experimental:true,
    noRetries:true,catalogWrites:0,importEligible:false,baselineIsGroundTruth:false};
});
export function approveCombinedComparison(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(combinedComparisonPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    maximumRequestBytes:plan.maximumRequestBytes,operationAllocationsSha256:digest(plan.operations),
    runtimeSha256:digest(plan.runtimeFiles),
    scope:'One new combined-assessment request per named artist/channel. Compare only with the two frozen returned baselines. No historical replay, sourcing, substitutions, retries, policy activation, acceptance or catalog writes.'};
}
export async function priorCombinedSnapshot(c,ids){
  return {
    runs:(await c.query(`SELECT id,status,scope_sha256,cap_cents,reserved_cents
      FROM youtube_discovery_test_runs WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows,
    admissions:(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
      status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
      WHERE run_id=ANY($1::text[]) ORDER BY run_id,operation_key`,[ids])).rows,
  };
}
export async function rejectCombinedReplay(c,operations,ownRun=''){
  for(const op of operations){
    const original=(await c.query(`SELECT run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,
      reserved_cents,status,http_status,receipt_sha256,raw_sha256 FROM youtube_video_identity_admissions
      WHERE kind='model' AND (profile_id=$1 OR cm_artist=$2 OR channel_id=$3)`,
    [op.profileId,op.cmArtist,op.channelId])).rows;
    assert.deepEqual(original,[op.baseline.originalAdmission],'Only the exact first returned baseline is allowed');
    const prior=(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
      status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
      WHERE kind='model' AND profile_id=$1 AND run_id<>$2`,[op.profileId,ownRun])).rows;
    assert.deepEqual(prior,[op.baseline.comparisonAdmission],'Only the exact returned comparison baseline is allowed');
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions
      WHERE kind='model' AND profile_id=$1`,[op.profileId])).rows[0].n,0);
  }
}
export async function combinedReadiness(c,plan,options={}){
  const rows=await comparisonReadiness(c,plan,options);
  assert.deepEqual(await priorCombinedSnapshot(c,plan.priorBoundedLedgerSnapshot.runs.map(r=>r.id)),
    plan.priorBoundedLedgerSnapshot,'Prior paid comparison changed');
  return rows;
}
export function combinedComparisonGate(options){
  return boundedComparisonGate({...options,readiness:combinedReadiness,rejectReplay:rejectCombinedReplay});
}
export function combinedComparisonResult(plan,op,receipt,raw){
  const b=op.baseline;
  assert.deepEqual(op,combinedOperation(op.draft,b.previousResult,b.originalAdmission,b.comparisonAdmission));
  assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
  for(const [key,value] of Object.entries({runId:plan.groups[0].id,parentId:plan.id,
    planSha256:digest(plan.groups[0]),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
    channelId:op.channelId,kind:'model',inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw)}))
    assert.equal(receipt[key],value);
  assert.deepEqual(receipt.request,op.request);
  return {...parseCombinedOwnership(op.draft,{...receipt,data:JSON.parse(raw)}),
    baseline:b.previousResult,baselineIsGroundTruth:false};
}
