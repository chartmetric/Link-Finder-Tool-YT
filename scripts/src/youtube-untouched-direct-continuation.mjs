// Reconcile every approved bundle by identity. No queries, mutations or replay.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {assertMixedApproval} from './youtube-mixed-capture-readiness.mjs';

export function untouchedDirectContinuation({bundles,runs,admissions}){
  assert.ok(bundles.length);
  assert.equal(new Set(runs.map(r=>r.id)).size,runs.length);
  assert.equal(new Set(admissions.map(a=>a.run_id+':'+a.operation_key)).size,admissions.length);
  for(const field of ['profile_id','cm_artist','channel_id'])
    assert.equal(new Set(admissions.map(a=>a[field])).size,admissions.length,'Repeated paid '+field);
  const original=bundles[0].plan;
  const originalOps=original.children.flatMap(c=>c.plan.operations);
  const originalByKey=new Map(originalOps.map(o=>[o.key,o]));
  assert.equal(originalOps.length,originalByKey.size);
  const paid=new Set(),knownChildren=new Set(),latestSources=new Map();
  let reservedCents=0;
  for(const bundle of bundles){
    assert.deepEqual(approveChannelCheckBundle(bundle.plan,bundle.approval),bundle.approval);
    assert.equal(bundle.plan.sourceBundleId,original.sourceBundleId);
    assert.equal(bundle.plan.sourceBundleSha256,original.sourceBundleSha256);
    const ops=bundle.plan.children.flatMap(c=>c.plan.operations);
    assert.deepEqual(ops,originalOps.filter(o=>!paid.has(o.key)),'Approved continuation must be the exact untouched suffix');
    assert.equal(bundle.childApprovals.length,bundle.plan.children.length);
    let gap=false;
    for(const child of bundle.plan.children){
      assert.ok(!knownChildren.has(child.id));knownChildren.add(child.id);
      const approval=bundle.childApprovals.find(a=>a.id===child.id);assertMixedApproval(child.plan,approval);
      const run=runs.find(r=>r.id===child.id),rows=admissions.filter(a=>a.run_id===child.id);
      if(run){
        assert.ok(['completed','stopped'].includes(run.status));assert.ok(typeof run.owner==='string'&&run.owner);
        assert.equal(run.plan_sha256,child.planSha256);assert.equal(run.approval_sha256,digest(approval));
        assert.equal(run.execution_sha256,digest(child.plan.runtimeFiles));
        assert.equal(run.cap_cents,child.capCents);assert.equal(run.reserved_cents,rows.length*2);
        if(run.status==='completed')assert.equal(rows.length,child.plan.operations.length);
        reservedCents+=run.reserved_cents;
      }else assert.equal(rows.length,0);
      for(const op of child.plan.operations){
        assert.deepEqual(op,originalByKey.get(op.key));
        latestSources.set(op.key,{sourceRunId:child.id,operation:op,
          selection:child.plan.selections.find(s=>s.profileId===op.profileId)});
        const row=rows.find(a=>a.operation_key===op.key);
        if(!row){gap=true;continue;}
        assert.ok(!gap,'A paid operation followed an untouched gap');
        assert.ok(!paid.has(op.key));paid.add(op.key);
        for(const [key,value] of Object.entries({run_id:child.id,profile_id:op.profileId,cm_artist:op.cmArtist,
          channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2,
          status:'returned',http_status:200}))assert.equal(row[key],value);
        assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(row.raw_sha256,/^[a-f0-9]{64}$/);
      }
      assert.equal(rows.length,child.plan.operations.filter(o=>paid.has(o.key)).length);
    }
  }
  assert.ok(runs.every(r=>knownChildren.has(r.id)));
  assert.ok(admissions.every(a=>knownChildren.has(a.run_id)));
  assert.equal(paid.size,admissions.length);
  const pending=originalOps.filter(o=>!paid.has(o.key)).map(o=>latestSources.get(o.key));
  assert.ok(pending.length);assert.equal(reservedCents,admissions.length*2);
  assert.equal(reservedCents+pending.length*2,bundles[0].approval.capCents);
  return {pending,paidRequests:paid.size,priorReservedCents:reservedCents,maximumAdditionalCents:pending.length*2,
    originalMaximumCents:bundles[0].approval.capCents,
    status:'prepared_scope_only_not_approved',providerRequests:0,coordinatorWrites:0,
    ownershipAccepted:false,importEligible:false};
}
