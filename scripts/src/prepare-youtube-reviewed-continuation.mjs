// Saved response recovery + untouched suffix only; no ledger writes or paid calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedInput,reviewedCapturePlan,reviewedCaptureResult,reviewedRecoveryReadiness,
  rejectReviewedCaptureReplay} from './youtube-reviewed-test.mjs';
import {reviewedCatalogCheck} from './run-youtube-reviewed-captures.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

export async function prepareReviewedContinuation(){
  const sourceRoot='generated-artifacts/youtube-reviewed-test-captures-ready-2026-11-17';
  const id='youtube-reviewed-test-captures-six-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh continuation destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceFiles={},read=async name=>{
    const bytes=await fs.readFile(name);sourceFiles[name]=digest(bytes);return JSON.parse(bytes);
  };
  const sourcePlan=await read(sourceRoot+'/plan.json'),sourceApproval=await read(sourceRoot+'/approval.json');
  const marker=await read(sourceRoot+'/run-started.json');
  assert.equal(marker.planSha256,digest(sourcePlan));assert.equal(sourceApproval.planSha256,digest(sourcePlan));
  assert.deepEqual(await read(sourceRoot+'/part-1/plan.json'),sourcePlan.groups[0]);
  Object.assign(sourceFiles,sourcePlan.sourceFiles);
  for(const [name,sha] of Object.entries(sourcePlan.runtimeFiles))sourceFiles[sourceRoot+'/'+name]=sha;
  const first=sourcePlan.operations[0],folder=sourceRoot+'/part-1';
  const receiptPath=folder+'/receipts/'+digest(first.key)+'.json',receipt=await read(receiptPath);
  assert.equal(receipt.rawPath,'receipts/'+digest(first.key)+'.raw');
  assert.deepEqual((await fs.readdir(folder+'/receipts')).sort(),[digest(first.key)+'.json',digest(first.key)+'.raw'].sort());
  const rawPath=folder+'/'+receipt.rawPath,raw=await fs.readFile(rawPath);sourceFiles[rawPath]=digest(raw);
  const recovered=reviewedCaptureResult(sourcePlan,first,receipt,raw);
  const inputs=sourcePlan.inputs.map(i=>i.profileId!==first.profileId?i:
    reviewedInput({...i,capture:recovered.capture,sourceRefs:[...i.sourceRefs,receiptPath,rawPath]}));
  const operations=sourcePlan.operations.slice(1);assert.equal(operations.length,6);
  const pending=sourcePlan.selections.filter(s=>s.profileId!==first.profileId);
  const current=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(pending));
  const selections=pending.map(s=>({...s,tier:Number(current.find(r=>String(r.profile_id)===s.profileId)?.tier)}));
  assertCurrentIdentityEligibility(selections,current);
  const pool=await connectSavedBatchPool(),c=await pool.connect();let recovery,coordinatorSchemaSha256;
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");
    const runs=(await c.query(`SELECT id,status,scope_sha256,cap_cents,reserved_cents
      FROM youtube_discovery_test_runs WHERE id=$1`,[sourcePlan.groups[0].id])).rows;
    const rows=(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
      status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
      WHERE run_id=$1 ORDER BY operation_key`,[sourcePlan.groups[0].id])).rows;
    assert.equal(runs.length,1);assert.equal(rows.length,1);
    recovery={sourceRoot,sourcePlan,sourceApproval,sourceRun:runs[0],sourceAdmission:rows[0],
      receipt,rawBodyBase64:raw.toString('base64')};
    const prospective={...sourcePlan,id,inputs,operations,selections,maximumSpendCents:operations.length*2,recovery};
    await reviewedRecoveryReadiness(c,prospective);await rejectReviewedCaptureReplay(c,operations);
    const live=reviewedCatalogCheck(prospective);for(const op of operations)await live(op);
    coordinatorSchemaSha256=digest(await boundedComparisonSchema(c));
    assert.equal(coordinatorSchemaSha256,sourcePlan.coordinatorSchemaSha256);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-reviewed-captures.mjs'),root+'/runtime'),runtimeFiles={};
  for(const name of modules){const f='runtime/'+path.basename(name);runtimeFiles[f]=digest(await fs.readFile(root+'/'+f));}
  const plan=deepFreeze(reviewedCapturePlan({...sourcePlan,id,preparedAt:new Date().toISOString(),
    inputs,selections,operations,sourceFiles,runtimeFiles,coordinatorSchemaSha256,recovery,
    maximumSpendCents:operations.length*2}));
  const save=(name,v)=>fs.writeFile(root+'/'+name,JSON.stringify(v,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const preparation={id,status:'recovery_and_suffix_prepared_not_approved',savedResponsesToRecover:1,
    remainingCaptureRequests:operations.length,sourceReservedCents:2,remainingAllowanceCents:plan.maximumSpendCents,
    combinedAllowanceCents:sourcePlan.maximumSpendCents,planSha256:digest(plan),noSavedResponseReplay:true,
    retireSourceUnusedAllowanceFirst:true,modelsApproved:false,sourceFilesFrozen:true,
    schemaChanges:0,ledgerWrites:0,paidCalls:0,catalogWrites:0,channelClaimWrites:0,
    nextStep:'Fresh approval of transport-only recovery, retirement and the untouched six-request suffix within the original total allowance.'};
  await save('preparation.json',preparation);await frozenFileVerifier(sourceFiles)();
  console.log(JSON.stringify(preparation));return preparation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareReviewedContinuation();
}
