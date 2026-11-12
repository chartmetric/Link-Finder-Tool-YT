// Operator-only: explicit user-approved exception, never app startup code.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {patchExceptionRuntime} from './instagram-deferred-tier-exception.mjs';
import {trackPreparation} from './instagram-continuation-preparation.mjs';
assert.ok(process.argv.includes('--approved-stale-tier-exception'));
const root='generated-artifacts/instagram-tier-priority';
const parent=root+'/parallel-493d5352-9a7f-4d95-a88a-c78c42a8f960';
const load=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const phase=root+'/parallel-'+randomUUID(),runtime=phase+'/runtime';
await fs.mkdir(runtime,{recursive:true});
await trackPreparation(phase, async record => {
const scope=await load('generated-artifacts/instagram-tier-gap-investigation-2026-11-11/history-rows.json');
assert.ok(Array.isArray(scope));
assert.equal(scope.length,9404);
assert.ok(scope.every(a=>typeof a?.profile_id==='string' && /^[1-9]\d*$/.test(a.profile_id)));
assert.equal(new Set(scope.map(a=>a.profile_id)).size,9404);
// Bind reporting evidence before approval and sealed-runtime checks can fail.
// The observer independently checks membership in the approved frozen queue.
// This file is a request, not an approval or permission to launch work.
await fs.writeFile(phase+'/tier-exception-scope.json',JSON.stringify(scope),{flag:'wx'});
const prior=await load(parent+'/approval.json');
const oldCore=await import(pathToFileURL(path.resolve(parent+'/runtime/campaign-parallel-core.mjs')));
const {evidenceDigest:hash}=await import(pathToFileURL(path.resolve(parent+'/runtime/youtube-ownership-policy.mjs')));
const {connectSavedBatchPool}=await import(pathToFileURL(path.resolve(parent+'/runtime/instagram-saved-batch-gate.mjs')));
const queue=await load(root+'/queue.json'),approval=await load(root+'/approval.json');
assert.equal(approval.maximumSpendCents,null);
assert.equal(hash(approval),prior.approvalSha256);
assert.equal(hash(queue),prior.scopeSha256);
for(const [name,sha] of Object.entries(prior.runtimeFiles)){
  assert.equal(path.basename(name),name);
  const contents=await fs.readFile(parent+'/runtime/'+name,'utf8');
  assert.equal(hash(contents),sha);
  await fs.writeFile(runtime+'/'+name,contents,{flag:'wx'});
}
const patched=patchExceptionRuntime(await fs.readFile(runtime+'/campaign-parallel-adapters.mjs','utf8'),
  await fs.readFile(runtime+'/campaign-parallel-core.mjs','utf8'),scope);
await fs.writeFile(runtime+'/campaign-parallel-adapters.mjs',patched.adapter);
await fs.writeFile(runtime+'/campaign-parallel-core.mjs',patched.core);
await fs.symlink(path.resolve('scripts/node_modules'),runtime+'/node_modules','dir');
const runtimeFiles={};
for(const name of Object.keys(prior.runtimeFiles))runtimeFiles[name]=hash(await fs.readFile(runtime+'/'+name,'utf8'));
assert.deepEqual(Object.keys(runtimeFiles).filter(n=>runtimeFiles[n]!==prior.runtimeFiles[n]).sort(),
  ['campaign-parallel-adapters.mjs','campaign-parallel-core.mjs']);
const core=await import(pathToFileURL(path.resolve(runtime+'/campaign-parallel-core.mjs')));
const cfg=core.CAMPAIGNS.instagram;
const pool=await connectSavedBatchPool();
let initial;
try {
  const c=await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    initial=await core.ledgerProof(c,cfg);
    assert.equal(initial.run.status,'completed');
    await c.query('COMMIT');
  } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  console.log(JSON.stringify({stage:'verifying_saved_archive',paidCalls:0,phase}));
  await oldCore.verifyArchive(cfg,initial);
  const wanted=new Set(scope.map(a=>a.profile_id));
  const bindings=new Map(queue.map(a=>[a.profile_id,a]));
  const paid=new Set(initial.admissions.map(a=>a.profile_id));
  for(const a of initial.artists.filter(a=>wanted.has(a.profile_id))){
    assert.equal(a.status,'deferred');
    assert.equal(a.reason,'current_catalog_eligibility_or_identity_changed');
    assert.equal(paid.has(a.profile_id),false);
    assert.equal(a.cm_artist,bindings.get(a.profile_id)?.cm_artist);
    assert.equal(a.tier,Number(bindings.get(a.profile_id)?.tier));
  }
  assert.equal(initial.artists.filter(a=>wanted.has(a.profile_id)).length,9404);
  const priorPaid=(await pool.query(`SELECT DISTINCT profile_id FROM instagram_saved_batch_admissions
    WHERE profile_id=ANY($1::text[])`,[[...wanted]])).rows;
  // These identities must remain deferred, not replayed.
  const blocked=new Set(priorPaid.map(a=>a.profile_id));
  const requeue=[...wanted].filter(id=>!blocked.has(id));
  assert.ok(requeue.length);
  const c2=await pool.connect();
  try {
    await c2.query('BEGIN');
    await c2.query("SET LOCAL lock_timeout='5s'");
    await c2.query("SET LOCAL statement_timeout='30s'");
    await c2.query('SELECT id FROM instagram_priority_runs WHERE id=$1 FOR UPDATE',[cfg.id]);
    const fresh=await core.ledgerProof(c2,cfg);
    assert.deepEqual(fresh.proof,initial.proof,'Coordinator changed during verification');
    const updated=await c2.query(`UPDATE instagram_priority_artists
      SET status='queued',reason='approved_last_known_tier_exception',updated_at=now()
      WHERE campaign_id=$1 AND status='deferred' AND profile_id=ANY($2::text[])`,
      [cfg.id,requeue]);
    assert.equal(updated.rowCount,requeue.length);
    const after=await core.ledgerProof(c2,cfg);
    const manifest={...prior,at:new Date().toISOString(),before:after.proof,runtimeFiles,
      approvedBy:'User said still run them after explanation that 9,404 artists have one-day-older Tier 2–5 records. Scope-specific freshness exception under existing uncapped Instagram approval.',
      staleTierException:{scopeSha256:hash(scope),artists:9404,requeued:requeue.length,
        excludedPriorPaid:blocked.size,normalFreshnessPolicyUnchanged:true,
        recheckActiveIdentityAndCatalogInstagram:true},
      catalogRecovery:undefined};
    await fs.writeFile(phase+'/approval.json',JSON.stringify(manifest),{flag:'wx'});
    await fs.writeFile(phase+'/recovery-proof.json',JSON.stringify({before:initial.proof,
      after:after.proof,requeued:requeue,excludedPriorPaid:[...blocked],noPaidReplay:true,
      noCatalogWrites:true,paidCallsDuringPreparation:0}),{flag:'wx'});
    await c2.query('COMMIT');
  }catch(e){await c2.query('ROLLBACK');throw e;}finally{c2.release();}
  console.log(JSON.stringify({stage:'prepared',phase,requeued:requeue.length,excludedPriorPaid:blocked.size}));
  record('prepared');
} finally {await pool.end();}
record('launching');
const child=spawn(process.execPath,[runtime+'/campaign-parallel-resume.mjs',
  '--run-approved','--uncapped-approved',phase],{stdio:'inherit'});
const exit=await new Promise((resolve,reject)=>{child.once('error',reject);
  child.once('exit',(code,signal)=>resolve({code,signal}));});
if(exit.code!==0)throw Error('Continuation stopped; inspect saved diagnostics. No automatic replay.');
await fs.stat(phase+'/launched.json');
});
