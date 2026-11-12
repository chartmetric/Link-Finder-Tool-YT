// Read-only preparation. Never authorizes, acknowledges or dispatches paid work.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {buildSavedFallback} from './prepare-youtube-saved-fallback.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
import {archivedSearchReceiptName,VIDEO_PARENT} from './youtube-video-stage.mjs';

export async function inspectFallback({sourceRoot,eligibleFor=currentEligible,connect=connectSavedBatchPool}){
  const proposal=await buildSavedFallback(sourceRoot);
  const cases=proposal.cases.filter(c=>c.resolutionQueue.length);
  const artists=cases.map(c=>({profileId:c.profileId,cmArtist:c.cmArtist,name:c.artist}));
  const eligible=await eligibleFor(artists),pool=await connect();
  const client=await pool.connect();
  let coordinator;
  try{
    // One read-only snapshot; no schema creation or admission acknowledgments.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows=async(sql,params=[]) => (await client.query(sql,params)).rows;
    coordinator={
      campaign:await rows('SELECT id,status FROM youtube_link_campaigns WHERE id=$1',[VIDEO_PARENT]),
      activeTests:await rows("SELECT id,status FROM youtube_discovery_test_runs WHERE status='running'"),
      pendingTests:await rows("SELECT run_id,operation_key FROM youtube_bounded_test_admissions WHERE status='admitted'"),
      activeStages:await rows("SELECT id,status FROM youtube_video_stage_runs WHERE status='running'"),
      pendingStages:await rows("SELECT run_id,operation_key,profile_id,cm_artist,video_id FROM youtube_video_stage_admissions WHERE status='admitted'"),
      duplicates:await rows(`SELECT run_id,operation_key,profile_id,cm_artist,video_id,status
        FROM youtube_video_stage_admissions WHERE operation_key=ANY($1::text[])`,
      [proposal.operations.map(o=>o.key)]),
      sourceReceipts:await rows(`SELECT operation_key,profile_id,input_sha256,receipt_sha256,status,http_status
        FROM youtube_bounded_test_admissions WHERE run_id=$1 AND kind='search'`,[proposal.sourceRunId]),
    };
    for(const c of cases){
      const receipt=JSON.parse(await fs.readFile(path.join(sourceRoot,'receipts',archivedSearchReceiptName(c.profileId))));
      const admitted=coordinator.sourceReceipts.filter(r=>r.operation_key===receipt.operationKey&&r.profile_id===c.profileId);
      assert.equal(admitted.length,1,'Exactly one acknowledged source search required');
      assert.equal(admitted[0].status,'returned');assert.equal(admitted[0].http_status,200);
      assert.equal(admitted[0].input_sha256,receipt.inputSha256);
      assert.equal(admitted[0].receipt_sha256,digest(receipt));
    }
    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK');throw error;
  }finally{client.release();await pool.end();}
  // Detect evidence changes during the catalog/coordinator read.
  for(const [file,sha] of Object.entries(proposal.sourceFiles))
    assert.equal(digest(await fs.readFile(path.join(sourceRoot,file))),sha);
  const blockers=[];
  if(artists.some(a=>!eligible.has(a.profileId)))blockers.push('artist_eligibility_changed');
  if(coordinator.campaign.length!==1||coordinator.campaign[0].status!=='stopped')blockers.push('full_campaign_not_paused');
  for(const key of ['activeTests','pendingTests','activeStages','pendingStages','duplicates'])
    if(coordinator[key].length)blockers.push(key);
  return {
    version:'saved-video-uploader-preflight-v1',checkedAt:new Date().toISOString(),
    status:blockers.length?'blocked_before_execution_preparation':'requires_sealed_execution_plan',
    sourceRunId:proposal.sourceRunId,sourcePlanSha256:proposal.sourcePlanSha256,
    sourceFiles:proposal.sourceFiles,artists:artists.map(a=>eligible.get(a.profileId)??a),
    operations:proposal.operations,maximumCalls:proposal.operations.length,
    maximumReservationCents:proposal.operations.length*2,blockers,coordinator,
    executable:false,explicitApproval:false,paidCalls:0,catalogWrites:0,
    previousAdmissionsChanged:0,requiresNewSealedExecutionPlan:true,
    requiresFreshEligibilityAndCoordinatorCheck:true,requiresSeparateSpendingApproval:true,
    requiresSeparateIdentityApproval:true,
    warning:'Readiness snapshot and frozen request manifest only. Not an executable stage or authority to spend. Never clear or replay an old admission to make this plan runnable.',
  };
}

export async function prepareFallbackPreflight(sourceRoot,output,dependencies={}){
  assert.notEqual(path.resolve(output),path.resolve(sourceRoot));
  assert.ok(!path.resolve(output).startsWith(path.resolve(sourceRoot)+path.sep));
  const result=await inspectFallback({sourceRoot,...dependencies});
  await fs.mkdir(output); // Refuse replacement of any previous preparation.
  await fs.writeFile(path.join(output,'preflight.json'),JSON.stringify(result,null,2),{flag:'wx'});
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=result.operations.map(o=>[
    result.artists.find(a=>a.profileId===o.profileId).name,o.profileId,o.cmArtist,o.videoUrl,
    o.request.method,o.request.url,digest(o.request),2,'Not checked — discovery only',
  ]);
  await fs.writeFile(path.join(output,'proposed-uploader-checks.csv'),'\ufeff'+[
    ['artist','profile_id','cm_artist','video_url','method','request_url','request_sha256','reservation_cents','ownership_status'],
    ...rows,
  ].map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  await fs.writeFile(path.join(output,'readiness.md'),[
    '# YouTube uploader-check preparation','',
    `Prepared ${result.maximumCalls} exact video requests for ${result.artists.length} artists.`,
    `Proposed uploader-only ceiling: $${(result.maximumReservationCents/100).toFixed(2)}.`,
    `Status: ${result.status}.`,
    `Blocking checks: ${result.blockers.join(', ')||'none at this snapshot'}.`,'',
    'No paid calls, catalog writes, old admission changes or spending approval.',
    'An older unacknowledged request must be reviewed separately; it must not be retried.',
    'A sealed executor, refreshed checks and exact spending approval are still required.',
    'Uploader discovery does not establish artist ownership or confirm a Topic channel.',
    `Request-manifest SHA-256: ${digest(result)}`,
  ].join('\n'),{flag:'wx'});
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,4,'Supply completed source archive and NEW output directory');
  const result=await prepareFallbackPreflight(process.argv[2],process.argv[3]);
  console.log(JSON.stringify({status:result.status,artists:result.artists.length,
    maximumCalls:result.maximumCalls,maximumReservationCents:result.maximumReservationCents,
    blockers:result.blockers,paidCalls:0,executable:false}));
}
