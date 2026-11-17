// Recovery has no provider transport. Only the separately approved suffix uses
// the existing one-shot executor. All writes share its original campaign lock.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveMixedRecovery,approveMixedRecoveryContinuation,mixedRecoveryPlan} from './youtube-mixed-response-recovery.mjs';
import {mixedCaptureReadiness,mixedCaptureSourceReadiness,mixedHistoricalClaims,MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {mixedClaims,executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
const plain=x=>JSON.parse(JSON.stringify(x));
export function projectedMixedRecovery(evidence,audit){
  const rows=structuredClone(evidence.admissions),capture=audit.captures.find(c=>
    c.operationKey===audit.recoverableOperationKey);
  Object.assign(rows.find(a=>a.operation_key===capture.operationKey),{status:'returned',
    http_status:200,receipt_sha256:capture.receiptSha256,raw_sha256:capture.rawSha256});
  return rows;
}
export async function verifyMixedRecoveryArchives(plan){
  assert.deepEqual(mixedRecoveryPlan(plan),plan);
  const {evidence}=plan,source=evidence.plan,root='generated-artifacts/'+source.id;
  assert.deepEqual(await read(root+'/plan.json'),source);
  assert.deepEqual(await read(root+'/approval.json'),evidence.approval);
  for(const [name,hash] of Object.entries(source.runtimeFiles))
    assert.equal(digest(await fs.readFile(root+'/'+name)),hash);
  for(const [name,hash] of Object.entries(source.sourceFiles))
    assert.equal(digest(await fs.readFile(name)),hash);
  // Detect extra receipt/raw files, including a saved response without a ledger
  // allocation. An orphan cannot be declared untouched or silently discarded.
  const expected=evidence.savedResponses.flatMap(s=>[
    digest(s.receipt.operationKey)+'.json',digest(s.receipt.operationKey)+'.raw']).sort();
  assert.deepEqual((await fs.readdir(root+'/receipts')).sort(),expected);
  for(const saved of evidence.savedResponses){
    const file=root+'/receipts/'+digest(saved.receipt.operationKey)+'.json';
    const bytes=await fs.readFile(file);assert.equal(digest(bytes),saved.receiptFileSha256);
    assert.deepEqual(JSON.parse(bytes),saved.receipt);
    const raw=await fs.readFile(root+'/'+saved.receipt.rawPath);
    assert.equal(raw.toString('base64'),saved.rawBodyBase64);
  }
}
export async function assertMixedRecoverySnapshot(c,plan,{allowRecovered=false,requireRecovered=false}={}){
  const {evidence,audit}=plan;
  const run=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',
    [evidence.plan.id])).rows[0];
  assert.deepEqual(plain(run),evidence.run,'Original owner, approval, status or reservations changed');
  const rows=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1 FOR UPDATE',
    [evidence.plan.id])).rows;
  const sorted=x=>plain(x).sort((a,b)=>a.operation_key.localeCompare(b.operation_key));
  const recovered=projectedMixedRecovery(evidence,audit);
  if(requireRecovered){assert.deepEqual(sorted(rows),sorted(recovered));return true;}
  if(allowRecovered&&digest(sorted(rows))===digest(sorted(recovered)))return true;
  assert.deepEqual(sorted(rows),sorted(evidence.admissions),'Admission history changed');
  return false;
}
export async function mixedRecoveryQuiet(c,{activeRunId='',pendingRunId=''}={}){
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
    [MIXED_PARENT])).rows[0]?.status,'stopped');
  for(const table of ['youtube_link_campaigns','youtube_discovery_test_runs','youtube_video_stage_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_runs
    WHERE status='running' AND id<>$1`,[activeRunId])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions','youtube_video_stage_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE status='admitted' AND run_id<>$1`,[pendingRunId])).rows[0].n,0);
}
export async function acknowledgeMixedSavedResponse({plan,approval,pool,assertFrozen,checkCatalog}){
  assert.deepEqual(approveMixedRecovery(plan,approval),approval);
  await assertFrozen();await verifyMixedRecoveryArchives(plan);
  const claims=plan.audit.captures.flatMap(c=>c.observed);
  // Availability or identity changes stop before any coordinator write.
  await checkCatalog([...mixedClaims(plan.evidence.plan),...claims]);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await mixedRecoveryQuiet(c,{pendingRunId:plan.evidence.plan.id});
    const already=await assertMixedRecoverySnapshot(c,plan,{allowRecovered:true});
    await mixedCaptureReadiness(c,plan.evidence.plan,{ownRun:true});
    await mixedHistoricalClaims(c,claims);
    await checkCatalog([...mixedClaims(plan.evidence.plan),...claims]);
    await assertFrozen();await verifyMixedRecoveryArchives(plan);
    if(!already){
      const capture=plan.audit.captures.find(c=>c.operationKey===plan.audit.recoverableOperationKey);
      assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
        receipt_sha256=$3,raw_sha256=$4,http_status=200 WHERE run_id=$1 AND operation_key=$2
        AND status='admitted' AND receipt_sha256 IS NULL AND raw_sha256 IS NULL AND http_status IS NULL`,
      [plan.evidence.plan.id,capture.operationKey,capture.receiptSha256,capture.rawSha256])).rowCount,1);
    }
    await c.query('COMMIT');
    return {recoveryPlanSha256:digest(plan),approvalSha256:digest(approval),
      sourceRunId:plan.audit.sourceRunId,sourceOwner:plan.audit.sourceOwner,
      operationKey:plan.audit.recoverableOperationKey,status:'saved_valid_transport_acknowledged',
      originalReservationsCents:plan.audit.priorReservedCents,sourceStatus:'stopped',
      providerRequests:0,newReservations:0,createdClaims:0,catalogWrites:0,
      ownershipAccepted:false,importEligible:false};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export async function mixedContinuationReadiness(c,plan,approval,{ownRun=false}={}){
  assert.deepEqual(approveMixedRecoveryContinuation(plan,approval),approval);
  const recovery=plan.recoveryPlan;
  await mixedRecoveryQuiet(c,{activeRunId:ownRun?plan.id:''});
  await assertMixedRecoverySnapshot(c,recovery,{requireRecovered:true});
  await mixedCaptureSourceReadiness(c,recovery.evidence.plan);
  const runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows;
  const rows=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1 FOR UPDATE',[plan.id])).rows;
  assert.equal(runs.length,ownRun?1:0);if(!ownRun)assert.equal(rows.length,0);
  if(ownRun){
    const run=runs[0];
    for(const [k,v] of Object.entries({plan_sha256:digest(plan),approval_sha256:digest(approval),
      execution_sha256:digest(plan.runtimeFiles),cap_cents:plan.maximumSpendCents,
      reserved_cents:rows.length*2,status:'running'}))assert.equal(run[k],v);
    assert.ok(rows.every(r=>r.status==='returned'&&r.http_status===200));
    assert.deepEqual(new Set(rows.map(r=>r.operation_key)),new Set(plan.operations.slice(0,rows.length).map(o=>o.key)));
    for(const row of rows){
      const op=plan.operations.find(o=>o.key===row.operation_key);assert.ok(op);
      for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
        channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2}))
        assert.equal(row[k],v);
    }
  }
  assert.ok(plan.priorReservedCents+rows.length*2<=plan.combinedCapCents);
  // Independent identity exclusions across ALL runs, not merely request hashes.
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE run_id<>$1 AND kind='metadata' AND
    (profile_id=ANY($2::text[]) OR cm_artist=ANY($3::text[]) OR channel_id=ANY($4::text[]))`,
  [plan.id,plan.operations.map(o=>o.profileId),plan.operations.map(o=>o.cmArtist),
    plan.operations.map(o=>o.allocationChannelKey)])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
      WHERE kind='metadata' AND profile_id=ANY($1::text[])`,[plan.operations.map(o=>o.profileId)])).rows[0].n,0);
  await mixedHistoricalClaims(c,mixedClaims(plan));
}
export async function executeMixedRecoveryContinuation(options){
  const {plan,approval}=options;
  assert.deepEqual(approveMixedRecoveryContinuation(plan,approval),approval);
  await verifyMixedRecoveryArchives(plan.recoveryPlan);
  // No override hooks from a caller can bypass the exact suffix admission gate.
  return executeMixedCaptures({...options,
    assertFrozen:async()=>{
      await options.assertFrozen();
      await verifyMixedRecoveryArchives(plan.recoveryPlan);
    },
    approvalCheck:(p,a)=>assert.deepEqual(approveMixedRecoveryContinuation(p,a),a),
    readinessCheck:(c,p,o)=>mixedContinuationReadiness(c,p,approval,o)});
}
export async function saveMixedRecoveryResult(root,result){
  const file=root+'/recovery-result.json';
  try{assert.deepEqual(await read(file),result);return;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    await durableStageFile(temporary,JSON.stringify(result,null,2));
    try{await fs.link(temporary,file);}
    catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(await read(file),result);}
  }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
