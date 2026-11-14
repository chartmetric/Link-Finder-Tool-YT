// Invoked only by check-youtube-video-identity-postgres.mjs --disposable-schema-races.
// Real locks, synthetic evidence, two pinned connections, no live table fallback.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {videoStageSchema} from './youtube-video-stage-gate.mjs';
import {videoIdentitySchema,videoIdentityGate} from './youtube-video-identity-gate.mjs';
import {identityExecutionFixture} from './youtube-video-identity-execution-fixture.mjs';
import {approveVideoIdentityPlan} from './youtube-video-identity-plan.mjs';
import {approveIdentityExecution,identityClaims} from './youtube-video-identity-execution.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
import {sourceFile,identityJson} from './youtube-video-identity-source.mjs';

const tables=['youtube_link_campaigns','youtube_discovery_test_runs','youtube_bounded_test_admissions',
  'youtube_link_campaign_admissions','youtube_link_campaign_channels','youtube_link_campaign_artists',
  'youtube_discovery_test_results','youtube_video_stage_runs','youtube_video_stage_admissions',
  'youtube_video_identity_runs','youtube_video_identity_admissions','youtube_video_identity_claims'];
const parentLock='SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE';
const hash=digest('race-fixture-bytes');
const deferred=()=>{
  let resolve;
  const promise=new Promise(r=>{resolve=r;});
  return {promise,resolve};
};
function assertAccepted(result){assert.equal(result.ok,true,result.error?.message);}
function assertRejected(result,pattern){
  assert.equal(result.ok,false,'Expected the competing transaction to be rejected');
  assert.match(result.error.message,pattern);
}
function fresh(f,suffix){
  const plan={...f.plan,id:f.plan.id+'-'+suffix};
  const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:digest(plan),capCents:plan.maximumSpendCents,
    approvedAt:f.approval.approvedAt});
  const manifest={...f.manifest,id:plan.id,planSha256:digest(plan),approvalSha256:digest(approval)};
  const executionApproval=approveIdentityExecution(plan,approval,manifest,{planSha256:digest(plan),
    executionSha256:digest(manifest),capCents:plan.maximumSpendCents,approvedAt:f.executionApproval.approvedAt});
  return {plan,approval,manifest,executionApproval};
}

