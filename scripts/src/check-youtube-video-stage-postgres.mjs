// Explicit integration check: all writes target connection-local TEMP tables.
// No provider transport and no persistent coordinator/schema changes.
import assert from 'node:assert/strict';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage} from './youtube-video-stage.mjs';
import {videoStageGate,videoStageSchema} from './youtube-video-stage-gate.mjs';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {reconcileSavedVideoResponse} from './youtube-video-stage-recovery.mjs';
assert.deepEqual(process.argv.slice(2),['--temporary-tables-only']);
assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
const pool=await connectSavedBatchPool(),c=await pool.connect(),sha=digest('fixture'),scratch=[];
try{
  const persistentBefore=(await c.query("SELECT to_regclass('public.youtube_video_stage_runs')::oid r,to_regclass('public.youtube_video_stage_admissions')::oid a")).rows[0];
  await c.query('BEGIN');
  await c.query(`CREATE TEMP TABLE youtube_link_campaigns(id text,status text);
    CREATE TEMP TABLE youtube_discovery_test_runs(status text);
    CREATE TEMP TABLE youtube_bounded_test_admissions(status text);`);
  await c.query(videoStageSchema.replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE'));
  await c.query('INSERT INTO pg_temp.youtube_link_campaigns VALUES($1,$2)',['full-tiers-1-5-no-youtube-uncapped','stopped']);
  await c.query('COMMIT');
  for(const table of ['youtube_link_campaigns','youtube_discovery_test_runs','youtube_bounded_test_admissions',
    'youtube_video_stage_runs','youtube_video_stage_admissions']){
    const row=(await c.query('SELECT to_regclass($1)::oid=to_regclass($2)::oid same',
      [table,'pg_temp.'+table])).rows[0];
    assert.equal(row.same,true,'Never run the fixture against a persistent table');
  }
  const artists=Array.from({length:20},(_,i)=>({profileId:String(i+1),cmArtist:String(i+101),
    name:'Fixture '+i,tier:2,snapshotAt:'2026-11-12T01:30:00Z'}));
  const operations=artists.flatMap(a=>[0,1].map(j=>{
    const videoId=String(Number(a.profileId)*2+j).padStart(11,'0'),videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {...a,kind:'video_uploader',key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,
      videoId,videoUrl,request:proposedUploaderRequest(videoUrl)};
  }));
  const plan=videoStagePlan({id:'youtube-video-review-postgres-fixture',sourceRunId:'fixture',sourcePlanSha256:sha,
    preparedAt:'2026-11-12T06:00:00Z',artists,operations,evidenceFiles:{'evidence/test.json':sha},runtimeFiles:{'runtime/test.mjs':sha}});
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:80,approvedAt:'2026-11-12T06:01:00Z'});
  // Schema was created as TEMP above. Never allow the live schema-creation statement here.
  const isolated={query:(sql,args)=>sql===videoStageSchema?Promise.resolve({rows:[]}):c.query(sql,args),
    connect:async()=>({query:(...args)=>c.query(...args),release:()=>{}})};
  const gate=videoStageGate({pool:isolated,plan,approval,owner:'fixture-owner'});
  await gate.start();
  const other=videoStageGate({pool:isolated,plan,approval,owner:'wrong-owner'});
  await assert.rejects(()=>other.admit(plan.operations[0]));
  await gate.admit(plan.operations[0]);
  await assert.rejects(()=>gate.admit(plan.operations[1])); // Pending response fences the next request.
  await assert.rejects(()=>gate.finish('completed'));
  await gate.returned(plan.operations[0],sha,sha);
  await assert.rejects(()=>gate.admit(plan.operations[0])); // Never replay.
  for(const op of plan.operations.slice(1)){await gate.admit(op);await gate.returned(op,sha,sha);}
  await gate.finish('completed');
  assert.deepEqual((await c.query('SELECT status,reserved_cents FROM pg_temp.youtube_video_stage_runs')).rows,
    [{status:'completed',reserved_cents:80}]);
  assert.equal((await c.query("SELECT count(*)::int n FROM pg_temp.youtube_video_stage_admissions WHERE status='returned'")).rows[0].n,40);
  await assert.rejects(()=>gate.returned(plan.operations[0],sha,sha));
  const next=videoStagePlan({...plan,id:'youtube-video-review-postgres-fixture-again'});
  const nextApproval=approveVideoStage(next,{expectedPlanSha256:digest(next),capCents:80,approvedAt:approval.approvedAt});
  const nextGate=videoStageGate({pool:isolated,plan:next,approval:nextApproval,owner:'another-owner'});
  await nextGate.start();
  await assert.rejects(()=>nextGate.admit(next.operations[0])); // Global artist/video uniqueness.
  assert.equal((await c.query('SELECT reserved_cents FROM pg_temp.youtube_video_stage_runs WHERE id=$1',[next.id])).rows[0].reserved_cents,0);
  await nextGate.finish('stopped');
  // Recovery test uses synthetic files and TEMP rows, never the real stopped run.
  const recoveryId='youtube-video-review-pg-recovery-'+randomUUID().slice(0,8);
  const recoveryArtists=artists.map(a=>({...a,profileId:String(Number(a.profileId)+1000),cmArtist:String(Number(a.cmArtist)+1000)}));
  const recoveryOps=operations.map((o,i)=>{
    const a=recoveryArtists[Math.floor(i/2)],videoId=String(i+10000).padStart(11,'0'),videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {...a,kind:'video_uploader',key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,
      videoId,videoUrl,request:proposedUploaderRequest(videoUrl)};
  });
  const previousPlan=videoStagePlan({...plan,id:recoveryId,artists:recoveryArtists,operations:recoveryOps});
  const previousApproval=approveVideoStage(previousPlan,{expectedPlanSha256:digest(previousPlan),capCents:80,approvedAt:approval.approvedAt});
  const op=previousPlan.operations[0],artist=previousPlan.artists[0];
  const clue={...op,url:op.videoUrl,sources:[],operation:{kind:op.kind,key:op.key,request:op.request}};
  const raw=Buffer.from(JSON.stringify({success:true,credits_charged:1,id:op.videoId,
    channel:{id:'UC'+''.padStart(22,'1'),url:'https://www.youtube.com/channel/UC'+''.padStart(22,'1'),title:artist.name}}));
  const receipt={runId:previousPlan.id,planSha256:digest(previousPlan),profileId:op.profileId,cmArtist:op.cmArtist,
    videoId:op.videoId,operationKey:op.key,kind:op.kind,request:op.request,inputSha256:op.inputSha256,status:200,
    rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw),capturedAt:previousPlan.preparedAt};
  const mapped=mapSavedVideoUploader(artist,clue,{...receipt,rawBody:raw},{runId:previousPlan.id,planSha256:digest(previousPlan)});
  const recoveryEvidence={previousPlan,previousApproval,receipt,mapped,rawBodyBase64:raw.toString('base64'),
    artistEvidence:{artist,videoPlan:{resolutionQueue:[clue]}}};
  const bytes=JSON.stringify(recoveryEvidence);
  const recoveryPlan=videoStagePlan({...previousPlan,id:recoveryId+'-next',operations:previousPlan.operations.slice(1),
    evidenceFiles:{'evidence/recovery.json':digest(bytes)},recovery:{previousRunId:recoveryId,previousPlanSha256:digest(previousPlan),
      previousApprovalSha256:digest(previousApproval),previousOwner:'recovery-owner',completedOperationKey:op.key,
      previousReservedCents:2,originalMaximumCents:80,rawSha256:digest(raw),receiptSha256:digest(receipt),mappedSha256:digest(mapped)}});
  const recoveryApproval=approveVideoStage(recoveryPlan,{expectedPlanSha256:digest(recoveryPlan),capCents:78,approvedAt:approval.approvedAt});
  const oldRoot='generated-artifacts/'+recoveryId,currentRoot=oldRoot+'/next';
  await fs.mkdir(oldRoot);scratch.push(oldRoot);
  await fs.mkdir(oldRoot+'/receipts');await fs.mkdir(currentRoot);await fs.mkdir(currentRoot+'/evidence');
  await fs.writeFile(oldRoot+'/plan.json',JSON.stringify(previousPlan),{flag:'wx'});
  await fs.writeFile(oldRoot+'/approval.json',JSON.stringify(previousApproval),{flag:'wx'});
  await fs.writeFile(oldRoot+'/'+receipt.rawPath,raw,{flag:'wx'});
  await fs.writeFile(oldRoot+'/receipts/'+digest(op.key)+'.json',JSON.stringify(receipt),{flag:'wx'});
  await fs.writeFile(currentRoot+'/evidence/recovery.json',bytes,{flag:'wx'});
  await c.query(`INSERT INTO pg_temp.youtube_video_stage_runs
    (id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status) VALUES($1,$2,$3,$4,80,2,'stopped')`,
  [recoveryId,'recovery-owner',digest(previousPlan),digest(previousApproval)]);
  await c.query(`INSERT INTO pg_temp.youtube_video_stage_admissions
    (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256) VALUES($1,$2,$3,$4,$5,$6)`,
  [recoveryId,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256]);
  const recoveryArgs={pool:isolated,plan:recoveryPlan,approval:recoveryApproval,root:currentRoot};
  await assert.rejects(()=>reconcileSavedVideoResponse({...recoveryArgs,approval:{...recoveryApproval,savedResponseRecoveryApproved:false}}));
  await c.query('UPDATE pg_temp.youtube_video_stage_runs SET owner=$2 WHERE id=$1',[recoveryId,'lost-owner']);
  await assert.rejects(()=>reconcileSavedVideoResponse(recoveryArgs));
  await c.query('UPDATE pg_temp.youtube_video_stage_runs SET owner=$2 WHERE id=$1',[recoveryId,'recovery-owner']);
  assert.equal((await c.query('SELECT status FROM pg_temp.youtube_video_stage_admissions WHERE run_id=$1',[recoveryId])).rows[0].status,'admitted');
  await reconcileSavedVideoResponse(recoveryArgs);
  await reconcileSavedVideoResponse(recoveryArgs); // Idempotent acknowledgment, never another paid request.
  const continuation=videoStageGate({pool:isolated,plan:recoveryPlan,approval:recoveryApproval,owner:'continuation-owner'});
  await continuation.start();
  for(const remaining of recoveryPlan.operations){await continuation.admit(remaining);await continuation.returned(remaining,sha,sha);}
  await continuation.finish('completed');
  assert.equal((await c.query('SELECT sum(reserved_cents)::int n FROM pg_temp.youtube_video_stage_runs WHERE id=$1 OR id=$2',
    [previousPlan.id,recoveryPlan.id])).rows[0].n,80);
  const persistentAfter=(await c.query("SELECT to_regclass('public.youtube_video_stage_runs')::oid r,to_regclass('public.youtube_video_stage_admissions')::oid a")).rows[0];
  assert.deepEqual(persistentAfter,persistentBefore);
  console.log(JSON.stringify({postgresTemporaryTableChecks:'passed',returnedFixtureAdmissions:40,
    fixtureReservationCents:80,savedResponseRecoveryChecks:'passed',combinedRecoveryReservationCents:80,paidCalls:0,persistentSchemaChanges:0}));
}finally{for(const dir of scratch)await fs.rm(dir,{recursive:true,force:true});c.release(true);await pool.end();}
