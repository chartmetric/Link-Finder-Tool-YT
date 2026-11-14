// A conflicting provider response can be acknowledged as received, never
// converted into an artist/channel match. No network or writes in validation.
import assert from 'node:assert/strict';
import {digest,normalizeDiscoveryVideo} from './youtube-video-discovery-offline.mjs';
import {validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';

export const CONFLICT_RECOVERY_POLICY='saved-uploader-conflict-continuation-v1';
const sha=/^[a-f0-9]{64}$/;
const channel=/^UC[A-Za-z0-9_-]{22}$/;
const admissionFields=['operation_key','profile_id','cm_artist','video_id','input_sha256'];

export function validateConflictResponse(op,receipt,rawBody){
  assert.equal(receipt.operationKey,op.key);
  assert.equal(receipt.profileId,op.profileId);assert.equal(receipt.cmArtist,op.cmArtist);
  assert.equal(receipt.videoId,op.videoId);assert.equal(receipt.kind,'video_uploader');
  assert.deepEqual(receipt.request,op.request);assert.equal(receipt.inputSha256,op.inputSha256);
  assert.equal(receipt.status,200);
  assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
  assert.ok(rawBody.length>0&&rawBody.length<=2*1024*1024);
  assert.equal(receipt.rawBodySha256,digest(rawBody));
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(rawBody));
  assert.equal(body.success,true);assert.equal(body.id,op.videoId);
  if(Object.hasOwn(body,'url'))assert.equal(normalizeDiscoveryVideo(body.url)?.videoId,op.videoId);
  assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
  const ids=[body.channel?.id,body.uploader?.channelId,body.ownerByline?.channelId];
  assert.ok(ids.every(id=>channel.test(id??'')));
  assert.ok(new Set(ids).size>1,'Only a demonstrably conflicting saved response qualifies');
  return {status:'held_provider_channel_identity_conflict',channelIds:[...new Set(ids)],
    ownershipAccepted:false,importEligible:false,selectedChannel:null};
}

export function validateConflictRecovery(plan,evidence){
  validateVideoStagePlan(plan);
  assert.equal(evidence.version,CONFLICT_RECOVERY_POLICY);
  assert.equal(evidence.continuationId,plan.id);
  assert.equal(plan.recovery,undefined,'Do not reuse legacy mapped-response recovery');
  const {previousPlan:prior,previousApproval:approval,previousRun:run,admissions}=evidence;
  validateVideoStagePlan(prior);assertVideoStageApproval(prior,approval);
  assert.equal(prior.recovery,undefined);
  assert.notEqual(plan.id,prior.id);
  assert.equal(run.id,prior.id);assert.equal(run.status,'stopped');
  assert.equal(run.plan_sha256,digest(prior));assert.equal(run.approval_sha256,digest(approval));
  assert.ok(typeof run.owner==='string'&&run.owner);
  assert.equal(Number(run.cap_cents),prior.maximumSpendCents);
  assert.equal(evidence.previousSummary.status,'stopped');
  assert.equal(evidence.previousSummary.id,prior.id);
  assert.equal(new Set(admissions.map(a=>a.operation_key)).size,admissions.length);
  const byKey=new Map(admissions.map(a=>[a.operation_key,a]));
  const returned=admissions.filter(a=>a.status==='returned');
  const pending=admissions.filter(a=>a.status==='admitted');
  assert.equal(pending.length,1);assert.equal(returned.length+1,admissions.length);
  assert.equal(Number(run.reserved_cents),admissions.length*2);
  assert.equal(evidence.previousSummary.returnedCalls,returned.length);
  // Only a sequential prefix may have been admitted. Preserve the entire
  // acknowledged prefix, omit the one saved conflict, dispatch the suffix only.
  for(const [i,a] of prior.operations.slice(0,admissions.length).entries()){
    const saved=byKey.get(a.key);assert.ok(saved);
    assert.equal(saved.run_id,prior.id);
    for(const [key,value] of Object.entries({profile_id:a.profileId,cm_artist:a.cmArtist,
      video_id:a.videoId,input_sha256:a.inputSha256}))assert.equal(saved[key],value);
    assert.equal(saved.status,i===admissions.length-1?'admitted':'returned');
    if(saved.status==='returned'){
      assert.equal(saved.http_status,200);
      assert.match(saved.receipt_sha256,sha);assert.match(saved.raw_sha256,sha);
    }
  }
  const pendingOp=prior.operations[admissions.length-1];
  assert.equal(pending[0].operation_key,pendingOp.key);
  const {receipt}=evidence;
  assert.equal(receipt.runId,prior.id);assert.equal(receipt.planSha256,digest(prior));
  const held=validateConflictResponse(pendingOp,receipt,Buffer.from(evidence.rawBodyBase64,'base64'));
  assert.deepEqual(evidence.conflictReview,held);
  assert.equal(plan.sourceRunId,prior.sourceRunId);
  assert.equal(plan.sourcePlanSha256,prior.sourcePlanSha256);
  assert.deepEqual(plan.operations,prior.operations.slice(admissions.length));
  assert.deepEqual(plan.artists,prior.artists.filter(a=>plan.operations.some(o=>o.profileId===a.profileId)));
  assert.equal(Number(run.reserved_cents)+plan.maximumSpendCents,prior.maximumSpendCents);
  assert.ok(evidence.sourceFiles&&Object.keys(evidence.sourceFiles).length);
  for(const [name,hash] of Object.entries(evidence.sourceFiles)){
    assert.match(name,/^[A-Za-z0-9_./-]+$/);
    assert.ok(!name.startsWith('/')&&!name.split('/').some(x=>['','..','.'].includes(x)));
    assert.match(hash,sha);
  }
  for(const a of admissions){
    assert.ok(evidence.sourceFiles['receipts/'+digest(a.operation_key)+'.json']);
    assert.ok(evidence.sourceFiles['receipts/'+digest(a.operation_key)+'.raw']);
    if(a.status==='returned')assert.ok(evidence.sourceFiles['results/'+digest(a.operation_key)+'.json']);
  }
  assert.equal(plan.evidenceFiles['evidence/conflict-recovery.json'],digest(JSON.stringify(evidence)));
  return {pendingOp,returnedCalls:returned.length,priorReservedCents:Number(run.reserved_cents),
    remainingCalls:plan.maximumCalls,combinedMaximumCents:prior.maximumSpendCents};
}

// Compare a fresh locked snapshot, not just a preparation-time snapshot.
export function assertConflictLedger(evidence,run,admissions){
  const expected=evidence.previousRun;
  for(const key of ['id','owner','status','plan_sha256','approval_sha256'])
    assert.equal(run?.[key],expected[key],'Stopped source owner or scope changed');
  assert.equal(Number(run.reserved_cents),Number(expected.reserved_cents));
  assert.equal(Number(run.cap_cents),Number(expected.cap_cents));
  assert.equal(admissions.length,evidence.admissions.length);
  for(const expectedRow of evidence.admissions){
    const actual=admissions.find(a=>a.operation_key===expectedRow.operation_key);assert.ok(actual);
    for(const field of admissionFields)assert.equal(actual[field],expectedRow[field]);
    if(expectedRow.status==='returned'){
      for(const field of ['status','http_status','receipt_sha256','raw_sha256'])
        assert.equal(actual[field],expectedRow[field]);
    }else{
      assert.ok(['admitted','returned'].includes(actual.status));
      if(actual.status==='returned'){
        assert.equal(actual.http_status,200);
        assert.equal(actual.receipt_sha256,digest(evidence.receipt));
        assert.equal(actual.raw_sha256,evidence.receipt.rawBodySha256);
      }
    }
  }
}
