// Opt-in isolated PostgreSQL checks. No provider or catalog access.
// node scripts/src/check-youtube-video-identity-postgres.mjs --temporary-tables-only
// node scripts/src/check-youtube-video-identity-postgres.mjs --disposable-schema-races
// Race mode needs CREATE SCHEMA permission in the development PostgreSQL database.
// It creates a UUID-named test schema, uses only its tables, and drops it in finally.
import assert from 'node:assert/strict';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {videoStageSchema} from './youtube-video-stage-gate.mjs';
import {videoIdentitySchema,videoIdentityGate} from './youtube-video-identity-gate.mjs';
import {identityExecutionFixture} from './youtube-video-identity-execution-fixture.mjs';
import {approveVideoIdentityPlan} from './youtube-video-identity-plan.mjs';
import {approveIdentityExecution,identityClaims} from './youtube-video-identity-execution.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
import {sourceFile,identityJson} from './youtube-video-identity-source.mjs';

const args=process.argv.slice(2);
assert.ok(args.length===1&&['--temporary-tables-only','--disposable-schema-races'].includes(args[0]),
  'Use --temporary-tables-only or --disposable-schema-races (creates and removes a test-only schema)');
assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
if(args[0]==='--disposable-schema-races'){
  const {checkIdentityPostgresRaces}=await import('./youtube-video-identity-postgres-races.mjs');
  await checkIdentityPostgresRaces();
}else{
const pool=await connectSavedBatchPool(),c=await pool.connect();
try{
  await c.query('SET search_path=pg_temp');
  await c.query(`CREATE TEMP TABLE youtube_link_campaigns(id text PRIMARY KEY,status text);
    CREATE TEMP TABLE youtube_discovery_test_runs(id text,status text);
    CREATE TEMP TABLE youtube_bounded_test_admissions(profile_id text,kind text,input_sha256 text,status text);
    CREATE TEMP TABLE youtube_link_campaign_admissions(profile_id text,kind text,input_sha256 text,status text);
    CREATE TEMP TABLE youtube_link_campaign_channels(campaign_id text,channel_id text,profile_id text);
    CREATE TEMP TABLE youtube_link_campaign_artists(campaign_id text,profile_id text,cm_artist text);
    CREATE TEMP TABLE youtube_discovery_test_results(profile_id text,cm_artist text,candidates_json jsonb);`);
  await c.query(videoStageSchema.replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE'));
  await c.query(videoIdentitySchema.replaceAll('CREATE TABLE IF NOT EXISTS','CREATE TEMP TABLE'));
  const tables=['youtube_link_campaigns','youtube_discovery_test_runs','youtube_bounded_test_admissions',
    'youtube_link_campaign_admissions','youtube_link_campaign_channels','youtube_link_campaign_artists',
    'youtube_discovery_test_results','youtube_video_stage_runs','youtube_video_stage_admissions',
    'youtube_video_identity_runs','youtube_video_identity_admissions','youtube_video_identity_claims'];
  for(const name of tables)assert.equal((await c.query(
    'SELECT to_regclass($1)::oid=to_regclass($2)::oid same',[name,'pg_temp.'+name])).rows[0].same,true);
  const isolated={query:(sql,args)=>{
    assert.notEqual(sql,videoIdentitySchema,'Schema installation is forbidden in this fixture');
    return c.query(sql,args);
  },connect:async()=>({query:(...args)=>c.query(...args),release:()=>{}})};
  // start() may request the schema; it has already been installed as TEMP.
  const adapter={...isolated,query:(sql,args)=>sql===videoIdentitySchema?Promise.resolve({rows:[]}):isolated.query(sql,args)};
  const f=identityExecutionFixture(),source=f.plan.source;
  const uploader=identityJson(sourceFile(source,'plan.json')),sourceApproval=identityJson(sourceFile(source,'approval.json'));
  await c.query("INSERT INTO youtube_link_campaigns VALUES($1,'stopped')",[f.manifest.parentId]);
  await c.query(`INSERT INTO youtube_video_stage_runs(id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status)
    VALUES($1,'fixture-source',$2,$3,80,80,'completed')`,[uploader.id,digest(uploader),digest(sourceApproval)]);
  for(const op of uploader.operations){
    const receipt=identityJson(sourceFile(source,'receipts/'+digest(op.key)+'.json'));
    await c.query(`INSERT INTO youtube_video_stage_admissions
      (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256,status,receipt_sha256,raw_sha256,http_status)
      VALUES($1,$2,$3,$4,$5,$6,'returned',$7,$8,200)`,
    [uploader.id,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256,digest(receipt),receipt.rawBodySha256]);
  }
  let catalogPass=true,catalogCalls=0;
  const gateFor=(fixture=f,owner='fixture-owner')=>videoIdentityGate({...fixture,pool:adapter,owner,
    checkCatalog:async()=>{catalogCalls++;assert.ok(catalogPass,'fixture catalog changed');}});
  const gate=gateFor(),wrong=gateFor(f,'wrong-owner'),op=f.plan.operations[0],hash=digest('fixture-bytes');
  await c.query("UPDATE youtube_link_campaigns SET status='running'");
  await assert.rejects(gate.start);
  await c.query("UPDATE youtube_link_campaigns SET status='stopped'");
  await c.query("UPDATE youtube_video_stage_runs SET status='stopped'");
  await assert.rejects(gate.start);
  await c.query("UPDATE youtube_video_stage_runs SET status='completed'");
  await c.query("UPDATE youtube_video_stage_admissions SET status='admitted' WHERE operation_key=$1",[uploader.operations[0].key]);
  await assert.rejects(gate.start);
  await c.query("UPDATE youtube_video_stage_admissions SET status='returned'");
  catalogPass=false;await assert.rejects(gate.start);catalogPass=true;
  const claim=identityClaims(f.plan)[0];
  await c.query('INSERT INTO youtube_discovery_test_results VALUES($1,$2,$3)',
    ['999','999',JSON.stringify([{url:claim.alias}])]);
  await assert.rejects(gate.start);
  await c.query('DELETE FROM youtube_discovery_test_results');
  await c.query('INSERT INTO youtube_link_campaign_channels VALUES($1,$2,$3)',['historical',claim.channelId,'999']);
  await assert.rejects(gate.start); // An unbound historical artist is not clearance.
  await c.query('DELETE FROM youtube_link_campaign_channels');
  await gate.start();
  await assert.rejects(gate.start);
  await assert.rejects(()=>wrong.admit(op));
  await assert.rejects(()=>gate.admit(f.plan.operations[1])); // Ordering.
  await assert.rejects(()=>gate.admit({...op,inputSha256:hash}));
  catalogPass=false;await assert.rejects(()=>gate.admit(op));catalogPass=true;
  assert.equal((await c.query('SELECT reserved_cents FROM youtube_video_identity_runs')).rows[0].reserved_cents,0);
  // A legacy exact request must be checked before reserving, regardless of status.
  await c.query('INSERT INTO youtube_bounded_test_admissions VALUES($1,$2,$3,$4)',
    [op.profileId,op.kind,op.inputSha256,'returned']);
  await assert.rejects(()=>gate.admit(op));
  await c.query('DELETE FROM youtube_bounded_test_admissions');
  await gate.admit(op);
  await assert.rejects(()=>gate.admit(f.plan.operations[1]));
  await assert.rejects(()=>gate.finish('completed'));
  await assert.rejects(()=>wrong.returned(op,hash,hash));
  await c.query("UPDATE youtube_link_campaigns SET status='running'");
  await assert.rejects(()=>gate.returned(op,hash,hash));
  await c.query("UPDATE youtube_link_campaigns SET status='stopped'");
  await gate.returned(op,hash,hash,[]);
  await assert.rejects(()=>gate.returned(op,hash,hash));
  await assert.rejects(()=>gate.admit(op));
  for(const next of f.plan.operations.slice(1)){
    await gate.admit(next);await gate.returned(next,hash,hash,[]);
  }
  await gate.finish('completed');
  assert.equal((await c.query('SELECT reserved_cents FROM youtube_video_identity_runs')).rows[0].reserved_cents,40);
  await assert.rejects(()=>gate.returned(op,hash,hash));
  function fresh(original,suffix){
    const plan={...original.plan,id:original.plan.id+'-'+suffix};
    const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:digest(plan),capCents:plan.maximumSpendCents,
      approvedAt:original.approval.approvedAt});
    const manifest={...original.manifest,id:plan.id,planSha256:digest(plan),approvalSha256:digest(approval)};
    const executionApproval=approveIdentityExecution(plan,approval,manifest,{planSha256:digest(plan),
      executionSha256:digest(manifest),capCents:plan.maximumSpendCents,approvedAt:original.executionApproval.approvedAt});
    return {plan,approval,manifest,executionApproval};
  }
  const again=fresh(f,'again'),another=gateFor(again);
  await another.start();await assert.rejects(()=>another.admit(again.plan.operations[0]));
  assert.equal((await c.query('SELECT reserved_cents FROM youtube_video_identity_runs WHERE id=$1',
    [again.plan.id])).rows[0].reserved_cents,0);
  await another.finish('stopped');
  // Isolate the independent admission exclusions from the separate claim
  // safety check, using only disposable fixture rows.
  await c.query('DELETE FROM youtube_video_identity_claims');
  const variants=[
    {name:'same-profile-new-artist-new-channel',cmOffset:1000,channelOffset:1000,field:'profileId'},
    {name:'same-artist-new-profile-new-channel',profileOffset:2000,channelOffset:2000,field:'cmArtist'},
    {name:'same-channel-new-profile-new-artist',profileOffset:3000,cmOffset:3000,field:'channelId'},
  ];
  for(const variant of variants){
    const next=identityExecutionFixture(variant),first=next.plan.operations[0];
    assert.equal(first[variant.field],op[variant.field]);
    for(const field of ['profileId','cmArtist','channelId'].filter(x=>x!==variant.field))
      assert.notEqual(first[field],op[field]);
    if(variant.field!=='channelId')assert.notEqual(first.inputSha256,op.inputSha256,'Changed request must still be excluded');
    const nextSource=next.plan.source,nextUploader=identityJson(sourceFile(nextSource,'plan.json'));
    const nextApproval=identityJson(sourceFile(nextSource,'approval.json'));
    await c.query(`INSERT INTO youtube_video_stage_runs(id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status)
      VALUES($1,'fixture-source',$2,$3,80,80,'completed')`,[nextUploader.id,digest(nextUploader),digest(nextApproval)]);
    for(const u of nextUploader.operations){
      const receipt=identityJson(sourceFile(nextSource,'receipts/'+digest(u.key)+'.json'));
      await c.query(`INSERT INTO youtube_video_stage_admissions
        (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256,status,receipt_sha256,raw_sha256,http_status)
        VALUES($1,$2,$3,$4,$5,$6,'returned',$7,$8,200)`,
      [nextUploader.id,u.key,u.profileId,u.cmArtist,u.videoId,u.inputSha256,digest(receipt),receipt.rawBodySha256]);
    }
    const nextGate=gateFor(next);
    await nextGate.start();
    await assert.rejects(()=>nextGate.admit(first),/Globally non-replayable profile, Chartmetric artist or channel/);
    assert.equal((await c.query('SELECT reserved_cents FROM youtube_video_identity_runs WHERE id=$1',
      [next.plan.id])).rows[0].reserved_cents,0);
    // The independent SQL indexes must reject it even without the gate query.
    await assert.rejects(()=>c.query(`INSERT INTO youtube_video_identity_admissions
      (run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,reserved_cents)
      VALUES($1,$2,$3,$4,$5,$6,$7,2)`,
    [next.plan.id,first.key,first.profileId,first.cmArtist,first.channelId,first.kind,first.inputSha256]),
    error=>error.code==='23505');
    await nextGate.finish('stopped');
    await c.query('DELETE FROM youtube_video_identity_claims');
  }
  // A new shared captured handle preserves the paid admission as uncertain.
  await c.query(`INSERT INTO youtube_video_identity_claims VALUES($1,$2,$3,$4)`,
    ['https://www.youtube.com/@outside','UC'+''.padStart(22,'9'),'999','999']);
  // New model stage is separate; original local captures alone do not prove a
  // coordinator acknowledgment. Seed the exact matching immutable receipts.
  const m=identityExecutionFixture({model:true});
  await assert.rejects(gateFor(m).start);
  for(const saved of m.plan.captureReturns.receipts){
    const bytes=Buffer.from(saved.receiptBytesBase64,'base64'),r=identityJson(bytes);
    await c.query('UPDATE youtube_video_identity_admissions SET receipt_sha256=$3,raw_sha256=$4 WHERE run_id=$1 AND operation_key=$2',
      [f.plan.id,r.operationKey,digest(bytes),r.rawBodySha256]);
  }
  const modelGate=gateFor(m);
  await modelGate.start();await modelGate.admit(m.plan.operations[0]);
  await assert.rejects(()=>modelGate.returned(m.plan.operations[0],hash,hash,[{
    alias:'https://www.youtube.com/@outside',channelId:m.plan.operations[0].channelId,
    profileId:m.plan.operations[0].profileId,cmArtist:m.plan.operations[0].cmArtist}]));
  await modelGate.finish('stopped'); // Keep its uncertain reservation.
  const after=fresh(m,'uncertain');
  await assert.rejects(gateFor(after).start);
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE status='admitted'")).rows[0].n,1);
  assert.ok(catalogCalls>20);
  console.log(JSON.stringify({temporaryPostgresChecks:'passed',captureReservationsCents:40,
    independentChangedInputReplayChecks:variants.length,uncertainModelReservationCents:2,
    paidCalls:0,catalogWrites:0,persistentSchemaChanges:0}));
}finally{c.release(true);await pool.end();}
}
