// Recovery ONLY: no provider requests, new reservations, aliases or ownership.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {prepareDirectRecoveryContract} from './youtube-direct-capture-recovery-plan.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
const read=async file=>JSON.parse(await fs.readFile(file));
export function directRecoveryApproval(plan,options){
  assert.equal(plan.version,'exact-saved-direct-channel-receipt-recovery-v1');
  assert.equal(plan.maximumAdditionalCents,0);assert.equal(plan.providerRequests,0);
  assert.equal(plan.createOwnershipClaims,false);assert.equal(plan.catalogWrites,0);
  assert.equal(options.planSha256,digest(plan));assert.equal(options.capCents,0);
  assert.ok(Date.parse(options.approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256:digest(plan),capCents:0,approvedAt:options.approvedAt,
    explicitApproval:true,scope:'saved_receipt_accounting_only_conflict_remains_held_no_continuation'};
}
export async function accountSavedDirectReceipt({plan,approval,evidence,contract,pool}){
  assert.deepEqual(directRecoveryApproval(plan,approval),approval);
  assert.deepEqual(prepareDirectRecoveryContract(evidence),contract);
  assert.equal(plan.evidenceSha256,digest(evidence));assert.equal(plan.contractSha256,digest(contract));
  const held=contract.recovery.heldResponse,expected=contract.recovery.expectedStoppedRun;
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[MIXED_PARENT])).rows[0]?.status,'stopped');
    for(const table of ['youtube_discovery_test_runs','youtube_video_stage_runs','youtube_link_campaigns','youtube_video_identity_runs'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
    for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions','youtube_video_stage_admissions'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
    const ids=evidence.bundle.children.map(ch=>ch.id);
    const runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=ANY($1::text[]) FOR UPDATE',[ids])).rows;
    assert.equal(runs.length,evidence.runs.length);
    for(const before of evidence.runs){
      const actual=runs.find(r=>r.id===before.id);assert.ok(actual);
      for(const key of ['id','owner','status','plan_sha256','approval_sha256','execution_sha256','cap_cents','reserved_cents'])
        assert.equal(actual[key],before[key],'Original run scope or ownership changed');
    }
    const rows=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[]) FOR UPDATE',[ids])).rows;
    assert.equal(rows.length,evidence.admissions.length);
    for(const before of evidence.admissions){
      const actual=rows.find(r=>r.run_id===before.run_id&&r.operation_key===before.operation_key);assert.ok(actual);
      for(const key of ['run_id','operation_key','profile_id','cm_artist','channel_id','kind','input_sha256','reserved_cents'])
        assert.equal(actual[key],before[key]);
      if(before.status==='returned'){
        for(const key of ['status','receipt_sha256','raw_sha256','http_status'])assert.equal(actual[key],before[key]);
      }else{
        assert.equal(actual.run_id,held.sourceRunId);assert.equal(actual.operation_key,held.operationKey);
        assert.ok(['admitted','returned'].includes(actual.status));
        for(const [key,value] of Object.entries({receipt_sha256:held.receiptSha256,raw_sha256:held.rawSha256,http_status:200}))
          assert.equal(actual[key],actual.status==='returned'?value:before[key]);
      }
    }
    const pending=(await c.query("SELECT run_id,operation_key FROM youtube_video_identity_admissions WHERE status='admitted' FOR UPDATE")).rows;
    assert.ok(pending.length<=1);
    const actual=rows.find(r=>r.run_id===held.sourceRunId&&r.operation_key===held.operationKey);
    if(actual.status==='admitted'){
      assert.deepEqual(pending,[{run_id:held.sourceRunId,operation_key:held.operationKey}]);
      assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
        receipt_sha256=$3,raw_sha256=$4,http_status=200
        WHERE run_id=$1 AND operation_key=$2 AND status='admitted'`,
        [expected.id,held.operationKey,held.receiptSha256,held.rawSha256])).rowCount,1);
    }else assert.equal(pending.length,0);
    await c.query('COMMIT');
    return {status:'saved_receipt_accounted_identity_conflict_still_held',sourceRunId:expected.id,
      operationKey:held.operationKey,receiptSha256:held.receiptSha256,rawSha256:held.rawSha256,
      sourceStatus:'stopped',priorReservedCents:contract.accounting.priorReservedCents,
      providerRequests:0,newReservations:0,ownershipAccepted:false,importEligible:false,createdOwnershipClaims:0};
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>['--authorize-prepared','--apply-approved'].includes(a)
    ||/^--(?:id|plan-sha256)=[a-z0-9-]+$/.test(a)));
  assert.equal(args.filter(a=>['--authorize-prepared','--apply-approved'].includes(a)).length,1);
  const id=value('id');assert.match(id??'',/^youtube-direct-receipt-recovery-[a-z0-9-]{4,70}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');
  assert.equal(plan.id,id);assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'));
  for(const [name,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(root+'/'+name)),sha);
  for(const [name,sha] of Object.entries(plan.sourceFiles))assert.equal(digest(await fs.readFile(name)),sha);
  const evidence=await read(plan.evidencePath),contract=await read(plan.contractPath);
  assert.equal(plan.evidenceSha256,digest(evidence));assert.equal(plan.contractSha256,digest(contract));
  assert.deepEqual(prepareDirectRecoveryContract(evidence),contract);
  if(args.includes('--authorize-prepared')){
    const approval=directRecoveryApproval(plan,{planSha256:value('plan-sha256'),capCents:0,approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);
  const approval=await read(root+'/approval.json');assert.deepEqual(directRecoveryApproval(plan,approval),approval);
  const pool=await connectSavedBatchPool();
  try{
    const result=await accountSavedDirectReceipt({plan,approval,evidence,contract,pool});
    // Result file is idempotent; an interrupted write never requires refetch.
    try{assert.deepEqual(await read(root+'/recovery-result.json'),result);}
    catch(e){if(e.code!=='ENOENT')throw e;await durableStageFile(root+'/recovery-result.json',JSON.stringify(result,null,2));}
    console.log(JSON.stringify(result));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
