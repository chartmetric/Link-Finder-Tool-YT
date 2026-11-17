import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewBatchPlan,approveReviewBatch} from './youtube-review-batch.mjs';
import {assertBoundedYoutubeAdmission} from './youtube-bounded-test-gate.mjs';
import {coordinatorTransactions} from './campaign-parallel-coordinator.mjs';
export const PARALLEL_REVIEW_POLICY='same-hundred-sixteen-lanes-no-replay-v1';
export const SOURCE_ID='youtube-test-100-review-e2e-2026-11-17';
export const SOURCE_ROOT='generated-artifacts/'+SOURCE_ID;
export const TARGET_ID='youtube-test-100-review-parallel-2026-11-17';
export const TARGET_ROOT='generated-artifacts/'+TARGET_ID;
export const SNAPSHOT_SQL=`SELECT id,owner,scope_sha256,cap_cents,reserved_cents,status,created_at::text
  FROM youtube_discovery_test_runs WHERE id=$1`;
export const ADMISSIONS_SQL=`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
  status,receipt_sha256,http_status,created_at::text FROM youtube_bounded_test_admissions
  WHERE run_id=$1 ORDER BY operation_key`;
export async function sourceSnapshot(c){
  return {run:(await c.query(SNAPSHOT_SQL,[SOURCE_ID])).rows[0],
    admissions:(await c.query(ADMISSIONS_SQL,[SOURCE_ID])).rows};
}
export function validateSourceSnapshot(snapshot,plan){
  const {run,admissions}=snapshot;
  assert.equal(run.id,SOURCE_ID);assert.equal(run.status,'stopped');
  assert.equal(run.scope_sha256,plan.scopeSha256);assert.equal(run.cap_cents,1000);
  assert.equal(run.reserved_cents,admissions.length*2);
  assert.ok(run.reserved_cents<=1000);assert.ok(admissions.length<=500);
  for(const op of admissions){
    assert.equal(op.run_id,SOURCE_ID);assert.equal(op.status,'returned');
    assert.ok(op.http_status===200||(op.http_status>=500&&op.http_status<600));
    assert.equal(op.reserved_cents,2);
    assert.ok(plan.artists.some(a=>a.profile_id===op.profile_id));
    assert.ok(['search','metadata','model'].includes(op.kind));
    assert.ok(op.operation_key.startsWith(op.kind+'-'+op.profile_id+'-'));
    for(const s of [op.input_sha256,op.receipt_sha256])assert.match(s,/^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(admissions.map(a=>a.operation_key)).size,admissions.length);
  for(const a of plan.artists){
    const ops=admissions.filter(o=>o.profile_id===a.profile_id);
    assert.ok(ops.length<=5);
    assert.ok(ops.filter(o=>o.kind==='search').length<=1);
    assert.ok(ops.filter(o=>o.kind==='metadata').length<=2);
    assert.ok(ops.filter(o=>o.kind==='model').length<=2);
  }
}
export function parallelPlan(p){
  assert.deepEqual(reviewBatchPlan(p),p);
  assert.equal(p.id,TARGET_ID);assert.equal(p.parallelPolicy,PARALLEL_REVIEW_POLICY);
  assert.equal(p.parallelism,16);assert.equal(p.providerIntervalMs,100);
  assert.equal(p.sourceId,SOURCE_ID);
  assert.equal(p.sourceSnapshotSha256,digest(p.sourceSnapshot));
  validateSourceSnapshot(p.sourceSnapshot,p);
  assert.equal(p.sourceReservedCents,p.sourceSnapshot.run.reserved_cents);
  assert.equal(p.remainingAllowanceCents,1000-p.sourceReservedCents);
  assert.equal(p.totalSharedAllowanceCents,1000);
  assert.equal(p.sourcePlanSha256,digest(p.sourcePlan));
  assert.deepEqual(reviewBatchPlan(p.sourcePlan),p.sourcePlan);
  assert.equal(p.sourcePlan.id,SOURCE_ID);
  assert.deepEqual(p.artists,p.sourcePlan.artists);assert.deepEqual(p.packets,p.sourcePlan.packets);
  assert.equal(p.sourceApproval.planSha256,p.sourcePlanSha256);
  assert.deepEqual(approveReviewBatch(p.sourcePlan,p.sourceApproval),p.sourceApproval);
  const ids=p.completedRecords.map(r=>r.artist.profileId);
  assert.equal(new Set(ids).size,ids.length);
  assert.ok(ids.every(id=>p.artists.some(a=>a.profile_id===id)));
  assert.deepEqual(p.failedProfileIds,[...new Set(p.sourceSnapshot.admissions
    .filter(a=>a.http_status>=500).map(a=>a.profile_id))].sort());
  assert.ok(p.failedProfileIds.every(id=>!ids.includes(id)));
  return p;
}
export async function validatedSourcePackets(plan,{readFile=fs.readFile}={}){
  const packets=new Map();
  for(const op of plan.sourceSnapshot.admissions){
    const suffix=digest(op.operation_key),prefix=SOURCE_ROOT+'/receipts/'+suffix;
    const receiptBytes=await readFile(prefix+'.json'),receipt=JSON.parse(receiptBytes);
    const raw=await readFile(prefix+'.raw');
    assert.equal(digest(receiptBytes),op.receipt_sha256);
    assert.equal(digest(raw),receipt.rawBodySha256);
    assert.equal(receipt.runId,SOURCE_ID);assert.equal(receipt.operationKey,op.operation_key);
    assert.equal(receipt.profileId,op.profile_id);assert.equal(receipt.kind,op.kind);
    assert.equal(receipt.inputSha256,op.input_sha256);assert.equal(digest(receipt.request),op.input_sha256);
    assert.equal(receipt.status,op.http_status);assert.equal(receipt.rawPath,'receipts/'+suffix+'.raw');
    const artist=plan.artists.find(a=>a.profile_id===op.profile_id);
    assert.equal(receipt.cmArtist,artist.cm_artist);
    const saved=JSON.parse(await readFile(SOURCE_ROOT+'/inputs/'+suffix+'.json'));
    assert.deepEqual(saved.request,receipt.request);
    assert.deepEqual(saved.op,{profileId:op.profile_id,kind:op.kind,key:op.operation_key,inputSha256:op.input_sha256});
    packets.set(op.operation_key,{...receipt,data:JSON.parse(raw),
      sourcePath:prefix+'.json',rawBodyBase64:raw.toString('base64')});
  }
  return packets;
}
export function reuseSourcePackets(packets,dispatch){
  const reused=new Set();
  return {reused,async request(profileId,kind,key,request){
    const saved=packets.get(key);
    if(!saved)return dispatch(profileId,kind,key,request);
    assert.equal(saved.profileId,profileId);assert.equal(saved.kind,kind);
    assert.equal(saved.inputSha256,digest(request));assert.deepEqual(saved.request,request);
    reused.add(key);return structuredClone(saved);
  }};
}
export function assertLiveParallel({plan,run,owner,pending,live,operation,artistHistory,closed}){
  assert.equal(closed,false,'Dispatch closed; drain existing responses only');
  assert.ok(pending.length<plan.parallelism);
  for(const p of pending){
    assert.deepEqual(live.get(p.operation_key),{profileId:p.profile_id,kind:p.kind,inputSha256:p.input_sha256});
    assert.notEqual(p.profile_id,operation.profileId,'Never overlap requests for one artist');
  }
  assertBoundedYoutubeAdmission(run,{...plan.approval,artists:plan.artists},operation,0,owner);
  assert.ok(plan.sourceReservedCents+Number(run.reserved_cents)+2<=1000,'Shared original $10 allowance reached');
  assert.ok(artistHistory.length<5);
  assert.ok(artistHistory.every(r=>r.status==='returned'));
  assert.ok(!artistHistory.some(r=>r.operation_key===operation.key),'Saved operation must be reused, never dispatched');
  if(operation.kind==='search')assert.equal(artistHistory.length,0);
  else{
    assert.equal(artistHistory.filter(r=>r.kind==='search').length,1);
    assert.ok(artistHistory.filter(r=>r.kind===operation.kind).length<2);
    if(operation.kind==='model')assert.ok(artistHistory.some(r=>r.kind==='metadata'));
  }
}
export async function assertParallelWorld(c,ownId){
  for(const table of ['youtube_link_campaigns','youtube_video_stage_runs','youtube_video_identity_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_discovery_test_runs
    WHERE status='running' AND id<>$1`,[ownId])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_video_stage_admissions','youtube_video_identity_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
    WHERE status='admitted' AND run_id<>$1`,[ownId])).rows[0].n,0);
}
export function parallelGate({pool,plan,approval,owner}){
  const tx=coordinatorTransactions(pool),live=new Map();let closed=false;
  const close=()=>{closed=true;};
  return {close,live,
    async admit(op){
      try{return await tx(async c=>{
        assert.equal(closed,false);
        const parent=(await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[plan.parentId])).rows[0];
        assert.equal(parent?.status,'stopped');
        const source=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[SOURCE_ID])).rows[0];
        assert.equal(source?.status,'stopped');assert.equal(source.owner,plan.sourceSnapshot.run.owner);
        assert.equal(source.reserved_cents,plan.sourceReservedCents);assert.equal(source.scope_sha256,plan.scopeSha256);
        const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
        await assertParallelWorld(c,plan.id);
        const pending=(await c.query(`SELECT operation_key,profile_id,kind,input_sha256 FROM youtube_bounded_test_admissions
          WHERE run_id=$1 AND status='admitted' ORDER BY operation_key`,[plan.id])).rows;
        const history=(await c.query(`SELECT operation_key,kind,status FROM youtube_bounded_test_admissions
          WHERE run_id=ANY($1::text[]) AND profile_id=$2 ORDER BY created_at,operation_key`,
        [[SOURCE_ID,plan.id],op.profileId])).rows;
        assertLiveParallel({plan:{...plan,approval},run,owner,pending,live,operation:op,artistHistory:history,closed});
        await c.query(`INSERT INTO youtube_bounded_test_admissions
          (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
        [plan.id,op.key,op.profileId,op.kind,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2+$2<=1000`,[plan.id,plan.sourceReservedCents])).rowCount,1);
        live.set(op.key,{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
      });}catch(e){close();throw e;}
    },
    async returned(op,receiptSha,status){
      try{return await tx(async c=>{
        assert.deepEqual(live.get(op.key),{profileId:op.profileId,kind:op.kind,inputSha256:op.inputSha256});
        assert.equal((await c.query(`UPDATE youtube_bounded_test_admissions a
          SET status='returned',receipt_sha256=$6,http_status=$7 FROM youtube_discovery_test_runs r
          WHERE a.run_id=$1 AND a.operation_key=$2 AND a.profile_id=$3 AND a.input_sha256=$4
          AND a.status='admitted' AND a.kind=$8 AND r.id=a.run_id AND r.owner=$5 AND r.status='running'`,
        [plan.id,op.key,op.profileId,op.inputSha256,owner,receiptSha,status,op.kind])).rowCount,1);
        live.delete(op.key);
      });}catch(e){close();throw e;}
    },
  };
}
export async function boundedParallelArtists(rows,width,work,onError){
  assert.ok(Number.isInteger(width)&&width>=1&&width<=16);
  assert.equal(new Set(rows.map(a=>a.profile_id)).size,rows.length);
  let cursor=0,failure=null;
  await Promise.all(Array.from({length:Math.min(width,rows.length)},async()=>{
    while(!failure){
      const row=rows[cursor++];if(!row)return;
      try{await work(row);}catch(e){if(!failure){failure=e;onError(e);}}
    }
  }));
  if(failure)throw failure;
}
export async function fingerprintTree(root,files){
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    const file=root+'/'+entry.name;
    if(entry.isSymbolicLink()&&entry.name==='node_modules'&&path.basename(root)==='runtime'){
      assert.equal(await fs.realpath(file),await fs.realpath('scripts/node_modules'));continue;
    }
    assert.ok(!entry.isSymbolicLink());
    if(entry.isDirectory())await fingerprintTree(file,files);
    else{assert.ok(entry.isFile());files[file]=digest(await fs.readFile(file));}
  }
}
