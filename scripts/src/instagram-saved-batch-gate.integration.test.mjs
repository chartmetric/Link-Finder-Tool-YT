import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {savedBatchSchemaSql} from './instagram-saved-batch-gate.mjs';
import {pilotBudgetSchemaSql} from './instagram-pilot-shared-budget.mjs';
import {digest,enrichedRequest,prepareSavedAlternativeScope} from './instagram-next-saved-batch.mjs';

const enabled = process.env.INSTAGRAM_SAVED_BATCH_PG_INTEGRATION === '1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// No DATABASE_URL: a private Unix socket, no TCP listeners, and fresh schemas
// in a disposable server. Even opting in cannot reach application budgets.
test('saved-batch PostgreSQL process safety', {
  skip:enabled ? false : 'Set INSTAGRAM_SAVED_BATCH_PG_INTEGRATION=1 to run isolated PostgreSQL tests',
  timeout:60000,
}, async t => {
  // Import only after opt-in, from the workspace that declares pg.
  const {default:pg} = await import('pg');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'saved-batch-pg-'));
  const data = path.join(dir,'data'), port = 15484, user = os.userInfo().username;
  const suffix = randomUUID().replaceAll('-','');
  const schema = `test_saved_batch_${suffix}`, pilotSchema = `test_pilot_${suffix}`;
  const children = [];
  let started = false, pool, observer;
  t.after(async () => {
    for (const worker of children) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.all(children.map(worker => worker.exit));
    try {
      if (pool) {
        // Never drop/truncate any table outside these two freshly created schemas.
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${pilotSchema} CASCADE`);
      }
    } finally {
      await Promise.all([pool?.end(),observer?.end()]);
      if (started) execFileSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{stdio:'ignore'});
      await fs.rm(dir,{recursive:true,force:true});
    }
  });
  execFileSync('initdb',['-D',data,'-A','trust','-U',user,'--no-locale'],{stdio:'ignore'});
  execFileSync('pg_ctl',['-D',data,'-l',path.join(dir,'postgres.log'),'-o',
    `-k ${dir} -p ${port} -c listen_addresses='' -c fsync=on`,'-w','start'],{stdio:'ignore'});
  started = true;
  const connection = {host:dir,port,user,database:'postgres',
    options:`-c search_path=${schema}`,connectionTimeoutMillis:5000};
  pool = new pg.Pool({...connection,max:2});
  observer = new pg.Pool({...connection,max:1});
  await pool.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${pilotSchema}`);
  await pool.query(savedBatchSchemaSql);
  // A sacrificial copy of the old pilot ledger, not an existing ledger or
  // allowance. No pilot table is ever used for saved-batch coordination.
  const pilot = await pool.connect();
  try {
    await pilot.query(`SET search_path=${pilotSchema}`);
    await pilot.query(pilotBudgetSchemaSql);
    await pilot.query("INSERT INTO instagram_pilot_ceilings VALUES ('test-original-pilot',1000,743)");
    await pilot.query("INSERT INTO instagram_pilot_runs VALUES ('test-original-pilot','test-history',$1,1000,3)",[randomUUID()]);
    await pilot.query("INSERT INTO instagram_pilot_reservations VALUES ('test-original-pilot','test-history','test-uncertain',3,'fixture','jev')");
  } finally {
    await pilot.query(`SET search_path=${schema}`);
    pilot.release();
  }
  const pilotSnapshot = async () => {
    const result = {};
    for (const table of ['instagram_pilot_ceilings','instagram_pilot_runs','instagram_pilot_reservations']) {
      result[table] = (await pool.query(`SELECT * FROM ${pilotSchema}.${table} ORDER BY 1,2`)).rows;
    }
    return result;
  };
  const originalPilot = await pilotSnapshot();
  let sequence = 0;
  async function seed(name) {
    const body = {state:{artist:'Test-only artist'},questions:{}};
    const scope = {
      authorization:{approved:true,maxSpendCents:2000,budgetId:`test-${name}`},
      artists:[{profile_id:'fixture'}],savedEvidenceOnly:true,liveLinkWrites:false,automaticRetries:0,
      requests:['one','two'].map(key => ({key,profileId:'fixture',kind:'jev',body,
        sha256:hash(body),bytes:Buffer.byteLength(JSON.stringify(body))})),
    };
    const frozen = {scope,scopeSha256:hash(scope)};
    await pool.query('INSERT INTO instagram_saved_batch_budgets (id,scope_sha256,cap_cents) VALUES ($1,$2,2000)',
      [scope.authorization.budgetId,frozen.scopeSha256]);
    return frozen;
  }
  function launch(frozen, options = {}) {
    const worker = `worker-${++sequence}`, messages = [], waiters = [];
    const journal = path.join(dir,`${worker}.jsonl`), receipts = path.join(dir,'receipts.jsonl');
    const child = fork(new URL('../fixtures/saved-batch-gate-process.mjs',import.meta.url),[],{
      env:{PATH:process.env.PATH},execArgv:[],stdio:['ignore','ignore','pipe','ipc'],
    });
    let exited = false, stderr = '';
    child.stderr.on('data',chunk => { stderr += chunk; });
    const notify = () => { for (const resolve of waiters.splice(0)) resolve(); };
    child.on('message',message => { messages.push(message); notify(); });
    const exit = new Promise(resolve => {
      child.once('error',error => { stderr += error.message; });
      child.once('exit',(code,signal) => { exited = true; notify(); resolve({code,signal}); });
    });
    const result = {child,worker,journal,messages,exit,
      go:() => child.send('go'),
      async wait(phase) {
        const deadline = Date.now()+10000;
        while (!messages.some(message => message.phase === phase)) {
          assert.ok(!exited,`${worker} exited before ${phase}: ${JSON.stringify(messages)} ${stderr}`);
          assert.ok(Date.now()<deadline,`${worker} timed out before ${phase}: ${stderr}`);
          await Promise.race([new Promise(resolve => waiters.push(resolve)),delay(20)]);
        }
      },
    };
    children.push(result);
    child.send({connection:{...connection,application_name:worker},...frozen,...options,worker,journal,receipts});
    return result;
  }
  async function run(frozen, options) {
    const worker = launch(frozen,options);
    await worker.wait('ready'); worker.go();
    const status = await worker.exit;
    assert.equal(status.code,0,JSON.stringify(worker.messages));
    return worker;
  }
  const receipts = async () => (await fs.readFile(path.join(dir,'receipts.jsonl'),'utf8')
    .catch(error => { if (error.code === 'ENOENT') return ''; throw error; }))
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  const journal = async worker => (await fs.readFile(worker.journal,'utf8')).trim()
    .split('\n').filter(Boolean).map(JSON.parse);
  async function state(frozen, cents, admissions) {
    const id = frozen.scope.authorization.budgetId;
    const budget = (await pool.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1',[id])).rows[0];
    const rows = (await pool.query('SELECT * FROM instagram_saved_batch_admissions WHERE budget_id=$1',[id])).rows;
    assert.equal(budget.reserved_cents,cents);
    assert.equal(rows.length,admissions);
    for (const row of rows) { assert.equal(row.cents,2); assert.equal(row.admission_key,'one'); }
    assert.deepEqual(await pilotSnapshot(),originalPilot,'Original pilot ledger must remain unchanged');
    return budget;
  }
  async function replayDenied(frozen) {
    const before = await receipts();
    const replay = await run(frozen);
    assert.match(replay.messages.find(message => message.phase === 'error')?.message,/already claimed/);
    assert.ok(!replay.messages.some(message => message.phase === 'claimed'));
    assert.deepEqual(await receipts(),before);
  }

  async function compete(frozen) {
    const lock = await pool.connect();
    const a = launch(frozen), b = launch(frozen);
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1 FOR UPDATE',[frozen.scope.authorization.budgetId]);
      await Promise.all([a.wait('ready'),b.wait('ready')]);
      a.go(); b.go();
      const deadline = Date.now()+10000;
      while (true) {
        const blocked = await observer.query(
          "SELECT application_name FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND wait_event_type='Lock'",
          [[a.worker,b.worker]]);
        if (blocked.rows.length === 2) break;
        assert.ok(Date.now()<deadline,'Both child processes must contend on a real PostgreSQL row lock');
        await delay(20);
      }
      await lock.query('COMMIT');
    } finally { await lock.query('ROLLBACK'); lock.release(); }
    const exits = await Promise.all([a.exit,b.exit]);
    assert.ok(exits.every(exit => exit.code === 0));
    const winners = [a,b].filter(worker => worker.messages.some(message => message.phase === 'claimed'));
    assert.equal(winners.length,1);
    const loser = [a,b].find(worker => worker !== winners[0]);
    assert.match(loser.messages.find(message => message.phase === 'error')?.message,/already claimed/);
    return {winner:winners[0],loser};
  }

  await t.test('two processes actually waiting on the same row dispatch through only one owner',async () => {
    const frozen = await seed('race'), before = (await receipts()).length;
    const {winner,loser} = await compete(frozen);
    const newReceipts = (await receipts()).slice(before);
    assert.deepEqual(newReceipts,[{key:'one',worker:winner.worker}]);
    assert.deepEqual((await journal(winner)).map(row => row.phase),['admitted','returned']);
    assert.equal((await journal(loser)).length,0);
    assert.ok((await state(frozen,2,1)).owner);
    await replayDenied(frozen);
  });

  await t.test('a duplicate key hits the real unique constraint without another dispatch or reservation',async () => {
    const frozen = await seed('duplicate-key'), before = (await receipts()).length;
    const worker = await run(frozen,{keys:['one','one']});
    assert.equal(worker.messages.find(message => message.phase === 'error')?.code,'23505');
    assert.ok(worker.messages.some(message => message.phase === 'retry_blocked' && /stopped/.test(message.message)));
    assert.equal((await receipts()).length,before+1);
    assert.deepEqual((await journal(worker)).map(row => row.phase),['admitted','returned','stopped_no_retry']);
    await state(frozen,2,1);
    await replayDenied(frozen);
  });

  for (const commit of [1,2]) {
    await t.test(`lost acknowledgement of ${commit === 1 ? 'claim' : 'reservation'} COMMIT never permits replay`,async () => {
      const frozen = await seed(`lost-ack-${commit}`), before = await receipts();
      const worker = await run(frozen,{loseAckAtCommit:commit});
      assert.match(worker.messages.find(message => message.phase === 'error')?.message,/lost COMMIT acknowledgement/);
      assert.deepEqual(await receipts(),before);
      assert.deepEqual((await journal(worker)).map(row => row.phase),commit === 1 ? [] : ['stopped_no_retry']);
      if (commit === 2) assert.ok(worker.messages.some(message => message.phase === 'retry_blocked'));
      assert.ok((await state(frozen,commit === 2 ? 2 : 0,commit === 2 ? 1 : 0)).owner);
      await replayDenied(frozen);
      await state(frozen,commit === 2 ? 2 : 0,commit === 2 ? 1 : 0);
    });
  }

  await t.test('a different valid scope hash cannot claim an existing unspent allowance',async () => {
    const frozen = await seed('changed-scope'), before = await receipts();
    const changedScope = structuredClone(frozen.scope);
    changedScope.artists.push({profile_id:'another-fixture'});
    const worker = await run({scope:changedScope,scopeSha256:hash(changedScope)});
    assert.match(worker.messages.find(message => message.phase === 'error')?.message,/approval is missing or changed/);
    assert.deepEqual(await receipts(),before);
    assert.equal((await state(frozen,0,0)).owner,null);
    const valid = await run(frozen);
    assert.ok(valid.messages.some(message => message.phase === 'done'));
    await state(frozen,2,1);
  });

  for (const afterDispatch of [false,true]) {
    await t.test(`worker death ${afterDispatch ? 'after fake charge' : 'after reservation, before journal/dispatch'} preserves non-replayable work`,async () => {
      const frozen = await seed(`death-${afterDispatch}`), before = (await receipts()).length;
      const worker = launch(frozen,afterDispatch ? {dieAfterDispatch:true} : {pauseAfterReservation:true});
      await worker.wait('ready'); worker.go();
      if (!afterDispatch) {
        await worker.wait('reservation_committed');
        worker.child.kill('SIGKILL');
      }
      assert.equal((await worker.exit).signal,'SIGKILL');
      assert.equal((await receipts()).length,before+(afterDispatch ? 1 : 0));
      assert.deepEqual((await journal(worker)).map(row => row.phase),afterDispatch ? ['admitted'] : []);
      const prior = await state(frozen,2,1);
      await replayDenied(frozen);
      assert.deepEqual(await state(frozen,2,1),prior);
    });
  }

  await t.test('saved alternatives share one durable parent across metadata and generated verification',async t => {
    const url = handle => `https://www.instagram.com/${handle}/`;
    const spec = (kind,profileId='1',handle='shared') => ({kind,profileId,url:url(handle)});
    const metadata = (id='1',handle='shared') => spec('scrapecreators_candidate',id,handle);
    const verify = (id='1',handle='shared') => spec('jev',id,handle);
    const keyFor = s => s.kind === 'jev'
      ? 'verify-'+digest([s.profileId,s.url]) : 'metadata-'+digest(s.url);
    async function seedAlternative(name,cap=10) {
      const targets = ['1','2'].map(id => {
        const candidates = (id === '1' ? ['shared','distinct'] : ['shared'])
          .map(handle => ({url:url(handle),title:`Saved title ${id} ${handle}`,snippet:`Saved evidence ${id}`}));
        return {profileId:id,artist:`Test artist ${id}`,sourceCapturedAt:'2026-11-10',
          sourceArtistName:`Test artist ${id}`,candidates,context:{ownershipConfirmed:false,items:[]},
          player:{profile_id:id,cm_artist:id,artist:`Test artist ${id}`,accounts:[],
            source_identity_matches:true,catalog_profile:{profile_id:id,cm_artist:id},
            savedCandidateUrls:candidates.map(c => c.url)}};
      });
      const scope = prepareSavedAlternativeScope(targets,{approved:true,budgetId:`test-alt-${name}`,
        maxSpendCents:cap,candidateMetadataFetchesApproved:true,savedAlternativesApproved:true},
        {inspectAlternatives:true});
      const scopeSha256 = digest(scope);
      await pool.query('INSERT INTO instagram_saved_batch_budgets (id,scope_sha256,cap_cents) VALUES ($1,$2,$3)',
        [scope.authorization.budgetId,scopeSha256,cap]);
      return {scope,scopeSha256};
    }
    async function alternativeState(frozen,specs) {
      const id = frozen.scope.authorization.budgetId;
      const budget = (await pool.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1',[id])).rows[0];
      const rows = (await pool.query(
        'SELECT admission_key,profile_id,cents FROM instagram_saved_batch_admissions WHERE budget_id=$1 ORDER BY admission_key',
        [id])).rows;
      assert.ok(budget.owner,'The parent must remain permanently claimed');
      assert.equal(budget.cap_cents,frozen.scope.authorization.maxSpendCents);
      assert.equal(budget.scope_sha256,frozen.scopeSha256);
      assert.equal(budget.reserved_cents,specs.length*2);
      assert.ok(budget.reserved_cents<=budget.cap_cents);
      assert.deepEqual(rows,specs.map(s => ({admission_key:keyFor(s),profile_id:s.profileId,cents:2}))
        .sort((a,b) => a.admission_key.localeCompare(b.admission_key)));
      assert.deepEqual(await pilotSnapshot(),originalPilot);
      return {budget,rows};
    }
    async function remainsClosed(frozen,specs) {
      const before = await alternativeState(frozen,specs);
      await replayDenied(frozen);
      assert.deepEqual(await alternativeState(frozen,specs),before,'Reopening must not refund or replenish the parent');
    }
    function assertJournalRequests(rows,calls) {
      const admitted = rows.filter(row => row.phase === 'admitted');
      assert.equal(admitted.length,calls.length);
      for (const [index,row] of admitted.entries()) {
        const call = calls[index],request = row.request;
        assert.equal(row.key,call.key);
        assert.equal(request.kind,call.kind);
        assert.deepEqual(request.body,call.payload.body);
        assert.equal(request.sha256,digest(request.body));
        assert.equal(request.sha256,call.payload.inputSha256);
      }
    }

    await t.test('competing alternative runners dispatch one shared metadata call and distinct artist verifications',async () => {
      const frozen = await seedAlternative('race'), before = (await receipts()).length;
      const {winner,loser} = await compete(frozen);
      const calls = (await receipts()).slice(before);
      const specs = [metadata(),verify(),verify('2'),metadata('1','distinct'),verify('1','distinct')];
      assert.deepEqual(calls.map(c => c.key),specs.map(keyFor));
      assert.ok(calls.every(c => c.worker === winner.worker));
      assert.equal((await journal(loser)).length,0);
      const rows = await journal(winner);
      assert.deepEqual(rows.map(r => r.phase),specs.flatMap(() => ['admitted','returned']));
      assertJournalRequests(rows,calls);
      // The generated verification body must use completed account metadata,
      // but keep separate catalog identity and historical search evidence.
      for (const call of calls.filter(c => c.kind === 'jev')) {
        const s = specs.find(s => keyFor(s) === call.key);
        const target = frozen.scope.targets.find(t => t.profileId === s.profileId);
        const selected = target.candidates.find(c => c.url === s.url);
        const candidate = {url:s.url,displayName:'Test-only captured artist',
          bio:'Test-only captured biography',externalUrls:[]};
        assert.equal(JSON.stringify(call.payload.body),JSON.stringify(enrichedRequest({...target,selected},candidate).body));
      }
      assert.notEqual(calls[1].payload.inputSha256,calls[2].payload.inputSha256);
      const result = winner.messages.find(m => m.phase === 'result').result;
      assert.equal(result.status,'completed');
      assert.equal(result.budget.reservedCents,10);
      assert.equal(result.budget.estimatedCostUsd,0.04);
      assert.equal(result.budget.reportedCostUsd,0.003);
      await remainsClosed(frozen,specs);
    });

    for (const duplicate of ['metadata','verification']) {
      await t.test(`duplicate ${duplicate} is rejected by PostgreSQL without another charge`,async () => {
        const frozen = await seedAlternative(`duplicate-${duplicate}`), before = (await receipts()).length;
        const specs = duplicate === 'metadata' ? [metadata()] : [metadata(),verify()];
        const worker = await run(frozen,{specs:[...specs,duplicate === 'metadata' ? metadata('2') : verify()]});
        assert.equal(worker.messages.find(m => m.phase === 'error')?.code,'23505');
        assert.ok(worker.messages.some(m => m.phase === 'retry_blocked' && /stopped/.test(m.message)));
        assert.equal((await receipts()).length,before+specs.length);
        assert.deepEqual((await journal(worker)).map(r => r.phase),
          [...specs.flatMap(() => ['admitted','returned']),'stopped_no_retry']);
        await remainsClosed(frozen,specs);
      });
    }

    await t.test('the database cap covers both providers even if a worker requests more than the runner allows',async () => {
      const frozen = await seedAlternative('cap',8), before = (await receipts()).length;
      const specs = [metadata(),verify(),verify('2'),metadata('1','distinct')];
      const worker = await run(frozen,{specs:[...specs,verify('1','distinct')]});
      assert.match(worker.messages.find(m => m.phase === 'error')?.message,/cap reached/);
      assert.deepEqual((await receipts()).slice(before).map(c => c.key),specs.map(keyFor));
      assert.ok(worker.messages.some(m => m.phase === 'retry_blocked'));
      await remainsClosed(frozen,specs);
      const beforeState = await alternativeState(frozen,specs), beforeReceipts = await receipts();
      for (const change of ['cap','scope']) {
        const scope = structuredClone(frozen.scope);
        if (change === 'cap') scope.authorization.maxSpendCents = 10;
        else scope.targets[0].candidates[0].title = 'Changed frozen search evidence';
        const rejected = await run({scope,scopeSha256:digest(scope)});
        assert.match(rejected.messages.find(m => m.phase === 'error')?.message,/approval is missing or changed/);
      }
      assert.deepEqual(await receipts(),beforeReceipts);
      assert.deepEqual(await alternativeState(frozen,specs),beforeState);
    });

    await t.test('verification without a completed exact-account capture cannot reserve or dispatch',async () => {
      const frozen = await seedAlternative('no-capture'), before = await receipts();
      const worker = await run(frozen,{specs:[verify()]});
      assert.match(worker.messages.find(m => m.phase === 'error')?.message,/exact-account completed metadata/);
      assert.deepEqual(await receipts(),before);
      await remainsClosed(frozen,[]);
    });

    // Claim, metadata admission and dynamically generated verifier admission are
    // separate real commits. Each uncertain acknowledgement permanently fences replay.
    for (const commit of [1,2,3]) {
      await t.test(`lost alternative COMMIT acknowledgement at transaction ${commit} cannot replay`,async () => {
        const frozen = await seedAlternative(`lost-ack-${commit}`), before = (await receipts()).length;
        const worker = await run(frozen,{specs:[metadata(),verify()],loseAckAtCommit:commit});
        assert.match(worker.messages.find(m => m.phase === 'error')?.message,/lost COMMIT acknowledgement/);
        const specs = [metadata(),verify()].slice(0,commit-1);
        const calls = (await receipts()).slice(before);
        assert.deepEqual(calls.map(c => c.key),commit === 3 ? [keyFor(metadata())] : []);
        assert.deepEqual((await journal(worker)).map(r => r.phase),
          commit === 1 ? [] : commit === 2 ? ['stopped_no_retry'] : ['admitted','returned','stopped_no_retry']);
        if (commit > 1) assert.ok(worker.messages.some(m => m.phase === 'retry_blocked'));
        await remainsClosed(frozen,specs);
      });
    }

    for (const kind of ['metadata','verification']) for (const afterDispatch of [false,true]) {
      await t.test(`alternative worker death ${afterDispatch ? 'after fake charge' : 'after reservation before journal'} during ${kind} cannot replay`,async () => {
        const frozen = await seedAlternative(`death-${kind}-${afterDispatch}`), before = (await receipts()).length;
        const count = kind === 'metadata' ? 1 : 2, specs = [metadata(),verify()].slice(0,count);
        const worker = launch(frozen,{specs,
          ...(afterDispatch ? {dieAfterDispatch:true,dieAtDispatch:count}
            : {pauseAfterReservation:true,pauseAtCommit:count+1})});
        await worker.wait('ready'); worker.go();
        if (!afterDispatch) {
          await worker.wait('reservation_committed');
          worker.child.kill('SIGKILL');
        }
        assert.equal((await worker.exit).signal,'SIGKILL');
        const calls = (await receipts()).slice(before);
        assert.deepEqual(calls.map(c => c.key),specs.slice(0,afterDispatch ? count : count-1).map(keyFor));
        const rows = await journal(worker);
        assert.deepEqual(rows.map(r => r.phase),
          [...(count === 2 ? ['admitted','returned'] : []),...(afterDispatch ? ['admitted'] : [])]);
        assertJournalRequests(rows,calls);
        await remainsClosed(frozen,specs);
      });
    }
  });
});
