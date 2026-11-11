// Explicit operator-approved abandonment, never a provider retry or budget reset.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './instagram-next-saved-batch.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {retireStoppedMetadataBudget} from './instagram-stopped-batch-recovery.mjs';

const args=process.argv.slice(2);
const current=args.includes('--chunk=008');
assert.deepEqual(args,current?['--abandon-approved','--chunk=008']:['--abandon-approved']);
const root = 'generated-artifacts/next-saved-full-tiers-1-5-usd100';
const dir = root + (current?'-chunk-008':'-chunk-005');
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const summary = await read(root + '/summary.json');
assert.equal(summary.status, 'stopped');
assert.equal(summary.stopReason, 'Timed-out request is uncertain; no retry.');
const scope = await read(dir + '/approved-scope.json');
if(current){
  const chunks=await read(root+'/chunks.json');
  assert.equal(chunks.at(-1).dir,dir);
  assert.equal(summary.maximumSpendCents,null);
  assert.equal(scope.authorization.budgetId,'full-tiers-1-5-no-ig-usd100-chunk-008');
}
const journal = (await fs.readFile(dir + '/execution/admissions.jsonl', 'utf8'))
  .trim().split('\n').map(JSON.parse);
const sent = journal.filter(r => r.phase === 'admitted');
const returned = new Set(journal.filter(r => r.phase === 'returned').map(r => r.key));
const stopped = journal.filter(r => r.phase === 'stopped_no_retry');
assert.equal(stopped.length, 1);
const key = stopped[0].key;
assert.equal(key, current
  ?'metadata-43babfa6092b1ac0325f5844f649943cb956d23af23fd22dae8e069d15e90ad6'
  :'metadata-79f19d9f091846605f65c8dc660189766b98d5333e21ddf6e433de39cece1375');
assert.equal(sent.length, current?268:380);
assert.equal(returned.size, current?267:379);
const receipts = [];
for (const a of sent) {
  assert.equal(a.request.sha256, digest(a.request.body));
  assert.equal(a.reservedCents, 2);
  const path = dir + '/execution/' + (a.request.kind === 'jev' ? 'model-responses/' : 'metadata-responses/') + a.key + '.json';
  if (a.key === key) {
    assert.equal(a.profileId, current?'3956119':'3998446');
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
    authorization: current
      ?'User explicitly approved resuming the uncapped campaign with the longer two-minute wait, permanently skipping the last uncertain request and retaining its charge.'
      :'User requested resuming continuously overnight within the original $100 cap.',
  }, null, 2), {flag: 'wx'});
  console.log(JSON.stringify(retirement));
} finally { await pool.end(); }
