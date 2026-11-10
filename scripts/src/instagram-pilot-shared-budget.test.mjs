import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, fork} from 'node:child_process';
import {once} from 'node:events';
import pg from 'pg';
import {pilotBudgetSchemaSql, ORIGINAL_PILOT_BUDGET_ID, createPostgresPilotCoordinator} from './instagram-pilot-shared-budget.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';

// A disposable local PostgreSQL instance, never DATABASE_URL or application
// tables. pg_ctl chooses no TCP listeners; children receive only its socket.
test('independent processes enforce one durable pilot ceiling', {timeout:60000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'pilot-coordination-'));
  const data = path.join(dir,'data'), port = 15483, user = os.userInfo().username;
  execFileSync('initdb',['-D',data,'-A','trust','-U',user,'--no-locale'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',data,'-l',path.join(dir,'postgres.log'),'-o',
    `-k ${dir} -p ${port} -c listen_addresses='' -c fsync=on`,'-w','start'],{stdio:'ignore'});
  const pool = new pg.Pool({host:dir,port,user,database:'postgres'});
  t.after(async () => {
    await pool.end();
    execFileSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{stdio:'ignore'});
    await fs.rm(dir,{recursive:true,force:true});
  });
  await pool.query(pilotBudgetSchemaSql);
  const seed = async cents => {
    await pool.query('TRUNCATE instagram_pilot_reservations, instagram_pilot_runs, instagram_pilot_ceilings');
    await pool.query('INSERT INTO instagram_pilot_ceilings VALUES ($1,1000,$2)',[ORIGINAL_PILOT_BUDGET_ID,cents]);
  };
  const total = async () => (await pool.query('SELECT reserved_cents FROM instagram_pilot_ceilings')).rows[0].reserved_cents;
  let seq = 0;
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const receipts = path.join(dir,'receipts');
  function launch(options) {
    const child = fork(new URL('../fixtures/pilot-budget-process.mjs',import.meta.url),[], {
      // No provider keys and no ambient DATABASE_URL in the fork.
      env:{PATH:process.env.PATH}, stdio:['ignore','pipe','pipe','ipc'],
    });
    children.push(child);
    const messages = [], waiters = [];
    let exited = false;
    child.on('message', message => { messages.push(message); while(waiters.length) waiters.shift()(); });
    const exit = once(child,'exit').then(([code]) => { exited=true; while(waiters.length) waiters.shift()(); return code; });
    child.send({socket:dir,port,user,receipts,journal:path.join(dir,`journal-${++seq}`),...options});
    return {child,exit,messages, async ready() {
      while (!messages.length && !exited) await new Promise(resolve=>waiters.push(resolve));
      assert.equal(messages[0]?.phase,'ready',JSON.stringify(messages));
    }, go() { child.send('go'); }};
  }
  const receiptCount = async () => (await fs.readFile(receipts,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;

  await t.test('concurrent verification and audit cannot both spend the final cent',async () => {
    await seed(999);
    const a=launch({runId:'verification',prior:999}), b=launch({runId:'reference-audit',prior:999});
    await Promise.all([a.ready(),b.ready()]);
    a.go(); b.go(); await Promise.all([a.exit,b.exit]);
    assert.equal(await total(),1000); assert.equal(await receiptCount(),1);
    assert.equal([...a.messages,...b.messages].filter(m=>m.phase==='error').length,1);
    const stale=launch({runId:'stale-checkpoint',prior:999});
    await stale.exit;
    assert.match(stale.messages[0].message,/Stale/); assert.equal(await receiptCount(),1);
  });
  await t.test('run identities are exclusive even with separate journals and after restart',async () => {
    await seed(990);
    const a=launch({runId:'same-run',prior:990}), b=launch({runId:'same-run',prior:990});
    await Promise.allSettled([a.ready(),b.ready()]);
    const winner=[a,b].find(p=>p.messages[0]?.phase==='ready');
    assert.ok(winner);
    winner.go(); await Promise.all([a.exit,b.exit]);
    assert.equal([...a.messages,...b.messages].filter(m=>m.phase==='ready').length,1);
    assert.equal(await total(),991);
    const replay=launch({runId:'same-run',prior:991});
    await replay.exit; assert.equal(replay.messages[0].phase,'error'); assert.equal(await total(),991);
  });
  for (const outcome of ['fail','timeout','crash']) {
    await t.test(`${outcome} preserves reservation with no replay`,async () => {
      await seed(999);
      const before=await receiptCount();
      const a=launch({runId:outcome,prior:999,[outcome]:true});
      await a.ready(); a.go(); await a.exit;
      assert.equal(await total(),1000); assert.equal(await receiptCount(),before+1);
      const replay=launch({runId:outcome,prior:1000});
      await replay.exit;
      assert.equal(replay.messages[0].phase,'error'); assert.equal(await receiptCount(),before+1);
    });
  }
  await t.test('per-run caps are durable and isolated from the shared ceiling',async () => {
    await seed(990);
    const a=launch({runId:'small-cap',prior:990,cap:1,requests:2});
    await a.ready(); a.go(); await a.exit;
    assert.equal(await total(),991);
    assert.equal(a.messages.at(-1).phase,'error');
  });
  await t.test('lost commit acknowledgement fences dispatch without refunding the committed reservation',async () => {
    await seed(999);
    let loseAck=false, dispatches=0;
    const uncertainPool={async connect() {
      const client=await pool.connect();
      return {release:()=>client.release(), async query(sql,params) {
        const result=await client.query(sql,params);
        if(sql==='COMMIT'&&loseAck){loseAck=false;throw Error('Fixture lost commit acknowledgement');}
        return result;
      }};
    }};
    const coordinator=createPostgresPilotCoordinator(uncertainPool);
    const owner=await coordinator.claim({runId:'lost-ack',priorReservedCents:999,maxSpendCents:1});
    // Full budget pipeline, but reusing this already-exclusive claim lets us
    // inject acknowledgement loss specifically at reservation commit.
    const manifest={run_allowed:true,authorization:{approved:true,maxSpendCents:1},
      artists:[{profile_id:'1',source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}}],
      proposed_limits:{serper_requests_total:2,serper_requests_per_artist:2,
        scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
        jev_requests_total:0,jev_requests_per_artist:0,paid_http_requests_total:2,
        public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
        public_music_page_requests_per_artist:1,global_concurrent_provider_requests:1,per_request_timeout_seconds:1,
        jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
    const budget=await createPilotBudget({manifest,journalPath:path.join(dir,'lost-ack-journal'),mode:'live',
      transport:{live:true,dispatch:async()=>{dispatches++;}},
      sharedCoordinator:{...coordinator,claim:async()=>owner}});
    loseAck=true;
    await assert.rejects(budget.request({profileId:'1',kind:'serper',key:'uncertain'}),/lost commit/);
    await assert.rejects(budget.request({profileId:'1',kind:'serper',key:'second'}),/no automatic replay/);
    assert.equal(await total(),1000); assert.equal(dispatches,0);
    await budget.close();
    assert.equal(budget.snapshot().sharedBudget.reservedSpendCents,1000);
    await assert.rejects(coordinator.claim({runId:'lost-ack',priorReservedCents:1000,maxSpendCents:1}),/duplicate key/);
  });
  await t.test('missing checkpoint and missing schema fail closed',async () => {
    await pool.query('TRUNCATE instagram_pilot_reservations, instagram_pilot_runs, instagram_pilot_ceilings');
    const before=await receiptCount(), a=launch({runId:'no-seed',prior:0});
    await a.exit; assert.match(a.messages[0].message,/checkpoint/);
    await pool.query('DROP TABLE instagram_pilot_reservations, instagram_pilot_runs, instagram_pilot_ceilings');
    const b=launch({runId:'no-schema',prior:0});
    await b.exit; assert.equal(b.messages[0].phase,'error');
    assert.equal(await receiptCount(),before);
  });
});
