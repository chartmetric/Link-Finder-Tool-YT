import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {holdChannelPlan,approveHoldChannels,holdGroupApproval} from './youtube-channel-hold-continuation.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {HOLD_CHANNEL_CONFLICTS} from './youtube-identity-conflict-hold.mjs';
export const speedSwitchPlan=immutableValidationCache(function(input){
  const p=input.sourcePlan;
  assert.match(input.id,/^youtube-channel-speed-switch-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.deepEqual(holdChannelPlan(p),p);
  assert.deepEqual(approveHoldChannels(p,input.sourceApproval),input.sourceApproval);
  assert.ok(Object.keys(input.sourceFiles).length&&Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);assert.ok(!file.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  const minimum=structuredClone(input.preparationSnapshot);
  for(const run of minimum.runs)if(run.status==='running')run.status='stopped';
  const counted=exactSettledPrefix(p.groups,p.groups.map(g=>
    holdGroupApproval(p,input.sourceApproval,g)),minimum,input.preparationHolds);
  return {version:'exact-channel-immutable-history-speed-switch-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlan:p,sourceApproval:input.sourceApproval,sourceFiles:input.sourceFiles,runtimeFiles:input.runtimeFiles,
    preparationSnapshot:input.preparationSnapshot,preparationHolds:input.preparationHolds,
    maximumPotentialCalls:p.maximumCalls,combinedCapCents:p.combinedCapCents,
    minimumSettled:counted.settled,minimumPaid:counted.paid,
    maximumRemainingCents:(p.maximumCalls-counted.settled)*2,identityConflictPolicy:HOLD_CHANNEL_CONFLICTS,
    scope:'Only the exact untouched requests at a locked zero-inflight handover; preserve held conflicts and the original combined cap',
    noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0,explicitApproval:false,executionEnabled:false};
});
export function approveSpeedSwitch(plan,{planSha256,combinedCapCents,approvedAt}){
  assert.deepEqual(speedSwitchPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(combinedCapCents,plan.combinedCapCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256,combinedCapCents,approvedAt,scope:plan.scope,explicitApproval:true,noAdditionalBudget:true};
}
export function exactSettledPrefix(groups,approvals,snapshot,holds){
  assert.equal(new Set(snapshot.runs.map(r=>r.id)).size,snapshot.runs.length);
  assert.equal(new Set(snapshot.admissions.map(a=>a.run_id+':'+a.operation_key)).size,snapshot.admissions.length);
  assert.equal(new Set(holds.map(h=>h.runId+':'+h.operationKey)).size,holds.length);
  let settled=0,paid=0,unpaid=false,started=0,seenAdmissions=0,seenHolds=0;
  for(const [i,g] of groups.entries()){
    const run=snapshot.runs.find(r=>r.id===g.id),rows=snapshot.admissions.filter(a=>a.run_id===g.id);
    if(run){
      assert.equal(i,started++,'Started groups must be a prefix');
      for(const [k,v] of Object.entries({plan_sha256:digest(g),approval_sha256:digest(approvals[i]),
        execution_sha256:digest(g.runtimeFiles),cap_cents:g.maximumSpendCents,reserved_cents:rows.length*2}))
        assert.equal(run[k],v);
      assert.ok(['completed','stopped'].includes(run.status),'Fence source before deriving requests');
      if(run.status==='stopped')assert.ok(!groups.slice(i+1).some(x=>snapshot.runs.some(r=>r.id===x.id)));
    }else assert.equal(rows.length,0);
    let groupSettled=0;
    for(const op of g.operations){
      const a=rows.find(a=>a.operation_key===op.key);
      const hold=holds.find(h=>h.runId===g.id&&h.operationKey===op.key);
      if(!a&&!hold){unpaid=true;continue;}
      assert.ok(run&&!unpaid,'Non-prefix or unstarted work cannot be subtracted');
      if(hold){
        seenHolds++;assert.equal(hold.paid,Boolean(a));
        assert.equal(hold.ownershipAccepted,false);assert.equal(hold.importEligible,false);
        assert.ok(Array.isArray(hold.conflicts)&&hold.conflicts.length);
      }
      if(a){
        seenAdmissions++;
        for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
          channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,
          reserved_cents:2,status:'returned',http_status:200}))assert.equal(a[k],v);
        assert.match(a.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(a.raw_sha256,/^[a-f0-9]{64}$/);paid++;
      }
      settled++;groupSettled++;
    }
    if(run?.status==='completed')assert.equal(groupSettled,g.operations.length);
  }
  assert.equal(started,snapshot.runs.length);assert.equal(seenAdmissions,snapshot.admissions.length);
  assert.equal(seenHolds,holds.length);
  assert.equal(snapshot.runs.reduce((n,r)=>n+r.reserved_cents,0),paid*2);
  return {settled,paid,unspentHolds:settled-paid};
}
export function assertPreparationRetained(plan,snapshot,holds,counted){
  assert.ok(counted.settled>=plan.minimumSettled&&counted.paid>=plan.minimumPaid,'Prepared paid work cannot disappear');
  for(const row of plan.preparationSnapshot.admissions)
    assert.deepEqual(snapshot.admissions.find(a=>a.run_id===row.run_id&&a.operation_key===row.operation_key),row);
  for(const before of plan.preparationSnapshot.runs){
    const after=snapshot.runs.find(r=>r.id===before.id);assert.ok(after);
    for(const key of ['id','owner','plan_sha256','approval_sha256','execution_sha256','cap_cents'])
      assert.equal(after[key],before[key]);
    assert.ok(after.reserved_cents>=before.reserved_cents);
    if(before.status==='completed')assert.equal(after.status,'completed');
  }
  for(const h of plan.preparationHolds)
    assert.deepEqual(holds.find(x=>x.runId===h.runId&&x.operationKey===h.operationKey),h);
}
export const speedSuffix=immutableValidationCache(function(plan,snapshot,holds){
  const source=plan.sourcePlan;
  const counted=exactSettledPrefix(source.groups,source.groups.map(g=>
    holdGroupApproval(source,plan.sourceApproval,g)),snapshot,holds);
  assertPreparationRetained(plan,snapshot,holds,counted);
  const pending=source.groups.flatMap(g=>g.operations).slice(counted.settled),groups=[];
  for(let at=0;at<pending.length;at+=20){
    const operations=pending.slice(at,at+20),profiles=new Set(operations.map(o=>o.profileId));
    groups.push({version:plan.version,id:plan.id+'-part-'+(groups.length+1),groupIndex:groups.length,
      sourceRoot:source.groups[0].sourceRoot,
      selections:source.groups.flatMap(g=>g.selections).filter(s=>profiles.has(s.profileId)),
      operations,runtimeFiles:plan.runtimeFiles,maximumCalls:operations.length,maximumSpendCents:operations.length*2,
      identityConflictPolicy:HOLD_CHANNEL_CONFLICTS,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0});
  }
  const priorReservedCents=source.priorReservedCents+counted.paid*2;
  assert.ok(priorReservedCents+pending.length*2<=plan.combinedCapCents);
  assert.ok(pending.length*2<=plan.maximumRemainingCents);
  assert.equal(counted.settled+pending.length,plan.maximumPotentialCalls);
  return {...counted,priorReservedCents,remaining:pending.length,maximumRemainingCents:pending.length*2,groups};
});
export const speedGroupApproval=immutableValidationCache(function(plan,approval,cutover,group){
  assert.deepEqual(approveSpeedSwitch(plan,approval),approval);
  assert.deepEqual(speedSuffix(plan,cutover.snapshot,cutover.holds).groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,parentPlanSha256:digest(plan),parentApprovalSha256:digest(approval),
    cutoverSha256:digest(cutover),planSha256:digest(group),capCents:group.maximumSpendCents,
    approvedAt:approval.approvedAt,scope:plan.scope,explicitApproval:true};
});
