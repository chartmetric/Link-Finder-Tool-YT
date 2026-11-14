// Pure preparation contract. This is NOT an execution approval or a dispatcher.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {assertMixedApproval} from './youtube-mixed-capture-readiness.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture,returnedYoutubeUrl} from './youtube-ownership-policy.mjs';

export const DIRECT_RECOVERY_PREPARATION='saved-direct-channel-conflict-preparation-v1';
const hash=/^[a-f0-9]{64}$/;
export function prepareDirectRecoveryContract(evidence){
  const {bundle,approval,runs,admissions,children,savedResponses,catalogClaims}=evidence;
  assert.deepEqual(approveChannelCheckBundle(bundle,approval),approval);
  assert.equal(new Set(runs.map(r=>r.id)).size,runs.length);
  assert.equal(new Set(admissions.map(a=>a.run_id+':'+a.operation_key)).size,admissions.length);
  assert.equal(children.length,bundle.children.length);
  const operationRows=[],captures=[],pending=[];
  for(const [index,child] of bundle.children.entries()){
    const archived=children[index];
    assert.equal(archived.plan.id,child.id);assert.equal(digest(archived.plan),child.planSha256);
    assert.deepEqual(archived.plan,child.plan);assertMixedApproval(child.plan,archived.approval);
    const run=runs.find(r=>r.id===child.id),rows=admissions.filter(a=>a.run_id===child.id);
    if(run){
      assert.ok(['completed','stopped'].includes(run.status));
      assert.ok(typeof run.owner==='string'&&run.owner);
      assert.equal(run.plan_sha256,child.planSha256);
      assert.equal(run.approval_sha256,digest(archived.approval));
      assert.equal(run.execution_sha256,digest(child.plan.runtimeFiles));
      assert.equal(run.cap_cents,child.capCents);
      assert.equal(run.reserved_cents,rows.length*2);
      if(run.status==='completed')assert.equal(rows.length,child.plan.operations.length);
    }else assert.equal(rows.length,0);
    for(const [i,op] of child.plan.operations.entries()){
      const row=rows.find(a=>a.operation_key===op.key);
      operationRows.push({runId:child.id,operation:op,row:row??null});
      if(!row){
        // A child executes sequentially: no paid operation may follow a gap.
        assert.ok(!child.plan.operations.slice(i+1).some(o=>rows.some(a=>a.operation_key===o.key)));
        pending.push({sourceRunId:child.id,operation:op,
          selection:child.plan.selections.find(s=>s.profileId===op.profileId)});
        continue;
      }
      assert.ok(run);assert.equal(row.run_id,child.id);
      for(const [key,value] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
        channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2}))
        assert.equal(row[key],value);
      const saved=savedResponses.find(s=>s.runId===child.id&&s.receipt.operationKey===op.key);
      assert.ok(saved);const {receipt}=saved,raw=Buffer.from(saved.rawBodyBase64,'base64');
      assert.ok(raw.length&&raw.length<=2*1024*1024);
      for(const [key,value] of Object.entries({runId:child.id,planSha256:child.planSha256,
        approvalSha256:digest(archived.approval),operationKey:op.key,profileId:op.profileId,
        cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,inputSha256:op.inputSha256,
        rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw),status:200}))
        assert.equal(receipt[key],value);
      assert.deepEqual(receipt.request,op.request);assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
      assert.equal(body.success,true);
      assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
      const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
        operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
      const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
      if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
      const conflicts=catalogClaims.filter(c=>{
        const alias=returnedYoutubeUrl(c.account_url);
        return alias&&bound.aliases.some(a=>a.toLowerCase()===alias.toLowerCase())
          &&(String(c.profile_id)!==op.profileId||String(c.cm_artist)!==op.cmArtist);
      });
      assert.ok(['returned','admitted'].includes(row.status));
      if(row.status==='returned'){
        assert.equal(row.http_status,200);assert.equal(row.receipt_sha256,digest(receipt));
        assert.equal(row.raw_sha256,digest(raw));
      }else{
        assert.ok(conflicts.length,'Only an observed catalog conflict qualifies for this preparation');
        assert.equal(run.status,'stopped');assert.equal(i,rows.length-1);
        assert.equal(row.receipt_sha256,null);assert.equal(row.raw_sha256,null);
        assert.equal(row.http_status,null);
      }
      captures.push({sourceRunId:child.id,operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
        receiptSha256:digest(receipt),rawSha256:digest(raw),aliases:bound.aliases,conflicts,
        channelId:bound.body.channelId,channelName:bound.body.displayName,
        disposition:row.status==='admitted'?'held_catalog_identity_conflict':'previously_acknowledged',
        ownershipAccepted:false,importEligible:false,replayAllowed:false});
    }
  }
  assert.equal(admissions.length,captures.length);assert.equal(savedResponses.length,captures.length);
  assert.equal(runs.length,bundle.children.filter(c=>runs.some(r=>r.id===c.id)).length);
  const held=captures.filter(c=>c.disposition==='held_catalog_identity_conflict');assert.equal(held.length,1);
  // Preserve the aggregate prefix too, including children never started.
  const paid=operationRows.filter(o=>o.row);
  assert.deepEqual(operationRows.slice(0,paid.length),paid);
  assert.equal(paid.at(-1).row.status,'admitted');
  assert.ok(paid.slice(0,-1).every(o=>o.row.status==='returned'));
  assert.ok(pending.length);
  const priorReservedCents=runs.reduce((n,r)=>n+r.reserved_cents,0);
  assert.equal(priorReservedCents,paid.length*2);
  assert.equal(priorReservedCents+pending.length*2,approval.capCents);
  assert.ok(evidence.sourceFiles&&Object.keys(evidence.sourceFiles).length);
  for(const [file,sha] of Object.entries(evidence.sourceFiles)){
    assert.ok(file.startsWith('generated-artifacts/')&&!file.split('/').includes('..'));assert.match(sha,hash);
  }
  return {version:DIRECT_RECOVERY_PREPARATION,sourceBundleId:bundle.id,sourceBundleSha256:digest(bundle),
    sourceApprovalSha256:digest(approval),sourceEvidenceSha256:digest(evidence),
    status:'prepared_not_approved_not_executable',explicitApproval:false,executable:false,
    recovery:{kind:'acknowledge_saved_transport_receipt_only',maximumAdditionalCents:0,
      expectedStoppedRun:runs.find(r=>r.id===held[0].sourceRunId),heldResponse:held[0],
      keepSourceRunStopped:true,keepIdentityConflictHeld:true,createOwnershipClaims:false,
      refreshAndLockLedgerBeforeApplying:true,requiresSeparateExactApproval:true},
    continuation:{pending,maximumCalls:pending.length,maximumAdditionalCents:pending.length*2,
      requiresFreshEligibility:true,requiresFreshRuntimeAndApproval:true,
      blockedUntilSavedResponseSafelyAccounted:true,noRetries:true,allowedKinds:['metadata']},
    accounting:{previousAcknowledged:captures.length-1,savedHeld:1,paidRequests:paid.length,
      priorReservedCents,originalMaximumCents:approval.capCents,
      combinedMaximumCents:priorReservedCents+pending.length*2},
    paidCallsDuringPreparation:0,coordinatorWritesDuringPreparation:0,catalogWrites:0,
    ownershipAccepted:false,importEligible:false};
}
