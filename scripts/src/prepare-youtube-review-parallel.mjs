// Free preparation of a speed-only continuation. No schema or paid-ledger writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewBatchPlan,approveReviewBatch} from './youtube-review-batch.mjs';
import {sourceSnapshot,validateSourceSnapshot,parallelPlan,validatedSourcePackets,
  fingerprintTree,assertParallelWorld,PARALLEL_REVIEW_POLICY,SOURCE_ID,SOURCE_ROOT,TARGET_ID,TARGET_ROOT}
  from './youtube-review-parallel.mjs';
import {boundedComparisonSchema,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {assertReviewBatchSchema} from './youtube-review-batch-live.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
assert.deepEqual(process.argv.slice(2),['--prepare-only']);
try{await fs.stat(TARGET_ROOT);assert.fail('Fresh continuation root required');}catch(e){if(e.code!=='ENOENT')throw e;}
const read=async f=>JSON.parse(await fs.readFile(f));
const sourcePlan=await read(SOURCE_ROOT+'/plan.json'),sourceApproval=await read(SOURCE_ROOT+'/approval.json');
assert.deepEqual(reviewBatchPlan(sourcePlan),sourcePlan);
assert.deepEqual(approveReviewBatch(sourcePlan,sourceApproval),sourceApproval);
const completedRecords=await read(SOURCE_ROOT+'/results.json');
const summary=await read(SOURCE_ROOT+'/summary.json');
assert.equal(summary.status,'stopped');assert.equal(summary.artistsProcessed,completedRecords.length);
const pool=await connectSavedBatchPool(),c=await pool.connect();let snapshot,schemaHash;
try{
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const schema=await boundedComparisonSchema(c);assertReviewBatchSchema(schema);schemaHash=digest(schema);
  await boundedExperimentReadiness(c,{coordinatorSchemaSha256:schemaHash});
  await assertParallelWorld(c,'');snapshot=await sourceSnapshot(c);
  validateSourceSnapshot(snapshot,sourcePlan);
  assert.equal(snapshot.run.reserved_cents,summary.reservedCents);
  const rows=(await c.query(`SELECT profile_id,cm_artist,status,candidates_json
    FROM youtube_discovery_test_results WHERE run_id=$1 ORDER BY profile_id`,[SOURCE_ID])).rows;
  assert.equal(rows.length,100);
  assert.equal(rows.filter(r=>r.status==='review_processed').length,completedRecords.length);
  for(const r of completedRecords){
    const db=rows.find(a=>a.profile_id===r.artist.profileId);
    assert.equal(db.cm_artist,r.artist.cmArtist);assert.equal(db.status,'review_processed');
    assert.deepEqual(db.candidates_json,r.candidates);
  }
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',[TARGET_ID])).rows[0].n,0);
  await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
const failedProfileIds=[...new Set(snapshot.admissions.filter(a=>a.http_status>=500).map(a=>a.profile_id))].sort();
const completed=new Set(completedRecords.map(r=>r.artist.profileId));
const remaining=sourcePlan.artists.filter(a=>!completed.has(a.profile_id)&&!failedProfileIds.includes(a.profile_id));
assert.ok(remaining.length>0);
const selections=remaining.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
assertCurrentIdentityEligibility(selections,
  await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
const files={...sourcePlan.sourceFiles};
await fingerprintTree(SOURCE_ROOT,files);
const pricing=await modelQuote();checkModelQuote(pricing,sourcePlan.pricing);
const input={...sourcePlan,id:TARGET_ID,preparedAt:new Date().toISOString(),sourceFiles:files,
  sourceId:SOURCE_ID,sourcePlan,sourcePlanSha256:digest(sourcePlan),sourceApproval,
  sourceSnapshot:snapshot,sourceSnapshotSha256:digest(snapshot),sourceReservedCents:snapshot.run.reserved_cents,
  remainingAllowanceCents:1000-snapshot.run.reserved_cents,totalSharedAllowanceCents:1000,
  completedRecords,failedProfileIds,parallelPolicy:PARALLEL_REVIEW_POLICY,parallelism:16,providerIntervalMs:100,
  pricing,coordinatorSchemaSha256:schemaHash,
  continuationPurpose:'Increase processors within the existing $10 total. Reuse exact acknowledged receipts, preserve completed artists, skip acknowledged server failures without retry, and process only the same cohort’s remaining artists. No additional spending authorization or live-link changes.'};
await validatedSourcePackets(input);await frozenFileVerifier(files)();
await fs.mkdir(TARGET_ROOT);
const runtimeFiles={};
for(const f of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-review-parallel.mjs'),TARGET_ROOT+'/runtime')){
  const name='runtime/'+path.basename(f);runtimeFiles[name]=digest(await fs.readFile(TARGET_ROOT+'/'+name));
}
const plan=parallelPlan(reviewBatchPlan({...input,runtimeFiles}));
await fs.writeFile(TARGET_ROOT+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
const preparation={id:TARGET_ID,status:'prepared',planSha256:digest(plan),parallelWorkers:16,
  completedArtistsKept:completedRecords.length,failedArtistsNotRetried:failedProfileIds.length,
  remainingArtists:remaining.length,priorReservedCents:plan.sourceReservedCents,
  maximumAdditionalReservedCents:Math.min(remaining.length*10,plan.remainingAllowanceCents),
  remainingOriginalAllowanceCents:plan.remainingAllowanceCents,totalSharedAllowanceCents:1000,
  paidRequests:0,ledgerWrites:0,catalogWrites:0};
await fs.writeFile(TARGET_ROOT+'/preparation.json',JSON.stringify(preparation,null,2),{flag:'wx'});
await frozenFileVerifier(files)();console.log(JSON.stringify(preparation));
