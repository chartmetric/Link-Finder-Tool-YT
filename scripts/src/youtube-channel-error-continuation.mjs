import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {speedSwitchPlan,approveSpeedSwitch,speedSuffix,speedGroupApproval} from './youtube-channel-speed-switch.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';
import {HOLD_CHANNEL_CONFLICTS} from './youtube-identity-conflict-hold.mjs';
export function serverErrorReceipt(receipt,raw,group,approval,op){
  for(const [k,v] of Object.entries({runId:group.id,planSha256:digest(group),approvalSha256:digest(approval),
    operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',
    targetUrl:op.targetUrl,inputSha256:op.inputSha256,status:500,rawPath:'receipts/'+digest(op.key)+'.raw'}))
    assert.equal(receipt[k],v);
  assert.deepEqual(receipt.request,op.request);assert.equal(digest(raw),receipt.rawBodySha256);
  const body=JSON.parse(raw);
  assert.ok(!['provider_funding_failure','provider_authentication_or_access_failure','provider_rate_limit']
    .includes(providerStopReason({status:500,data:body})));
  return {status:500,providerReportedCredits:body.credits_charged??null,
    conservativeReservationCents:2,incompleteEvidence:true,ownershipAccepted:false,importEligible:false,noRetry:true};
}
export function projectServerError(snapshot,recovery){
  assert.deepEqual(snapshot,recovery.snapshot);
  const after=structuredClone(snapshot),row=after.admissions.find(a=>
    a.run_id===recovery.runId&&a.operation_key===recovery.operationKey);
  assert.equal(after.admissions.filter(a=>a.status!=='returned').length,1);
  assert.ok(row&&row.status==='admitted'&&row.http_status===null&&row.receipt_sha256===null&&row.raw_sha256===null);
  assert.equal(after.runs.find(r=>r.id===row.run_id)?.status,'stopped');
  assert.equal(recovery.httpStatus,500);assert.equal(recovery.ownershipAccepted,false);
  assert.equal(recovery.importEligible,false);assert.equal(recovery.noRetry,true);
  assert.equal(recovery.reservedCents,2);
  for(const k of ['receiptSha256','receiptFileSha256','rawSha256'])assert.match(recovery[k],/^[a-f0-9]{64}$/);
  Object.assign(row,{status:'returned',http_status:500,receipt_sha256:recovery.receiptSha256,raw_sha256:recovery.rawSha256});
  return after;
}
export function errorPaidPrefix(groups,approvals,snapshot,holds,failure){
  assert.equal(new Set(snapshot.runs.map(r=>r.id)).size,snapshot.runs.length);
  assert.equal(new Set(snapshot.admissions.map(a=>a.run_id+':'+a.operation_key)).size,snapshot.admissions.length);
  assert.equal(new Set(holds.map(h=>h.runId+':'+h.operationKey)).size,holds.length);
  let settled=0,paid=0,unpaid=false,started=0,failed=0,seenHolds=0;
  for(const [i,g] of groups.entries()){
    const run=snapshot.runs.find(r=>r.id===g.id),rows=snapshot.admissions.filter(a=>a.run_id===g.id);
    if(run){
      assert.equal(i,started++);
      for(const [k,v] of Object.entries({plan_sha256:digest(g),approval_sha256:digest(approvals[i]),
        execution_sha256:digest(g.runtimeFiles),cap_cents:g.maximumSpendCents,reserved_cents:rows.length*2}))
        assert.equal(run[k],v);
      assert.ok(['completed','stopped'].includes(run.status));
      if(run.status==='stopped')assert.ok(!groups.slice(i+1).some(x=>snapshot.runs.some(r=>r.id===x.id)));
    }else assert.equal(rows.length,0);
    let inGroup=0;
    for(const op of g.operations){
      const a=rows.find(a=>a.operation_key===op.key),h=holds.find(h=>h.runId===g.id&&h.operationKey===op.key);
      if(!a&&!h){unpaid=true;continue;}
      assert.ok(run&&!unpaid);
      assert.equal(failed,0,'No settled operation may follow the stopped error');
      if(h){seenHolds++;assert.equal(h.paid,Boolean(a));assert.equal(h.ownershipAccepted,false);
        assert.equal(h.importEligible,false);assert.ok(h.conflicts.length);}
      if(a){
        const isFailed=g.id===failure.runId&&op.key===failure.operationKey;
        for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
          channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,
          reserved_cents:2,status:'returned',http_status:isFailed?500:200}))assert.equal(a[k],v);
        assert.match(a.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(a.raw_sha256,/^[a-f0-9]{64}$/);
        if(isFailed){failed++;assert.equal(run.status,'stopped');
          assert.equal(a.receipt_sha256,failure.receiptSha256);assert.equal(a.raw_sha256,failure.rawSha256);}
        else assert.equal(failed,0,'No paid request may follow the stopped error');
        paid++;
      }
      settled++;inGroup++;
    }
    if(run?.status==='completed')assert.equal(inGroup,g.operations.length);
  }
  assert.equal(failed,1);assert.equal(paid,snapshot.admissions.length);
  assert.equal(started,snapshot.runs.length);assert.equal(seenHolds,holds.length);
  assert.equal(snapshot.runs.reduce((n,r)=>n+r.reserved_cents,0),paid*2);
  return {paid,settled,failed};
}
export const errorContinuationPlan=immutableValidationCache(function(input){
  const p=input.sourcePlan,a=input.sourceApproval,r=input.recovery;
  assert.match(input.id,/^youtube-channel-error-continuation-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.deepEqual(speedSwitchPlan(p),p);assert.deepEqual(approveSpeedSwitch(p,a),a);
  assert.equal(input.cutover.planSha256,digest(p));
  const source=speedSuffix(p,input.cutover.snapshot,input.cutover.holds);
  const projected=projectServerError(input.snapshot,r),counted=errorPaidPrefix(source.groups,
    source.groups.map(g=>speedGroupApproval(p,a,input.cutover,g)),projected,input.holds,r);
  const group=source.groups.find(g=>g.id===r.runId),op=group?.operations.find(o=>o.key===r.operationKey);assert.ok(op);
  assert.equal(r.receiptPath,'generated-artifacts/'+p.id+'/part-'+(group.groupIndex+1)+'/receipts/'+digest(op.key)+'.json');
  assert.equal(r.rawPath,r.receiptPath.replace(/\.json$/,'.raw'));
  assert.equal(input.sourceFiles[r.receiptPath],r.receiptFileSha256);
  assert.equal(input.sourceFiles[r.rawPath],r.rawSha256);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);assert.ok(!file.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  const pending=source.groups.flatMap(g=>g.operations).slice(counted.settled),groups=[];
  const selections=source.groups.flatMap(g=>g.selections);
  for(let at=0;at<pending.length;at+=20){
    const operations=pending.slice(at,at+20),profiles=new Set(operations.map(o=>o.profileId));
    groups.push({version:'exact-channel-server-error-suffix-v1',id:input.id+'-part-'+(groups.length+1),groupIndex:groups.length,
      selections:selections.filter(s=>profiles.has(s.profileId)),sourceRoot:source.groups[0].sourceRoot,operations,
      maximumCalls:operations.length,maximumSpendCents:operations.length*2,runtimeFiles:input.runtimeFiles,
      identityConflictPolicy:HOLD_CHANNEL_CONFLICTS,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0});
  }
  const priorReservedCents=source.priorReservedCents+counted.paid*2;
  assert.ok(priorReservedCents+pending.length*2<=p.combinedCapCents);
  return {version:'exact-channel-server-error-suffix-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlan:p,sourceApproval:a,cutover:input.cutover,snapshot:input.snapshot,projectedSnapshot:projected,
    holds:input.holds,recovery:r,sourceFiles:input.sourceFiles,runtimeFiles:input.runtimeFiles,groups,
    priorReservedCents,maximumCalls:pending.length,maximumSpendCents:pending.length*2,combinedCapCents:p.combinedCapCents,
    scope:'Record only the saved HTTP 500 response as failed transport without retry, then check the untouched exact remainder',
    explicitApproval:false,executionEnabled:false,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0};
});
export function approveErrorContinuation(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(errorContinuationPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256,capCents,combinedCapCents:plan.combinedCapCents,approvedAt,scope:plan.scope,explicitApproval:true};
}
export const errorGroupApproval=immutableValidationCache(function(plan,approval,group){
  assert.deepEqual(approveErrorContinuation(plan,approval),approval);assert.deepEqual(plan.groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,planSha256:digest(group),parentPlanSha256:digest(plan),
    parentApprovalSha256:digest(approval),capCents:group.maximumSpendCents,
    approvedAt:approval.approvedAt,scope:plan.scope,explicitApproval:true};
});
