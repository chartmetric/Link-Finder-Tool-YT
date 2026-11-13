// Preparation only. No provider calls, approval writer, ledger writes or resume.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

export function validateRecoveryLedger({plan,approval,run,admissions,saved}){
  assertVideoStageApproval(plan,approval);
  assert.equal(run.id,plan.id);assert.equal(run.status,'stopped');
  assert.ok(typeof run.owner==='string'&&run.owner.length);
  assert.equal(run.plan_sha256,digest(plan));
  assert.equal(run.approval_sha256,digest(approval));
  assert.equal(Number(run.cap_cents),plan.maximumSpendCents);
  assert.equal(Number(run.reserved_cents),admissions.length*2);
  assert.equal(new Set(admissions.map(a=>a.operation_key)).size,admissions.length);
  const pending=admissions.filter(a=>a.status==='admitted');
  assert.equal(pending.length,1,'Exactly one saved pending response is supported');
  assert.equal(saved.length,admissions.length);
  for(const a of admissions){
    const op=plan.operations.find(o=>o.key===a.operation_key);assert.ok(op);
    for(const [db,key] of [['profile_id','profileId'],['cm_artist','cmArtist'],
      ['video_id','videoId'],['input_sha256','inputSha256']])assert.equal(a[db],op[key]);
    const s=saved.find(s=>s.receipt.operationKey===op.key);assert.ok(s);
    assert.equal(s.receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const mapped=mapSavedVideoUploader(s.artist,s.clue,{...s.receipt,rawBody:s.rawBody},
      {runId:plan.id,planSha256:digest(plan)});
    assert.equal(s.receipt.inputSha256,op.inputSha256);
    assert.deepEqual(s.receipt.request,op.request);
    if(a.status==='returned'){
      assert.equal(a.http_status,200);assert.equal(a.receipt_sha256,digest(s.receipt));
      assert.equal(a.raw_sha256,digest(s.rawBody));
      assert.ok(s.result,'Returned admission requires its saved mapped result');
      assert.equal(s.result.url,mapped.url);assert.equal(s.result.profileId,op.profileId);
      assert.equal(s.result.cmArtist,op.cmArtist);assert.equal(s.result.videoUrl,op.videoUrl);
      assert.equal(s.result.ownershipAccepted,false);
    }else{
      assert.equal(a.status,'admitted');
      for(const key of ['http_status','receipt_sha256','raw_sha256'])assert.equal(a[key],null);
      assert.equal(s.result,undefined,'Do not overwrite a preexisting mapped result');
    }
  }
  return pending[0];
}

export async function buildLedgerRecovery(sourceRoot,{connect=connectSavedBatchPool}={}){
  const files=new Map();
  const bytes=async name=>{const b=await fs.readFile(path.join(sourceRoot,name));files.set(name,digest(b));return b;};
  const read=async name=>JSON.parse(await bytes(name));
  const plan=await read('plan.json'),approval=await read('approval.json'),summary=await read('summary.json');
  assertVideoStageApproval(plan,approval);assert.equal(summary.status,'stopped');
  assert.equal(path.basename(sourceRoot),plan.id);
  for(const [file,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await bytes(file)),sha);
  const pool=await connect();let client,ledger;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows=async(sql,params=[]) => (await client.query(sql,params)).rows;
    ledger={
      checkedAt:new Date().toISOString(),
      campaign:await rows('SELECT id,status FROM youtube_link_campaigns WHERE id=$1',[plan.parentId]),
      runs:await rows('SELECT id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status FROM youtube_video_stage_runs ORDER BY id'),
      admissions:await rows(`SELECT run_id,operation_key,profile_id,cm_artist,video_id,input_sha256,
        status,receipt_sha256,raw_sha256,http_status FROM youtube_video_stage_admissions ORDER BY run_id,operation_key`),
      activeTests:await rows("SELECT id FROM youtube_discovery_test_runs WHERE status='running'"),
      pendingTests:await rows("SELECT run_id,operation_key FROM youtube_bounded_test_admissions WHERE status='admitted'"),
    };
    await client.query('COMMIT');
  }catch(error){if(client)await client.query('ROLLBACK');throw error;}
  finally{client?.release();await pool.end();}
  assert.equal(ledger.campaign.length,1);assert.equal(ledger.campaign[0].status,'stopped');
  assert.equal(ledger.activeTests.length,0);assert.equal(ledger.pendingTests.length,0);
  assert.ok(ledger.runs.every(r=>r.status!=='running'));
  const run=ledger.runs.find(r=>r.id===plan.id);assert.ok(run);
  const admissions=ledger.admissions.filter(a=>a.run_id===plan.id);
  const globalPending=ledger.admissions.filter(a=>a.status==='admitted');
  assert.equal(globalPending.length,1);assert.equal(globalPending[0].run_id,plan.id);
  const saved=[];
  for(const a of admissions){
    const op=plan.operations.find(o=>o.key===a.operation_key);assert.ok(op);
    const receipt=await read('receipts/'+digest(op.key)+'.json');
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const rawBody=await bytes(receipt.rawPath),evidence=await read('evidence/'+op.profileId+'.json');
    const clue=evidence.videoPlan.resolutionQueue.find(c=>c.videoId===op.videoId);assert.ok(clue);
    let result;
    try{result=await read('results/'+digest(op.key)+'.json');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    saved.push({receipt,rawBody,artist:evidence.artist,clue,result});
  }
  const admission=validateRecoveryLedger({plan,approval,run,admissions,saved});
  assert.equal(summary.returnedCalls,admissions.filter(a=>a.status==='returned').length);
  const untouched=plan.operations.filter(o=>!admissions.some(a=>a.operation_key===o.key));
  for(const op of untouched){
    assert.ok(!ledger.admissions.some(a=>a.profile_id===op.profileId&&a.cm_artist===op.cmArtist&&a.video_id===op.videoId));
    for(const file of ['inputs/'+digest(op.key)+'.json','receipts/'+digest(op.key)+'.json',
      'receipts/'+digest(op.key)+'.raw','results/'+digest(op.key)+'.json']){
      try{await fs.access(path.join(sourceRoot,file));assert.fail('Unadmitted operation has local attempt evidence');}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  const s=saved.find(s=>s.receipt.operationKey===admission.operation_key);
  const mapped=mapSavedVideoUploader(s.artist,s.clue,{...s.receipt,rawBody:s.rawBody},
    {runId:plan.id,planSha256:digest(plan)});
  // No old runtime is copied over, edited or reinterpreted as a new approval.
  for(const [name,sha] of files)assert.equal(digest(await fs.readFile(path.join(sourceRoot,name))),sha);
  const mapperFiles={};
  for(const name of ['youtube-video-discovery-offline.mjs','youtube-video-uploader-review.mjs'])
    mapperFiles[name]=digest(await fs.readFile(new URL('./'+name,import.meta.url)));
  return {
    version:'single-saved-response-ledger-recovery-proposal-v1',
    preparedAt:new Date().toISOString(),sourceRunId:plan.id,sourcePlanSha256:digest(plan),
    sourceApprovalSha256:digest(approval),sourceFiles:Object.fromEntries(files),mapperFiles,ledger,
    pendingOperationKey:admission.operation_key,originalOwner:run.owner,
    originalReservedCents:Number(run.reserved_cents),priorStageReservedCents:plan.recovery?.previousReservedCents??0,
    returnedAdmissions:admissions.length-1,pendingAdmissions:1,untouchedOperations:untouched,
    proposedAcknowledgment:{runId:plan.id,operationKey:admission.operation_key,
      fromStatus:'admitted',toStatus:'returned',httpStatus:200,
      receiptSha256:digest(s.receipt),rawSha256:digest(s.rawBody)},
    savedReceipt:s.receipt,mappedSavedResponse:mapped,
    proposedLocalResult:{...mapped,profileId:s.artist.profileId,cmArtist:s.artist.cmArtist,
      artist:s.artist.name,tier:plan.artists.find(a=>a.profileId===s.artist.profileId).tier,
      videoUrl:s.clue.url,ownershipAccepted:false,recoveredWithoutReplay:true},
    allowedLedgerColumns:['status','http_status','receipt_sha256','raw_sha256'],
    sourceRunMustRemainStopped:true,noReservationChanges:true,noAcceptanceChanges:true,
    newProviderCalls:0,newReservationCents:0,catalogWrites:0,
    executable:false,explicitApproval:false,requiresSeparateRecoveryApproval:true,
    includesUntouchedDispatchApproval:false,includesNewFallbackStageApproval:false,
    requiresFreshLockedLedgerAndSourceRevalidation:true,
    warning:'Preparation only. Do not rerun the paid request. No database acknowledgment, result installation, campaign restart or new spending is authorized.',
  };
}

export async function prepareLedgerRecovery(sourceRoot,output,dependencies){
  assert.notEqual(path.resolve(output),path.resolve(sourceRoot));
  assert.ok(!path.resolve(output).startsWith(path.resolve(sourceRoot)+path.sep));
  const proposal=await buildLedgerRecovery(sourceRoot,dependencies);
  await fs.mkdir(output);
  await fs.writeFile(path.join(output,'recovery-proposal.json'),JSON.stringify(proposal,null,2),{flag:'wx'});
  const uploaderName=String(proposal.mappedSavedResponse.uploaderName)
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  await fs.writeFile(path.join(output,'review.html'),`<!doctype html><html lang="en"><meta charset="utf-8">
<title>YouTube saved-response recovery</title><style>body{font:17px/1.6 system-ui;max-width:780px;margin:48px auto;padding:0 24px;color:#153c38}h1{line-height:1.2}strong{color:#12665b}code{overflow-wrap:anywhere}</style>
<h1>YouTube saved-response recovery</h1>
<p><strong>Prepared only. No paid requests, record changes or restarts.</strong></p>
<h2>Why it stopped</h2><p>The saved response identified uploader ${uploaderName} using an accented handle. The older URL checker rejected its percent-encoded spelling. The video and uploader IDs agree; this is a parsing failure, not an artist match.</p>
<h2>Proposed recovery</h2><p>Record the one existing successful response as returned, using its exact saved receipt. Keep the original charge reservation, all other admissions and the stopped run unchanged. Do not repeat the request.</p>
<ul><li>${proposal.returnedAdmissions} earlier responses were already recorded.</li><li>1 saved response needs acknowledgment.</li><li>${proposal.untouchedOperations.length} requests remain untouched and are excluded from this recovery.</li><li>$${(proposal.originalReservedCents/100).toFixed(2)} reserved in this stopped stage; $${(proposal.priorStageReservedCents/100).toFixed(2)} in earlier stages. No reservation is refunded or reset.</li></ul>
<p>The uploader remains <strong>unaccepted</strong>. This plan does not approve the new eight-request fallback, channel ownership checks or catalog changes.</p>
<h2>Before applying</h2><p>Separate recovery approval and a fresh, locked check of the original evidence and ledger are required. This proposal is not executable.</p>
<p>Proposal fingerprint: <code>${digest(proposal)}</code></p></html>`,{flag:'wx'});
  return proposal;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,5);
  assert.equal(process.argv[2],'--prepare-only');
  const p=await prepareLedgerRecovery(process.argv[3],process.argv[4]);
  console.log(JSON.stringify({preparedOnly:true,returnedAdmissions:p.returnedAdmissions,
    savedPendingResponse:p.pendingAdmissions,untouchedRequests:p.untouchedOperations.length,
    originalReservedCents:p.originalReservedCents,priorStageReservedCents:p.priorStageReservedCents,
    proposedUploader:p.mappedSavedResponse.url,proposalSha256:digest(p),
    newProviderCalls:0,ledgerChanges:0,executable:false}));
}
