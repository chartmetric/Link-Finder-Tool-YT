// A fixed, exact-request continuation after two honestly stopped source stages.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {fastChannelPlan,approveFastChannels,channelSuffix,fastGroupApproval,recoveredChannelSnapshot} from './youtube-channel-fast-continuation.mjs';
import {HOLD_CHANNEL_CONFLICTS} from './youtube-identity-conflict-hold.mjs';
export function validatePaidPrefix(groups,approvals,snapshot){
  assert.equal(new Set(snapshot.runs.map(r=>r.id)).size,snapshot.runs.length);
  assert.equal(new Set(snapshot.admissions.map(a=>a.run_id+':'+a.operation_key)).size,snapshot.admissions.length);
  let unpaid=false,count=0;
  for(const [i,g] of groups.entries()){
    const run=snapshot.runs.find(r=>r.id===g.id),rows=snapshot.admissions.filter(a=>a.run_id===g.id);
    if(run){
      assert.ok(snapshot.runs.length>=i+1&&groups.slice(0,i).every(e=>snapshot.runs.some(r=>r.id===e.id)));
      for(const [k,v] of Object.entries({plan_sha256:digest(g),approval_sha256:digest(approvals[i]),
        execution_sha256:digest(g.runtimeFiles),cap_cents:g.maximumSpendCents,reserved_cents:rows.length*2}))
        assert.equal(run[k],v);
      assert.ok(['completed','stopped'].includes(run.status));
      if(run.status==='completed')assert.equal(rows.length,g.operations.length);
      if(run.status==='stopped')assert.ok(!groups.slice(i+1).some(e=>snapshot.runs.some(r=>r.id===e.id)));
    }else assert.equal(rows.length,0);
    for(const op of g.operations){
      const a=rows.find(a=>a.operation_key===op.key);
      if(!a){unpaid=true;continue;}
      assert.ok(!unpaid&&run,'Paid requests must be an exact contiguous prefix');
      for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,kind:'metadata',
        channel_id:op.allocationChannelKey,input_sha256:op.inputSha256,reserved_cents:2,status:'returned',http_status:200}))
        assert.equal(a[k],v);
      assert.match(a.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(a.raw_sha256,/^[a-f0-9]{64}$/);count++;
    }
  }
  assert.equal(count,snapshot.admissions.length);
  assert.equal(snapshot.runs.length,groups.filter(g=>snapshot.runs.some(r=>r.id===g.id)).length);
  return count;
}
export function projectHeldReceipt(snapshot,recovery){
  assert.deepEqual(snapshot,recovery.snapshot);
  const after=structuredClone(snapshot),row=after.admissions.find(a=>
    a.run_id===recovery.runId&&a.operation_key===recovery.operationKey);
  assert.ok(row&&row.status==='admitted'&&row.http_status===null&&row.receipt_sha256===null&&row.raw_sha256===null);
  assert.equal(after.admissions.filter(a=>a.status!=='returned').length,1);
  assert.equal(after.runs.find(r=>r.id===row.run_id)?.status,'stopped');
  assert.equal(recovery.ownershipAccepted,false);assert.equal(recovery.importEligible,false);
  assert.equal(recovery.providerRequests,0);
  for(const k of ['receiptSha256','rawSha256','receiptFileSha256'])assert.match(recovery[k],/^[a-f0-9]{64}$/);
  Object.assign(row,{status:'returned',http_status:200,receipt_sha256:recovery.receiptSha256,raw_sha256:recovery.rawSha256});
  return after;
}
export function holdChannelPlan(input){
  const {predecessor:p,predecessorApproval:a,cutover,recovery:r}=input;
  assert.match(input.id,/^youtube-channel-hold-continuation-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.deepEqual(fastChannelPlan(p),p);assert.deepEqual(approveFastChannels(p,a),a);
  assert.equal(cutover.planSha256,digest(p));
  assert.deepEqual(cutover.snapshot,recoveredChannelSnapshot(p,p.savedResponseRecovery.snapshot));
  assert.deepEqual(input.originalSnapshot,cutover.snapshot);
  const suffix=channelSuffix(p,cutover.snapshot);
  const projected=projectHeldReceipt(input.fastSnapshot,r);
  const prefix=validatePaidPrefix(suffix.groups,suffix.groups.map(g=>fastGroupApproval(p,a,cutover,g)),projected);
  const group=suffix.groups.find(g=>g.id===r.runId),op=group?.operations.find(o=>o.key===r.operationKey);
  assert.ok(op);
  assert.equal(r.receiptPath,'generated-artifacts/'+p.id+'/part-'+(group.groupIndex+1)+'/receipts/'+digest(op.key)+'.json');
  assert.equal(r.rawPath,r.receiptPath.replace(/\.json$/,'.raw'));
  assert.equal(input.sourceFiles[r.receiptPath],r.receiptFileSha256);
  assert.equal(input.sourceFiles[r.rawPath],r.rawSha256);
  const pending=suffix.groups.flatMap(g=>g.operations).slice(prefix);
  const priorReservedCents=cutover.priorReservedCents+prefix*2;
  assert.equal(priorReservedCents+pending.length*2,p.combinedMaximumSpendCents);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);assert.ok(!file.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  const groups=[];
  for(let at=0;at<pending.length;at+=20){
    const operations=pending.slice(at,at+20),ids=new Set(operations.map(o=>o.profileId));
    groups.push({version:HOLD_CHANNEL_CONFLICTS,id:input.id+'-part-'+(groups.length+1),groupIndex:groups.length,
      sourceRoot:p.sourcePlan.sourcePlan.sourceRoot,
      selections:p.sourcePlan.sourcePlan.selections.filter(s=>ids.has(s.profileId)),
      operations,runtimeFiles:input.runtimeFiles,maximumCalls:operations.length,maximumSpendCents:operations.length*2,
      identityConflictPolicy:HOLD_CHANNEL_CONFLICTS,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0});
  }
  return {version:HOLD_CHANNEL_CONFLICTS,id:input.id,preparedAt:input.preparedAt,
    predecessor:p,predecessorApproval:a,cutover,originalSnapshot:input.originalSnapshot,fastSnapshot:input.fastSnapshot,
    recovery:r,sourceFiles:input.sourceFiles,runtimeFiles:input.runtimeFiles,
    projectedSnapshot:projected,groups,priorReservedCents,maximumCalls:pending.length,
    maximumSpendCents:pending.length*2,combinedCapCents:p.combinedMaximumSpendCents,
    scope:'Recover the exact saved receipt as transport only; hold identity conflicts and check only the untouched channel requests',
    identityConflictPolicy:HOLD_CHANNEL_CONFLICTS,explicitApproval:false,executionEnabled:false,
    noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0};
}
export function approveHoldChannels(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(holdChannelPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256,capCents,combinedCapCents:plan.combinedCapCents,approvedAt,
    scope:plan.scope,explicitApproval:true};
}
export function holdGroupApproval(plan,approval,group){
  assert.deepEqual(approveHoldChannels(plan,approval),approval);
  assert.deepEqual(plan.groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,planSha256:digest(group),parentPlanSha256:digest(plan),
    parentApprovalSha256:digest(approval),capCents:group.maximumSpendCents,scope:plan.scope,
    approvedAt:approval.approvedAt,explicitApproval:true};
}
