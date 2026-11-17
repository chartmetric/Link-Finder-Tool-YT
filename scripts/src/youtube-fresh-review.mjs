import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewBatchPlan,approveReviewBatch} from './youtube-review-batch.mjs';
import {REPRESENTATION_VERSION} from './youtube-artist-representation.mjs';
import {assertLiveParallel,assertParallelWorld,validateSourceSnapshot} from './youtube-review-parallel.mjs';
import {coordinatorTransactions} from './campaign-parallel-coordinator.mjs';

export const FRESH_REVIEW_POLICY='fresh-hundred-representation-sixteen-lanes-v1';
export function freshReviewPlan(p){
  const plan=reviewBatchPlan(p);
  assert.equal(plan.freshPolicy,FRESH_REVIEW_POLICY);
  assert.equal(plan.verificationPolicy,REPRESENTATION_VERSION);
  assert.equal(plan.parallelism,16);assert.equal(plan.providerIntervalMs,100);
  if(plan.continuation===true){
    assert.equal(plan.sourcePlan.continuation,undefined,'Only one-source continuations are supported');
    assert.deepEqual(freshReviewPlan(plan.sourcePlan),plan.sourcePlan);
    assert.equal(plan.sourcePlan.id,plan.sourceId);
    assert.equal(plan.continuationSourceRoot,'generated-artifacts/'+plan.sourceId);
    assert.equal(plan.sourcePlanSha256,digest(plan.sourcePlan));
    assert.deepEqual(approveReviewBatch(plan.sourcePlan,plan.sourceApproval),plan.sourceApproval);
    assert.equal(plan.sourceApproval.planSha256,plan.sourcePlanSha256);
    assert.deepEqual(plan.artists,plan.sourcePlan.artists);assert.deepEqual(plan.packets,plan.sourcePlan.packets);
    assert.equal(plan.sourceSnapshotSha256,digest(plan.sourceSnapshot));
    validateSourceSnapshot(plan.sourceSnapshot,plan.sourcePlan,plan.sourceId);
    assert.equal(plan.sourceReservedCents,plan.sourceSnapshot.run.reserved_cents);
    assert.equal(new Set(plan.completedRecords.map(r=>r.artist.profileId)).size,plan.completedRecords.length);
    for(const r of plan.completedRecords)assert.ok(plan.artists.some(a=>
      a.profile_id===r.artist.profileId&&a.cm_artist===r.artist.cmArtist));
  }else assert.equal(plan.sourceReservedCents,0);
  assert.match(plan.id,/^youtube-test-100-review-repr-[a-z0-9-]{4,55}$/);
  assert.match(plan.sourceRoot,/^generated-artifacts\/youtube-batch-100-[a-z0-9-]{4,70}$/);
  assert.equal(plan.experimentOnly,true);
  return plan;
}
export function approveFreshReview(plan,approval){
  assert.deepEqual(freshReviewPlan(plan),plan);
  return approveReviewBatch(plan,approval);
}
// Each lane has at most one charged request. Local FIFO avoids lock congestion;
// the database remains authoritative for reservations and uncertain work.
export function freshReviewGate({pool,plan,approval,owner}){
  const tx=coordinatorTransactions(pool),live=new Map();let closed=false;
  const close=()=>{closed=true;};
  return {close,live,async admit(op){
    try{return await tx(async c=>{
      assert.equal(closed,false);
      const parent=(await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [plan.parentId])).rows[0];assert.equal(parent?.status,'stopped');
      const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',
        [plan.id])).rows[0];
      await assertParallelWorld(c,plan.id);
      const pending=(await c.query(`SELECT operation_key,profile_id,kind,input_sha256
        FROM youtube_bounded_test_admissions WHERE run_id=$1 AND status='admitted' ORDER BY operation_key`,
      [plan.id])).rows;
      const history=(await c.query(`SELECT operation_key,kind,status FROM youtube_bounded_test_admissions
        WHERE run_id=$1 AND profile_id=$2 ORDER BY created_at,operation_key`,[plan.id,op.profileId])).rows;
      assertLiveParallel({plan:{...plan,approval},run,owner,pending,live,operation:op,artistHistory:history,closed});
      await c.query(`INSERT INTO youtube_bounded_test_admissions
        (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
      [plan.id,op.key,op.profileId,op.kind,op.inputSha256]);
      assert.equal((await c.query(`UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2
        WHERE id=$1 AND owner=$2 AND status='running' AND reserved_cents+2<=cap_cents`,
      [plan.id,owner])).rowCount,1);
      live.set(op.key,{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
    });}catch(e){close();throw e;}
  },async returned(op,sha,status){
    try{return await tx(async c=>{
      assert.deepEqual(live.get(op.key),{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
      assert.equal((await c.query(`UPDATE youtube_bounded_test_admissions a SET
        status='returned',receipt_sha256=$6,http_status=$7 FROM youtube_discovery_test_runs r
        WHERE a.run_id=$1 AND a.operation_key=$2 AND a.profile_id=$3 AND a.input_sha256=$4
        AND a.status='admitted' AND a.kind=$8 AND r.id=a.run_id AND r.owner=$5 AND r.status='running'`,
      [plan.id,op.key,op.profileId,op.inputSha256,owner,sha,status,op.kind])).rowCount,1);
      live.delete(op.key);
    });}catch(e){close();throw e;}
  }};
}
export const freshApprovalHash=plan=>digest(plan);
