// Explicit integration check: all writes target connection-local TEMP tables.
// No provider transport and no persistent coordinator/schema changes.
import assert from 'node:assert/strict';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage} from './youtube-video-stage.mjs';
import {videoStageGate,videoStageSchema} from './youtube-video-stage-gate.mjs';
assert.deepEqual(process.argv.slice(2),['--temporary-tables-only']);
assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
const pool=await connectSavedBatchPool(),c=await pool.connect(),sha=digest('fixture');
try{
  const persistentBefore=(await c.query("SELECT to_regclass('public.youtube_video_stage_runs')::text r,to_regclass('public.youtube_video_stage_admissions')::text a")).rows[0];
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
  const persistentAfter=(await c.query("SELECT to_regclass('public.youtube_video_stage_runs')::text r,to_regclass('public.youtube_video_stage_admissions')::text a")).rows[0];
  assert.deepEqual(persistentAfter,persistentBefore);
  console.log(JSON.stringify({postgresTemporaryTableChecks:'passed',returnedFixtureAdmissions:40,
    fixtureReservationCents:80,paidCalls:0,persistentSchemaChanges:0}));
}finally{c.release(true);await pool.end();}
