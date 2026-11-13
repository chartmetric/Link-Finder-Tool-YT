// Exact saved-response acknowledgment only. No provider transport or restart.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

const projection=ledger=>({
  campaign:ledger.campaign,runs:ledger.runs,admissions:ledger.admissions,
  activeTests:ledger.activeTests,pendingTests:ledger.pendingTests,
});
export function recoveredLedger(proposal){
  const expected=structuredClone(projection(proposal.ledger));
  const ack=proposal.proposedAcknowledgment;
  const targets=expected.admissions.filter(a=>a.run_id===ack.runId&&a.operation_key===ack.operationKey);
  assert.equal(targets.length,1);assert.equal(targets[0].status,'admitted');
  Object.assign(targets[0],{status:'returned',http_status:200,
    receipt_sha256:ack.receiptSha256,raw_sha256:ack.rawSha256});
  return expected;
}
export function assertRecoverySnapshot(proposal,current){
  const snapshot=projection(current),recovered=recoveredLedger(proposal);
  if(digest(snapshot)===digest(recovered))return 'already_applied';
  assert.deepEqual(snapshot,projection(proposal.ledger),'Ledger changed since recovery approval');
  return 'pending';
}
async function readLedger(client,parentId){
  const rows=async(sql,params=[]) => (await client.query(sql,params)).rows;
  return {
    campaign:await rows('SELECT id,status FROM youtube_link_campaigns WHERE id=$1',[parentId]),
    runs:await rows('SELECT id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status FROM youtube_video_stage_runs ORDER BY id'),
    admissions:await rows(`SELECT run_id,operation_key,profile_id,cm_artist,video_id,input_sha256,
      status,receipt_sha256,raw_sha256,http_status FROM youtube_video_stage_admissions ORDER BY run_id,operation_key`),
    activeTests:await rows("SELECT id FROM youtube_discovery_test_runs WHERE status='running'"),
    pendingTests:await rows("SELECT run_id,operation_key FROM youtube_bounded_test_admissions WHERE status='admitted'"),
  };
}
export async function applyRecoveryTransaction({client,proposal,verifySource,installResult}){
  let begun=false;
  try{
    await client.query('BEGIN');begun=true;
    await client.query("SET LOCAL lock_timeout='5s'");
    // Block new launches/admissions while comparing the complete approved
    // ledger. No run owner, status, reservation or approval row is changed.
    const parentId=proposal.ledger.campaign[0]?.id;
    assert.equal((await client.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [parentId])).rows[0]?.status,'stopped');
    await client.query(`LOCK TABLE youtube_video_stage_runs,youtube_video_stage_admissions,
      youtube_discovery_test_runs,youtube_bounded_test_admissions IN SHARE ROW EXCLUSIVE MODE`);
    const state=assertRecoverySnapshot(proposal,await readLedger(client,parentId));
    await verifySource();
    const ack=proposal.proposedAcknowledgment;
    if(state==='pending'){
      const original=proposal.ledger.admissions.find(a=>a.run_id===ack.runId&&a.operation_key===ack.operationKey);
      const updated=await client.query(`UPDATE youtube_video_stage_admissions SET status='returned',
        http_status=200,receipt_sha256=$7,raw_sha256=$8
        WHERE run_id=$1 AND operation_key=$2 AND profile_id=$3 AND cm_artist=$4 AND video_id=$5
          AND input_sha256=$6 AND status='admitted'
          AND http_status IS NULL AND receipt_sha256 IS NULL AND raw_sha256 IS NULL`,
      [ack.runId,ack.operationKey,original.profile_id,original.cm_artist,original.video_id,
        original.input_sha256,ack.receiptSha256,ack.rawSha256]);
      assert.equal(updated.rowCount,1,'Exact acknowledgment fence failed');
    }
    // Persist only an unaccepted mapped result. On crash the DB transaction
    // rolls back; a retry accepts this file only if its bytes are exact.
    await installResult();
    assert.deepEqual(projection(await readLedger(client,parentId)),recoveredLedger(proposal));
    await verifySource();
    await client.query('COMMIT');begun=false;
    return {status:'recovered_without_replay',alreadyApplied:state==='already_applied',
      acknowledgmentChanges:state==='pending'?1:0,providerCalls:0,newReservationCents:0,
      runResumed:false,catalogWrites:0,ownershipAccepted:false};
  }catch(error){if(begun)await client.query('ROLLBACK');throw error;}
}
async function exactFile(file,content){
  try{
    const f=await fs.open(file,'wx');
    try{await f.writeFile(content);await f.sync();}finally{await f.close();}
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    assert.deepEqual(await fs.readFile(file),Buffer.from(content),'Existing recovery file differs');
  }
}
export async function applyApprovedRecovery(root,expectedProposalSha256,{connect=connectSavedBatchPool}={}){
  assert.match(expectedProposalSha256,/^[a-f0-9]{64}$/);
  const proposalBytes=await fs.readFile(path.join(root,'recovery-proposal.json'));
  const proposal=JSON.parse(proposalBytes);
  assert.equal(digest(proposal),expectedProposalSha256,'Exact approved recovery proposal required');
  assert.equal(proposal.version,'single-saved-response-ledger-recovery-proposal-v1');
  assert.match(proposal.sourceRunId,/^youtube-video-review-[a-z0-9-]{4,80}$/);
  assert.equal(proposal.newProviderCalls,0);assert.equal(proposal.newReservationCents,0);
  assert.equal(proposal.includesUntouchedDispatchApproval,false);
  assert.equal(proposal.includesNewFallbackStageApproval,false);
  assert.equal(proposal.sourceRunMustRemainStopped,true);
  assert.equal(proposal.noReservationChanges,true);assert.equal(proposal.noAcceptanceChanges,true);
  const sourceRoot=path.join('generated-artifacts',proposal.sourceRunId);
  const read=async name=>JSON.parse(await fs.readFile(path.join(sourceRoot,name)));
  const plan=await read('plan.json'),oldApproval=await read('approval.json');
  assertVideoStageApproval(plan,oldApproval);
  assert.equal(digest(plan),proposal.sourcePlanSha256);
  assert.equal(digest(oldApproval),proposal.sourceApprovalSha256);
  const ack=proposal.proposedAcknowledgment;
  assert.equal(ack.runId,proposal.sourceRunId);assert.equal(ack.operationKey,proposal.pendingOperationKey);
  assert.equal(ack.fromStatus,'admitted');assert.equal(ack.toStatus,'returned');assert.equal(ack.httpStatus,200);
  const receipt=await read('receipts/'+digest(ack.operationKey)+'.json');
  assert.deepEqual(receipt,proposal.savedReceipt);
  assert.equal(receipt.rawPath,'receipts/'+digest(ack.operationKey)+'.raw');
  const rawBody=await fs.readFile(path.join(sourceRoot,receipt.rawPath));
  assert.equal(digest(receipt),ack.receiptSha256);assert.equal(digest(rawBody),ack.rawSha256);
  const evidence=await read('evidence/'+receipt.profileId+'.json');
  const clue=evidence.videoPlan.resolutionQueue.find(c=>c.videoId===receipt.videoId);assert.ok(clue);
  const mapped=mapSavedVideoUploader(evidence.artist,clue,{...receipt,rawBody},
    {runId:plan.id,planSha256:digest(plan)});
  assert.deepEqual(mapped,proposal.mappedSavedResponse);
  const result={...mapped,profileId:evidence.artist.profileId,cmArtist:evidence.artist.cmArtist,
    artist:evidence.artist.name,tier:plan.artists.find(a=>a.profileId===receipt.profileId).tier,
    videoUrl:clue.url,ownershipAccepted:false,recoveredWithoutReplay:true};
  assert.deepEqual(result,proposal.proposedLocalResult);
  const verifySource=async()=>{
    assert.deepEqual(await fs.readFile(path.join(root,'recovery-proposal.json')),proposalBytes);
    for(const [file,sha] of Object.entries(proposal.sourceFiles)){
      assert.ok(/^[A-Za-z0-9_./-]+$/.test(file)&&!file.startsWith('/')
        &&!file.split('/').some(p=>['','..','.'].includes(p)));
      assert.equal(digest(await fs.readFile(path.join(sourceRoot,file))),sha);
    }
    for(const [file,sha] of Object.entries(proposal.mapperFiles)){
      assert.ok(['youtube-video-discovery-offline.mjs','youtube-video-uploader-review.mjs'].includes(file));
      assert.equal(digest(await fs.readFile(new URL('./'+file,import.meta.url))),sha);
    }
    for(const op of proposal.untouchedOperations)
      for(const file of ['inputs/'+digest(op.key)+'.json','receipts/'+digest(op.key)+'.json',
        'receipts/'+digest(op.key)+'.raw','results/'+digest(op.key)+'.json']){
        try{await fs.access(path.join(sourceRoot,file));assert.fail('Untouched request changed');}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
  };
  await verifySource();
  const approval={version:'saved-response-recovery-only-approval-v1',proposalSha256:expectedProposalSha256,
    sourceRunId:proposal.sourceRunId,operationKey:ack.operationKey,explicitApproval:true,
    scope:'acknowledge_one_saved_response_and_persist_unaccepted_result',
    providerCallsApproved:0,newReservationCentsApproved:0,resumeApproved:false};
  await exactFile(path.join(root,'recovery-approval.json'),JSON.stringify(approval,null,2));
  const pool=await connect();let client;
  try{
    client=await pool.connect();
    const result=await applyRecoveryTransaction({client,proposal,verifySource,
      installResult:()=>exactFile(path.join(sourceRoot,'results',digest(ack.operationKey)+'.json'),
        JSON.stringify(proposal.proposedLocalResult))});
    const application={...result,proposalSha256:expectedProposalSha256,
      sourceRunId:proposal.sourceRunId,operationKey:ack.operationKey,
      originalReservationCents:proposal.originalReservedCents,
      untouchedRequests:proposal.untouchedOperations.length};
    // Stable bytes make retries safe after a commit whose client response was lost.
    const record={...application,alreadyApplied:undefined,acknowledgmentChanges:undefined};
    await exactFile(path.join(root,'recovery-applied.json'),JSON.stringify(record,null,2));
    return application;
  }finally{client?.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  assert.equal(args.length,3);assert.equal(args[0],'--apply-approved');
  assert.match(args[1],/^generated-artifacts\/[a-z0-9-]+$/);
  assert.match(args[2],/^--proposal-sha256=[a-f0-9]{64}$/);
  console.log(JSON.stringify(await applyApprovedRecovery(args[1],args[2].slice('--proposal-sha256='.length))));
}
