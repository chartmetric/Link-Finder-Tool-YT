// A narrowly bounded switch: only the untouched suffix of the already known
// exact requests may run, and old plus new reservations cannot exceed the cap.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveAccountedGroups,groupApproval} from './youtube-accounted-channel-groups.mjs';
export function fastChannelPlan(input){
  assert.match(input.id,/^youtube-channel-fast-continuation-[a-z0-9-]{4,60}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.deepEqual(approveAccountedGroups(input.sourcePlan,input.sourceApproval),input.sourceApproval);
  assert.ok(Object.keys(input.sourceFiles).length&&Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);assert.ok(!file.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  if(input.savedResponseRecovery){
    const r=input.savedResponseRecovery;
    assert.equal(r.version,'exact-held-channel-receipt-only-v1');
    assert.equal(r.catalogConflictHeld,true);assert.equal(r.ownershipAccepted,false);
    assert.equal(r.importEligible,false);assert.equal(r.providerRequests,0);
    assert.equal(r.snapshot.admissions.filter(a=>a.status==='admitted').length,1);
    assert.ok(r.snapshot.runs.every(run=>['completed','stopped'].includes(run.status)));
    for(const key of ['receiptSha256','rawSha256','receiptFileSha256'])assert.match(r[key],/^[a-f0-9]{64}$/);
    assert.equal(r.receiptPath,'generated-artifacts/'+input.sourcePlan.id+'/part-'+
      (input.sourcePlan.groups.find(g=>g.id===r.runId)?.groupIndex+1)+'/receipts/'+digest(r.operationKey)+'.json');
    assert.match(r.rawFileSha256,/^[a-f0-9]{64}$/);
    assert.equal(r.rawPath,r.receiptPath.replace(/\.json$/,'.raw'));
    assert.equal(r.rawFileSha256,r.rawSha256);
    assert.equal(input.sourceFiles[r.receiptPath],r.receiptFileSha256);
    assert.equal(input.sourceFiles[r.rawPath],r.rawFileSha256);
  }
  return {version:input.savedResponseRecovery?'exact-unspent-channel-suffix-fast-recovery-v1':
    'exact-unspent-channel-suffix-fast-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlan:structuredClone(input.sourcePlan),sourceApproval:structuredClone(input.sourceApproval),
    sourceFiles:structuredClone(input.sourceFiles),runtimeFiles:structuredClone(input.runtimeFiles),
    maximumCalls:input.sourcePlan.maximumCalls,combinedMaximumSpendCents:input.sourcePlan.maximumSpendCents,
    ...(input.savedResponseRecovery?{savedResponseRecovery:structuredClone(input.savedResponseRecovery)}:{}),
    scope:input.savedResponseRecovery?
      'Acknowledge only the frozen held receipt as received, keep its identity conflict held, then run the untouched exact suffix':
      'Only the untouched exact-request suffix after a locked, zero-inflight handover',
    maximumGroupCalls:20,maximumGroupSpendCents:40,noRetries:true,noCatalogWrites:true,
    explicitApproval:false,executionEnabled:false,modelCalls:0,uploaderCalls:0,
    safety:{everyFileIdentityCheckedBeforeEachRequest:true,unchangedContentHashesCached:true,
      groupStartChecksAllSelectedArtists:true,eachRequestAndReturnChecksItsArtist:true,
      everyAdmissionReservesBeforeDispatch:true,everyResponseSavedBeforeAcknowledgment:true}};
}
export function approveFastChannels(plan,{planSha256,combinedCapCents,approvedAt}){
  assert.deepEqual(fastChannelPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(combinedCapCents,plan.combinedMaximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,combinedCapCents,approvedAt,explicitApproval:true,
    scope:plan.scope,noAdditionalBudget:true};
}
export function channelSuffix(plan,snapshot){
  const source=plan.sourcePlan,operations=source.groups.flatMap(g=>g.operations);
  const runs=new Map(snapshot.runs.map(r=>[r.id,r]));
  assert.equal(runs.size,snapshot.runs.length);
  const admissions=new Map(snapshot.admissions.map(a=>[a.run_id+':'+a.operation_key,a]));
  assert.equal(admissions.size,snapshot.admissions.length);
  const knownRuns=new Set(source.groups.map(g=>g.id));
  assert.ok(snapshot.runs.every(r=>knownRuns.has(r.id)));
  assert.ok(snapshot.admissions.every(a=>knownRuns.has(a.run_id)));
  let unpaidSeen=false,paidCount=0,total=0,lastStarted=-1;
  for(const group of source.groups){
    const run=runs.get(group.id),rows=snapshot.admissions.filter(a=>a.run_id===group.id);
    if(run){
      assert.equal(group.groupIndex,lastStarted+1,'Source runs must be a contiguous prefix');lastStarted=group.groupIndex;
      assert.equal(run.plan_sha256,digest(group));
      assert.equal(run.approval_sha256,digest(groupApproval(source,plan.sourceApproval,group)));
      assert.equal(run.execution_sha256,digest(group.runtimeFiles));
      assert.equal(run.cap_cents,group.maximumSpendCents);
      assert.ok(['completed','stopped'].includes(run.status),'Source must be fenced before continuation');
      assert.equal(run.reserved_cents,rows.length*2);
      if(run.status==='completed')assert.equal(rows.length,group.operations.length);
    }else assert.equal(rows.length,0);
    for(const op of group.operations){
      const a=admissions.get(group.id+':'+op.key);
      if(!a){unpaidSeen=true;continue;}
      assert.ok(!unpaidSeen,'A non-prefix paid allocation cannot be resumed automatically');
      assert.ok(run);
      for(const [key,value] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
        channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2,
        status:'returned',http_status:200}))assert.equal(a[key],value);
      assert.match(a.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(a.raw_sha256,/^[a-f0-9]{64}$/);
      paidCount++;total+=a.reserved_cents;
    }
    if(run?.status==='stopped')assert.ok(!source.groups.slice(group.groupIndex+1).some(g=>runs.has(g.id)),
      'Only the final source run may be stopped');
  }
  assert.equal(paidCount,snapshot.admissions.length);
  assert.equal(total,snapshot.runs.reduce((n,r)=>n+r.reserved_cents,0));
  assert.equal(total+(operations.length-paidCount)*2,plan.combinedMaximumSpendCents);
  const pending=operations.slice(paidCount),groups=[];
  for(let at=0;at<pending.length;at+=20){
    const ops=pending.slice(at,at+20),ids=new Set(ops.map(o=>o.profileId));
    groups.push({version:'exact-unspent-channel-fast-group-v1',id:plan.id+'-part-'+(groups.length+1),
      sourceRoot:source.sourcePlan.sourceRoot,parentId:plan.id,groupIndex:groups.length,
      selections:source.sourcePlan.selections.filter(s=>ids.has(s.profileId)),
      operations:ops,runtimeFiles:plan.runtimeFiles,maximumCalls:ops.length,maximumSpendCents:ops.length*2,
      noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0,explicitApproval:false,executionEnabled:false});
  }
  assert.deepEqual(groups.flatMap(g=>g.operations),pending);
  for(const group of groups)assert.equal(group.selections.length,group.operations.length);
  return {paidCount,priorReservedCents:total,pendingCount:pending.length,
    maximumRemainingCents:pending.length*2,groups};
}
export function fastGroupApproval(plan,approval,cutover,group){
  assert.equal(approval.planSha256,digest(plan));assert.equal(approval.explicitApproval,true);
  assert.deepEqual(channelSuffix(plan,cutover.snapshot).groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,parentPlanSha256:digest(plan),parentApprovalSha256:digest(approval),
    cutoverSha256:digest(cutover),planSha256:digest(group),capCents:group.maximumSpendCents,
    approvedAt:approval.approvedAt,explicitApproval:true,scope:approval.scope};
}
export function recoveredChannelSnapshot(plan,current){
  const r=plan.savedResponseRecovery;assert.ok(r);
  assert.deepEqual(current,r.snapshot,'Saved-response recovery ledger changed');
  const after=structuredClone(current),row=after.admissions.find(a=>a.run_id===r.runId&&a.operation_key===r.operationKey);
  assert.ok(row&&row.status==='admitted'&&row.receipt_sha256===null&&row.raw_sha256===null&&row.http_status===null);
  assert.equal(after.runs.find(run=>run.id===r.runId)?.status,'stopped');
  Object.assign(row,{status:'returned',http_status:200,receipt_sha256:r.receiptSha256,raw_sha256:r.rawSha256});
  channelSuffix(plan,after);return after;
}
