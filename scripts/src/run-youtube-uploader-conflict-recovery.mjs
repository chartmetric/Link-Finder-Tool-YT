// Future execution requires a new exact approval covering BOTH the saved
// conflict acknowledgment and the eight (or other frozen suffix) new requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveVideoStage,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {validateConflictRecovery,assertConflictLedger,CONFLICT_RECOVERY_POLICY} from './youtube-uploader-conflict-recovery.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {durableStageFile,executeVideoStage} from './youtube-video-stage-execution.mjs';
import {videoStageGate} from './youtube-video-stage-gate.mjs';
import {CONFLICT_HANDLING_FILE,uploaderConflictHandlingApproval} from './youtube-uploader-conflict-handling.mjs';
const read=async p=>JSON.parse(await fs.readFile(p));

export async function assertConflictFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [file,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(root+'/'+file)),sha);
  const evidence=await read(root+'/evidence/conflict-recovery.json');
  validateConflictRecovery(plan,evidence);
  const source='generated-artifacts/'+evidence.previousPlan.id;
  for(const [file,sha] of Object.entries(evidence.sourceFiles))
    assert.equal(digest(await fs.readFile(source+'/'+file)),sha,'Original saved evidence changed');
  return evidence;
}
export function conflictExecutionApproval(plan,approval){
  assertVideoStageApproval(plan,approval);
  return {policy:CONFLICT_RECOVERY_POLICY,planSha256:digest(plan),
    stageApprovalSha256:digest(approval),explicitApproval:true,
    acknowledgeSavedConflictOnly:true,allowAmbiguousChannelSelection:false,
    allowRetry:false,continuationCapCents:plan.maximumSpendCents,
    ...(plan.evidenceFiles[CONFLICT_HANDLING_FILE]?{
      holdNewChannelConflicts:true,conflictHandlingApproval:uploaderConflictHandlingApproval(plan,approval),
    }:{})};
}
export async function acknowledgeConflictReceipt({pool,plan,evidence,approval,supplement}){
  assert.deepEqual(supplement,conflictExecutionApproval(plan,approval));
  const {pendingOp}=validateConflictRecovery(plan,evidence),c=await pool.connect();
  try{
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [plan.parentId])).rows[0]?.status,'stopped');
    for(const sql of [
      "SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'",
      "SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'",
      "SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE status='admitted'",
      "SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'",
    ])assert.equal((await c.query(sql)).rows[0].n,0);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_stage_runs WHERE id=$1',[plan.id])).rows[0].n,0);
    const run=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1 FOR UPDATE',
      [evidence.previousPlan.id])).rows[0];
    const admissions=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1 FOR UPDATE',
      [evidence.previousPlan.id])).rows;
    assertConflictLedger(evidence,run,admissions);
    const pending=(await c.query("SELECT run_id,operation_key FROM youtube_video_stage_admissions WHERE status='admitted'")).rows;
    assert.ok(pending.every(a=>a.run_id===run.id&&a.operation_key===pendingOp.key));
    const saved=admissions.find(a=>a.operation_key===pendingOp.key);
    if(saved.status==='admitted'){
      const update=await c.query(`UPDATE youtube_video_stage_admissions
        SET status='returned',http_status=200,receipt_sha256=$3,raw_sha256=$4
        WHERE run_id=$1 AND operation_key=$2 AND status='admitted'`,
      [run.id,pendingOp.key,digest(evidence.receipt),evidence.receipt.rawBodySha256]);
      assert.equal(update.rowCount,1);
    }
    // This records receipt only: the sealed conflictReview remains held with
    // no selected channel, no mapped uploader and no ownership/import approval.
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved|acknowledge-saved-conflict)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  const id=value('id');assert.match(id??'',/^youtube-video-review-[a-z0-9-]{4,80}$/);
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');
  assert.equal(plan.id,id);
  const evidence=await assertConflictFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    assert.ok(args.includes('--acknowledge-saved-conflict'),'Separate explicit acknowledgment scope required');
    const approval=approveVideoStage(plan,{expectedPlanSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));
    await durableStageFile(root+'/recovery-approval.json',JSON.stringify(conflictExecutionApproval(plan,approval),null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  for(const key of ['plan-sha256','approve-cents'])assert.equal(value(key),undefined);
  assert.ok(!args.includes('--acknowledge-saved-conflict'));
  const approval=await read(root+'/approval.json'),supplement=await read(root+'/recovery-approval.json');
  assert.deepEqual(supplement,conflictExecutionApproval(plan,approval));
  const eligible=await currentEligible(plan.artists);
  assert.ok(plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier));
  assert.ok(process.env.SCRAPECREATORS_API_KEY,'Provider credential required');
  const pool=await connectSavedBatchPool();
  try{
    await acknowledgeConflictReceipt({pool,plan,evidence,approval,supplement});
    await durableStageFile(root+'/conflict-acknowledgment.json',JSON.stringify({
      sourceRunId:evidence.previousPlan.id,receiptSha256:digest(evidence.receipt),
      conflictReview:evidence.conflictReview,providerRequests:0,reservationsChanged:false}));
    const gate=videoStageGate({pool,plan,approval,owner:randomUUID()});
    await executeVideoStage({root,plan,approval,gate,credential:process.env.SCRAPECREATORS_API_KEY,
      ...(supplement.holdNewChannelConflicts?{conflictHandlingApproval:supplement.conflictHandlingApproval}:{}),
      assertFrozen:async()=>{
        await assertConflictFrozen(root,plan);
        assert.equal(digest(await read(root+'/approval.json')),digest(approval));
        assert.deepEqual(await read(root+'/recovery-approval.json'),supplement);
      }});
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
