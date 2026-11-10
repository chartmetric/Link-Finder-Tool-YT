// Only launched by the opt-in integration suite. pg resolves from scripts,
// never from a generated runner at the workspace root.
import pg from 'pg';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {openSavedBatchGate} from '../src/instagram-saved-batch-gate.mjs';

const send = message => process.send(message);
const next = () => new Promise(resolve => process.once('message', resolve));

process.once('message', async options => {
  const pool = new pg.Pool({...options.connection, max:1});
  let gate, commits = 0;
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
        if (commits === 2 && options.pauseAfterReservation) {
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
    gate = await openSavedBatchGate({
      pool:instrumentedPool, scope:options.scope, scopeSha256:options.scopeSha256,
      journalPath:options.journal,
      transport:{live:true, async dispatch({key}) {
        // A fake provider refuses dispatch unless the fsynced admission journal
        // is already visible. No HTTP transport or provider module is imported.
        const rows = (await fs.readFile(options.journal,'utf8')).trim().split('\n').map(JSON.parse);
        assert.ok(rows.some(row => row.phase === 'admitted' && row.key === key));
        await fs.appendFile(options.receipts, JSON.stringify({key, worker:options.worker})+'\n');
        if (options.dieAfterDispatch) process.kill(process.pid,'SIGKILL');
        return {cost:0.001};
      }},
    });
    send({phase:'claimed'});
    for (const key of options.keys ?? ['one']) await gate.request(key);
    send({phase:'done',snapshot:gate.snapshot()});
  } catch (error) {
    send({phase:'error',message:error.message,code:error.code});
    if (gate) {
      try {
        await gate.request('two');
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