export async function checkIdentityPostgresRaces(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const schema='test_youtube_identity_race_'+randomUUID().replaceAll('-','');
  assert.match(schema,/^test_youtube_identity_race_[a-f0-9]{32}$/);
  const pool=await connectSavedBatchPool(),clients=[],pauses=[],inFlight=[];
  const settled=promise=>{
    const result=promise.then(value=>({ok:true,value}),error=>({ok:false,error}));
    inFlight.push(result);return result;
  };
  let created=false,providerDispatchAttempts=0,races=0;
  // These gate checks have no provider transport. Also catch accidental fetches
  // if a later gate change introduces one, before any request can leave.
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{providerDispatchAttempts++;throw Error('Provider dispatch forbidden in race fixture');};
  try{
    clients.push(await pool.connect());
    clients.push(await pool.connect());
    const [a,b]=clients;
    const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));
    assert.notEqual(pids[0],pids[1],'Two independent PostgreSQL sessions are required');
    // No public/pg_temp search path: a missing fixture table must fail closed.
    await a.query(`CREATE SCHEMA "${schema}"`);created=true;
    for(const c of clients){
      await c.query(`SET search_path="${schema}"`);
      await c.query("SET statement_timeout='15s'; SET lock_timeout='10s'; SET idle_in_transaction_session_timeout='30s'");
    }
    await a.query(`CREATE TABLE youtube_link_campaigns(id text PRIMARY KEY,status text);
      CREATE TABLE youtube_discovery_test_runs(id text,status text);
      CREATE TABLE youtube_bounded_test_admissions(profile_id text,kind text,input_sha256 text,status text);
      CREATE TABLE youtube_link_campaign_admissions(profile_id text,kind text,input_sha256 text,status text);
      CREATE TABLE youtube_link_campaign_channels(campaign_id text,channel_id text,profile_id text);
      CREATE TABLE youtube_link_campaign_artists(campaign_id text,profile_id text,cm_artist text);
      CREATE TABLE youtube_discovery_test_results(profile_id text,cm_artist text,candidates_json jsonb);`);
    await a.query(videoStageSchema);await a.query(videoIdentitySchema);
    for(const c of clients)for(const name of tables){
      const row=(await c.query(`SELECT to_regclass($1)::oid=to_regclass($2)::oid same,
        (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
          WHERE t.oid=to_regclass($1)) namespace`,[name,schema+'.'+name])).rows[0];
      assert.equal(row.same,true,'Fixture must not resolve to a live campaign table');
      assert.equal(row.namespace,schema);
    }
    const f=identityExecutionFixture(),op=f.plan.operations[0];
    async function reset(){
      await a.query('TRUNCATE '+tables.join(','));
      const source=f.plan.source,uploader=identityJson(sourceFile(source,'plan.json'));
      const approval=identityJson(sourceFile(source,'approval.json'));
      await a.query("INSERT INTO youtube_link_campaigns VALUES($1,'stopped')",[f.manifest.parentId]);
      await a.query(`INSERT INTO youtube_video_stage_runs
        (id,owner,plan_sha256,approval_sha256,cap_cents,reserved_cents,status)
        VALUES($1,'fixture-source',$2,$3,80,80,'completed')`,[uploader.id,digest(uploader),digest(approval)]);
      for(const u of uploader.operations){
        const receipt=identityJson(sourceFile(source,'receipts/'+digest(u.key)+'.json'));
        await a.query(`INSERT INTO youtube_video_stage_admissions
          (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256,status,receipt_sha256,raw_sha256,http_status)
          VALUES($1,$2,$3,$4,$5,$6,'returned',$7,$8,200)`,
        [uploader.id,u.key,u.profileId,u.cmArtist,u.videoId,u.inputSha256,digest(receipt),receipt.rawBodySha256]);
      }
    }
    function gate(c,fixture=f,owner='fixture-owner',pause=false){
      const reached=deferred(),resume=deferred();
      let waiting=pause;
      if(pause)pauses.push(resume);
      const query=async(sql,args)=>{
        const result=await c.query(sql,args);
        if(waiting&&sql===parentLock){
          waiting=false;reached.resolve();await resume.promise;
        }
        return result;
      };
      const adapter={
        query:(sql,args)=>{
          assert.equal(sql,videoIdentitySchema,'Only preinstalled schema requests are allowed outside a transaction');
          return Promise.resolve({rows:[]});
        },
        connect:async()=>({query,release:()=>{}}),
      };
      return {gate:videoIdentityGate({...fixture,pool:adapter,owner,checkCatalog:async()=>{}}),
        reached:reached.promise,resume:resume.resolve};
    }
    async function blocked(holder,waiter){
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const blockers=(await clients[holder].query('SELECT pg_blocking_pids($1) blockers',[pids[waiter]])).rows[0].blockers;
        if(blockers.includes(pids[holder]))return;
        await delay(10);
      }
      assert.fail('Contender did not block on the other PostgreSQL connection');
    }
    async function pauseReached(held,result){
      // Do not hang if the first operation fails before reaching the barrier.
      let timer;
      try{
        await Promise.race([held.reached,result.then(r=>{
          assertAccepted(r);assert.fail('Operation finished without taking the expected parent lock');
        }),new Promise((_,reject)=>{
          timer=setTimeout(()=>reject(Error('Timed out awaiting parent lock barrier')),5000);
        })]);
      }finally{clearTimeout(timer);}
    }
    async function rowState(c){
      return {
        runs:(await c.query('SELECT id,owner,status,reserved_cents FROM youtube_video_identity_runs ORDER BY id')).rows,
        admissions:(await c.query(`SELECT run_id,operation_key,status,reserved_cents,receipt_sha256,raw_sha256,http_status
          FROM youtube_video_identity_admissions ORDER BY run_id,operation_key`)).rows,
      };
    }
    async function exactReservation(c,cents,status){
      const state=await rowState(c);
      assert.equal(state.runs.length,1);
      assert.equal(state.runs[0].reserved_cents,cents);
      assert.equal(state.admissions.length,cents/2);
      if(cents){
        assert.deepEqual(state.admissions,[{run_id:f.plan.id,operation_key:op.key,status,reserved_cents:2,
          receipt_sha256:status==='returned'?hash:null,raw_sha256:status==='returned'?hash:null,
          http_status:status==='returned'?200:null}]);
      }
      assert.equal(state.runs.reduce((n,r)=>n+r.reserved_cents,0),
        state.admissions.reduce((n,r)=>n+r.reserved_cents,0));
      return state;
    }
    async function durableUncertainty(c,owner){
      const before=await exactReservation(c,2,'admitted');
      const g=gate(c,f,owner).gate;
      await assert.rejects(()=>g.admit(op),/Uncertain prior admission/);
      await g.finish('stopped');
      await assert.rejects(gate(c,fresh(f,'uncertain-relaunch'),'relaunch-owner').gate.start,
        /Uncertain prior admission/);
      const after=await rowState(c);
      assert.deepEqual(after.admissions,before.admissions,'Ownership/stop/relaunch cannot clear an uncertain receipt');
      assert.equal(after.runs[0].reserved_cents,2);
    }

    // Race both the same run ID and different run IDs. Reverse which connection
    // reaches the parent lock first; each result must be independent of scheduling.
    for(const distinct of [false,true])for(const first of [0,1]){
      await reset();
      const second=1-first,other=distinct?fresh(f,'competing-start'):f;
      const held=gate(clients[first],f,'winner-owner',true);
      const winner=settled(held.gate.start());await pauseReached(held,winner);
      const loser=settled(gate(clients[second],other,'loser-owner').gate.start());
      try{await blocked(first,second);}finally{held.resume();}
      assertAccepted(await winner);assertRejected(await loser,/1 !== 0/);
      const state=await exactReservation(clients[second],0);
      assert.deepEqual(state.runs,[{id:f.plan.id,owner:'winner-owner',status:'running',reserved_cents:0}]);
      const claims=(await a.query(`SELECT alias,channel_id AS "channelId",profile_id AS "profileId",
        cm_artist AS "cmArtist" FROM youtube_video_identity_claims`)).rows;
      const sort=values=>values.sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y)));
      assert.deepEqual(sort(claims),sort(identityClaims(f.plan)),'Losing start must not leave claims behind');
      races++;
    }
    // Two admissions of the same approved request may reserve only once.
    for(const first of [0,1]){
      await reset();await gate(a).gate.start();
      const second=1-first,held=gate(clients[first],f,'fixture-owner',true);
      const winner=settled(held.gate.admit(op));await pauseReached(held,winner);
      const loser=settled(gate(clients[second]).gate.admit(op));
      try{await blocked(first,second);}finally{held.resume();}
      assertAccepted(await winner);assertRejected(await loser,/Uncertain prior admission/);
      await durableUncertainty(clients[second],'fixture-owner');races++;
    }
    // Parent resume wins: admission sees the committed new state and reserves
    // nothing. Admission wins: the later parent resume cannot refund its ledger.
    for(const mutationFirst of [true,false]){
      await reset();await gate(a).gate.start();
      if(mutationFirst){
        await a.query('BEGIN');await a.query(parentLock,[f.manifest.parentId]);
        await a.query("UPDATE youtube_link_campaigns SET status='running' WHERE id=$1",[f.manifest.parentId]);
        const admission=settled(gate(b).gate.admit(op));
        try{await blocked(0,1);}finally{await a.query('COMMIT');}
        assertRejected(await admission,/Parent campaign must remain stopped/);
        await exactReservation(b,0);
      }else{
        const held=gate(a,f,'fixture-owner',true),admission=settled(held.gate.admit(op));
        await pauseReached(held,admission);
        const mutation=settled(b.query("UPDATE youtube_link_campaigns SET status='running' WHERE id=$1",
          [f.manifest.parentId]));
        try{await blocked(0,1);}finally{held.resume();}
        assertAccepted(await admission);assertAccepted(await mutation);
        await exactReservation(b,2,'admitted');
        await assert.rejects(()=>gate(b).gate.returned(op,hash,hash),/Parent campaign must remain stopped/);
        await b.query("UPDATE youtube_link_campaigns SET status='stopped' WHERE id=$1",[f.manifest.parentId]);
        await durableUncertainty(b,'fixture-owner');
      }
      races++;
    }
    // A coordinated owner change takes the same parent lock as the gate. If it
    // wins, the old response cannot be acknowledged. If acknowledgment wins, the
    // exact returned receipt survives the subsequent owner change unchanged.
    for(const mutationFirst of [true,false]){
      await reset();await gate(a).gate.start();await gate(a).gate.admit(op);
      if(mutationFirst){
        await a.query('BEGIN');await a.query(parentLock,[f.manifest.parentId]);
        await a.query('UPDATE youtube_video_identity_runs SET owner=$2 WHERE id=$1',[f.plan.id,'replacement-owner']);
        const acknowledgment=settled(gate(b).gate.returned(op,hash,hash));
        try{await blocked(0,1);}finally{await a.query('COMMIT');}
        assertRejected(await acknowledgment,/Lost identity owner/);
        await durableUncertainty(b,'replacement-owner');
      }else{
        const held=gate(a,f,'fixture-owner',true),acknowledgment=settled(held.gate.returned(op,hash,hash));
        await pauseReached(held,acknowledgment);
        await b.query('BEGIN');
        const mutation=settled((async()=>{
          await b.query(parentLock,[f.manifest.parentId]);
          await b.query('UPDATE youtube_video_identity_runs SET owner=$2 WHERE id=$1',[f.plan.id,'replacement-owner']);
          await b.query('COMMIT');
        })());
        try{await blocked(0,1);}finally{held.resume();}
        assertAccepted(await acknowledgment);assertAccepted(await mutation);
        const before=await exactReservation(b,2,'returned');
        assert.equal(before.runs[0].owner,'replacement-owner');
        await assert.rejects(()=>gate(b).gate.returned(op,hash,hash),/Lost identity owner/);
        await assert.rejects(()=>gate(b,f,'replacement-owner').gate.returned(op,hash,hash),
          /Lost exact receipt acknowledgment fence/);
        assert.deepEqual(await rowState(a),before,'Rejected duplicate acknowledgment must not mutate the receipt');
      }
      races++;
    }
    assert.equal(providerDispatchAttempts,0);
  }finally{
    for(const pause of pauses)pause.resolve();
    // Let gate transactions finish their COMMIT/ROLLBACK before issuing cleanup
    // queries on those same clients; otherwise queued continuations could escape
    // their transaction or race DROP SCHEMA after an assertion failure.
    await Promise.all(inFlight);
    // Roll back either side even when a barrier/assertion fails. Destroy pinned
    // connections after cleanup so no test search_path can leak into the pool.
    try{
      const rollbacks=await Promise.allSettled(clients.map(c=>c.query('ROLLBACK')));
      if(created){
        const cleanup=clients.find((_,i)=>rollbacks[i].status==='fulfilled');
        assert.ok(cleanup,'No PostgreSQL connection available to remove the fixture schema');
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await cleanup.query('SELECT to_regnamespace($1) namespace',[schema])).rows[0].namespace,null);
      }
    }finally{
      for(const c of clients)c.release(true);
      await pool.end();
      globalThis.fetch=originalFetch;
    }
  }
  console.log(JSON.stringify({twoConnectionPostgresRaces:'passed',races,paidCalls:providerDispatchAttempts,
    catalogWrites:0,fixtureSchemaRemoved:true,persistentSchemaChanges:0}));
}
