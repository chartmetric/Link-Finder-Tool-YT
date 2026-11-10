// Only launched by the opt-in integration suite. pg resolves from scripts,
// never from a generated runner at the workspace root.
import pg from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openSavedBatchGate,openSavedAlternativeBatchGate} from '../src/instagram-saved-batch-gate.mjs';
import {digest} from '../src/instagram-next-saved-batch.mjs';
import {runSavedAlternatives} from '../src/instagram-saved-alternatives-runner.mjs';

const send = message => process.send(message);
const next = () => new Promise(resolve => process.once('message', resolve));

process.once('message', async options => {
  const pool = new pg.Pool({...options.connection, max:1});
  let gate, commits = 0, dispatches = 0;
  const alternative = options.scope.version === 'saved-alternatives-v1';
  // Defense in depth: even an accidental future HTTP path cannot leave this fixture.
  globalThis.fetch = async () => { throw Error('Network forbidden in process-safety fixture'); };
  // Execute every query on real PostgreSQL. Only inject failures AFTER the
  // server has acknowledged COMMIT, modeling a lost acknowledgement to the gate.
  const instrumentedPool = {async connect() {
    const client = await pool.connect();
    return {release:() => client.release(), async query(sql, params) {
      assert.doesNotMatch(sql, /instagram_pilot_/i);
      const result = await client.query(sql, params);
      if (sql === 'COMMIT') {
        commits++;
        if (commits === options.loseAckAtCommit) throw Error('Fixture lost COMMIT acknowledgement');
        if (commits === (options.pauseAtCommit ?? 2) && options.pauseAfterReservation) {
          send({phase:'reservation_committed'});
          await next();
        }
      }
      return result;
    }};
  }};
  try {
    send({phase:'ready'});
    await next();
    gate = await (alternative ? openSavedAlternativeBatchGate : openSavedBatchGate)({
      pool:instrumentedPool, scope:options.scope, scopeSha256:options.scopeSha256,
      journalPath:options.journal,
      transport:{live:true, async dispatch({key,kind,payload}) {
        // A fake provider refuses dispatch unless the fsynced admission journal
        // is already visible. No HTTP transport or provider module is imported.
        const rows = (await fs.readFile(options.journal,'utf8')).trim().split('\n').map(JSON.parse);
        assert.ok(rows.some(row => row.phase === 'admitted' && row.key === key));
        if (alternative) {
          const request = rows.find(row => row.phase === 'admitted' && row.key === key).request;
          assert.equal(request.kind,kind);
          // Journals and provider requests cross a JSON boundary; generated
          // bodies may contain optional undefined properties before serialization.
          assert.equal(JSON.stringify(request.body),JSON.stringify(payload.body));
          assert.equal(request.sha256,digest(payload.body));
          assert.equal(payload.inputSha256,request.sha256);
        }
        const receipt = {key,worker:options.worker,...(alternative ? {kind,payload} : {})};
        // Make the synthetic charge durable before simulating sudden worker death.
        const file = await fs.open(options.receipts,'a');
        try { await file.write(JSON.stringify(receipt)+'\n'); await file.sync(); }
        finally { await file.close(); }
        dispatches++;
        if (options.dieAfterDispatch && dispatches === (options.dieAtDispatch ?? 1))
          process.kill(process.pid,'SIGKILL');
        if (alternative) {
          if (kind === 'scrapecreators_candidate') return {
            cost:0.02,costBasis:'conservative_metadata_estimate',available:true,
            candidate:{url:payload.body.url,displayName:'Test-only captured artist',
              bio:'Test-only captured biography',externalUrls:[]},
          };
          assert.equal(kind,'jev');
          return {cost:0.001,model:options.scope.expectedModel,
            answers:[{verdict:'uncertain',sameIdentityProbability:0.5}]};
        }
        return {cost:0.001};
      }},
    });
    send({phase:'claimed'});
    if (alternative && !options.specs) {
      const result = await runSavedAlternatives({scope:options.scope,gate,
        persist:async snapshot => fs.writeFile(options.journal+'.results',JSON.stringify(snapshot))});
      send({phase:'result',result});
    } else {
      for (const spec of options.specs ?? options.keys ?? ['one']) await gate.request(spec);
    }
    send({phase:'done',snapshot:gate.snapshot()});
  } catch (error) {
    send({phase:'error',message:error.message,code:error.code});
    if (gate) {
      try {
        await gate.request(alternative
          ? {profileId:options.scope.targets[0].profileId,kind:'scrapecreators_candidate',
            url:options.scope.targets[0].candidates[0].url}
          : 'two');
        send({phase:'unexpected_retry'});
      } catch (retryError) {
        send({phase:'retry_blocked',message:retryError.message});
      }
      send({phase:'snapshot',snapshot:gate.snapshot()});
    }
  } finally {
    await gate?.close();
    await pool.end();
    process.disconnect();
  }
});
