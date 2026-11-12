// Record one already-saved response only after a new, exact recovery approval.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';

export function validateVideoRecovery(plan,evidence){
  const r=plan.recovery;assert.ok(r);
  const {previousPlan,previousApproval,receipt,mapped}=evidence;
  assert.equal(previousPlan.id,r.previousRunId);assert.equal(previousApproval.id,r.previousRunId);
  assert.equal(previousApproval.explicitApproval,true);assert.equal(previousApproval.capCents,80);
  assert.equal(digest(previousPlan),r.previousPlanSha256);
  assert.equal(previousApproval.planSha256,r.previousPlanSha256);
  assert.equal(digest(previousApproval),r.previousApprovalSha256);
  assert.equal(previousPlan.maximumCalls,40);assert.equal(previousPlan.maximumSpendCents,80);
  assert.deepEqual(previousPlan.artists,plan.artists);
  const originalOp=previousPlan.operations.find(op=>op.key===r.completedOperationKey);assert.ok(originalOp);
  assert.deepEqual(previousPlan.operations.filter(op=>op.key!==r.completedOperationKey),plan.operations,
    'Recovery may only omit the one already-paid operation, never substitute another request');
  const rawBody=Buffer.from(evidence.rawBodyBase64,'base64');
  assert.equal(digest(rawBody),r.rawSha256);assert.equal(digest(receipt),r.receiptSha256);
  assert.equal(receipt.rawBodySha256,r.rawSha256);assert.equal(receipt.planSha256,r.previousPlanSha256);
  assert.equal(receipt.operationKey,originalOp.key);assert.equal(receipt.inputSha256,originalOp.inputSha256);
  assert.equal(receipt.profileId,originalOp.profileId);assert.equal(receipt.cmArtist,originalOp.cmArtist);
  assert.equal(receipt.videoId,originalOp.videoId);assert.equal(receipt.status,200);
  assert.equal(receipt.rawPath,'receipts/'+digest(originalOp.key)+'.raw');
  assert.deepEqual(receipt.request,originalOp.request);assert.equal(receipt.runId,r.previousRunId);
  const clue=evidence.artistEvidence.videoPlan.resolutionQueue.find(v=>v.videoId===originalOp.videoId);
  assert.ok(clue);
  const check=mapSavedVideoUploader(evidence.artistEvidence.artist,clue,{...receipt,rawBody},
    {runId:r.previousRunId,planSha256:r.previousPlanSha256});
  assert.deepEqual(check,mapped);assert.equal(digest(check),r.mappedSha256);
  return originalOp;
}
export async function reconcileSavedVideoResponse({pool,plan,approval,root}){
  assertVideoStageApproval(plan,approval);
  assert.ok(plan.evidenceFiles['evidence/recovery.json']);
  const bytes=await fs.readFile(root+'/evidence/recovery.json');
  assert.equal(digest(bytes),plan.evidenceFiles['evidence/recovery.json']);
  const evidence=JSON.parse(bytes),op=validateVideoRecovery(plan,evidence),r=plan.recovery;
  // Recheck originals on disk, rather than treating an offline reconstruction as the original receipt.
  const oldRoot='generated-artifacts/'+r.previousRunId;
  assert.equal(digest(JSON.parse(await fs.readFile(oldRoot+'/plan.json','utf8'))),r.previousPlanSha256);
  assert.equal(digest(JSON.parse(await fs.readFile(oldRoot+'/approval.json','utf8'))),r.previousApprovalSha256);
  assert.equal(digest(await fs.readFile(oldRoot+'/'+evidence.receipt.rawPath)),r.rawSha256);
  assert.equal(digest(JSON.parse(await fs.readFile(oldRoot+'/receipts/'+digest(op.key)+'.json','utf8'))),r.receiptSha256);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [plan.parentId])).rows[0]?.status,'stopped');
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'")).rows[0].n,0);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'")).rows[0].n,0);
    const previous=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1 FOR UPDATE',[r.previousRunId])).rows[0];
    assert.ok(previous&&previous.owner===r.previousOwner&&previous.status==='stopped'
      &&previous.plan_sha256===r.previousPlanSha256&&previous.approval_sha256===r.previousApprovalSha256);
    assert.equal(Number(previous.reserved_cents),2);assert.equal(Number(previous.cap_cents),80);
    const admissions=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1 FOR UPDATE',[r.previousRunId])).rows;
    assert.equal(admissions.length,1);
    const a=admissions[0];
    assert.ok(a.operation_key===op.key&&a.profile_id===op.profileId&&a.cm_artist===op.cmArtist
      &&a.video_id===op.videoId&&a.input_sha256===op.inputSha256);
    assert.ok(['admitted','returned'].includes(a.status));
    const pending=(await c.query("SELECT run_id,operation_key FROM youtube_video_stage_admissions WHERE status='admitted'")).rows;
    assert.ok(pending.every(p=>p.run_id===r.previousRunId&&p.operation_key===op.key));
    if(a.status==='returned'){
      assert.equal(a.receipt_sha256,r.receiptSha256);assert.equal(a.raw_sha256,r.rawSha256);assert.equal(a.http_status,200);
    }else{
      const updated=await c.query(`UPDATE youtube_video_stage_admissions SET status='returned',http_status=200,
        receipt_sha256=$3,raw_sha256=$4 WHERE run_id=$1 AND operation_key=$2 AND status='admitted'`,
      [r.previousRunId,op.key,r.receiptSha256,r.rawSha256]);
      assert.equal(updated.rowCount,1);
    }
    await c.query('COMMIT');
    return {recoveredWithoutReplay:true,previousReservedCents:2,remainingMaximumSpendCents:78,combinedMaximumSpendCents:80};
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
