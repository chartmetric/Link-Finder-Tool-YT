// Explicit operator-approved abandonment, never a provider retry or budget reset.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './instagram-next-saved-batch.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {retireStoppedMetadataBudget} from './instagram-stopped-batch-recovery.mjs';

assert.deepEqual(process.argv.slice(2), ['--abandon-approved']);
const root = 'generated-artifacts/next-saved-full-tiers-1-5-usd100';
const dir = root + '-chunk-005';
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const summary = await read(root + '/summary.json');
assert.equal(summary.status, 'stopped');
assert.equal(summary.stopReason, 'Timed-out request is uncertain; no retry.');
const scope = await read(dir + '/approved-scope.json');
const journal = (await fs.readFile(dir + '/execution/admissions.jsonl', 'utf8'))
  .trim().split('\n').map(JSON.parse);
const sent = journal.filter(r => r.phase === 'admitted');
const returned = new Set(journal.filter(r => r.phase === 'returned').map(r => r.key));
const stopped = journal.filter(r => r.phase === 'stopped_no_retry');
assert.equal(stopped.length, 1);
const key = stopped[0].key;
assert.equal(key, 'metadata-79f19d9f091846605f65c8dc660189766b98d5333e21ddf6e433de39cece1375');
assert.equal(sent.length, 380);
assert.equal(returned.size, 379);
const receipts = [];
for (const a of sent) {
  assert.equal(a.request.sha256, digest(a.request.body));
  assert.equal(a.reservedCents, 2);
  const path = dir + '/execution/' + (a.request.kind === 'jev' ? 'model-responses/' : 'metadata-responses/') + a.key + '.json';
  if (a.key === key) {
    assert.equal(a.profileId, '3998446');
    assert.ok(!returned.has(key));
    await assert.rejects(fs.access(path), e => e.code === 'ENOENT');
    receipts.push({key, httpStatus: null, outcome: 'interrupted_never_retry'});
  } else {
    assert.ok(returned.has(a.key));
    const packet = await read(path);
    assert.ok(![401, 402, 403, 429].includes(packet.status));
    if (a.request.kind === 'jev') assert.equal(packet.requestBodySha256, a.request.sha256);
    else assert.equal(packet.requestedUrl, a.request.body.url);
    receipts.push({key: a.key, httpStatus: packet.status});
  }
}
const destination = dir + '/retired-unused-allocation.json';
await assert.rejects(fs.access(destination), e => e.code === 'ENOENT');
const pool = await connectSavedBatchPool();
try {
  const retirement = await retireStoppedMetadataBudget(pool, {
    scope, scopeSha256: digest(scope), receipts, skipUncertainKeys: [key],
  });
  await fs.writeFile(destination, JSON.stringify({...retirement,
    scopeSha256: digest(scope), journalSha256: digest(journal), receipts,
    authorization: 'User requested resuming continuously overnight within the original $100 cap.',
  }, null, 2), {flag: 'wx'});
  console.log(JSON.stringify(retirement));
} finally { await pool.end(); }
