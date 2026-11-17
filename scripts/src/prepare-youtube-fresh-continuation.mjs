// Free, immutable continuation preparation. Saved acknowledgments are reused,
// never replayed; both generations share the original $10.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {freshReviewPlan,approveFreshReview} from './youtube-fresh-review.mjs';
import {sourceSnapshot,validatedSourcePackets,fingerprintTree} from './youtube-review-parallel.mjs';
import {boundedComparisonSchema,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {reviewBatchGlobalReadiness} from './youtube-review-batch-live.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';

const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
assert.equal(args.length,3);assert.ok(args.includes('--prepare-only'));
const id=value('id'),sourceId=value('source-id');
for(const s of [id,sourceId])assert.match(s??'',/^youtube-test-100-review-repr-[a-z0-9-]{4,55}$/);
assert.notEqual(id,sourceId);
const root='generated-artifacts/'+id,oldRoot='generated-artifacts/'+sourceId,files={};
try{await fs.stat(root);assert.fail('Fresh continuation root required');}catch(e){if(e.code!=='ENOENT')throw e;}
const read=async f=>{const bytes=await fs.readFile(f);files[f]=digest(bytes);return JSON.parse(bytes);};
const sourcePlan=await read(oldRoot+'/plan.json'),sourceApproval=await read(oldRoot+'/approval.json');
assert.deepEqual(freshReviewPlan(sourcePlan),sourcePlan);
assert.deepEqual(approveFreshReview(sourcePlan,sourceApproval),sourceApproval);
const summary=await read(oldRoot+'/summary.json'),completedRecords=await read(oldRoot+'/results.json');
assert.equal(summary.status,'stopped');assert.equal(summary.unreturnedRequests,0);
assert.equal(summary.artistsAccountedFor,completedRecords.length);
const pool=await connectSavedBatchPool(),c=await pool.connect();let snapshot;
try{
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(digest(await boundedComparisonSchema(c)),sourcePlan.coordinatorSchemaSha256);
  await boundedExperimentReadiness(c,sourcePlan);await reviewBatchGlobalReadiness(c,sourcePlan);
  snapshot=await sourceSnapshot(c,sourceId);
  assert.equal(snapshot.run.reserved_cents,summary.reservedCents);
  const saved=(await c.query(`SELECT profile_id,cm_artist,status,candidates_json
    FROM youtube_discovery_test_results WHERE run_id=$1 ORDER BY profile_id`,[sourceId])).rows;
  assert.equal(saved.length,100);
  assert.equal(saved.filter(r=>r.status==='review_processed'||r.status==='review_failed').length,completedRecords.length);
  for(const r of completedRecords){
    const row=saved.find(a=>a.profile_id===r.artist.profileId);
    assert.equal(row.cm_artist,r.artist.cmArtist);assert.deepEqual(row.candidates_json,r.candidates);
  }
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',[id])).rows[0].n,0);
  await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
const done=new Set(completedRecords.map(r=>r.artist.profileId)),remaining=sourcePlan.artists.filter(a=>!done.has(a.profile_id));
const selections=remaining.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
assertCurrentIdentityEligibility(selections,await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
const pricing=await modelQuote();checkModelQuote(pricing,sourcePlan.pricing);
await fingerprintTree(oldRoot,files);
const provisional=freshReviewPlan({...sourcePlan,id,preparedAt:new Date().toISOString(),continuation:true,
  continuationSourceRoot:oldRoot,sourceId,sourcePlan,sourceApproval,sourcePlanSha256:digest(sourcePlan),
  sourceSnapshot:snapshot,sourceSnapshotSha256:digest(snapshot),
  sourceReservedCents:snapshot.run.reserved_cents,completedRecords});
await validatedSourcePackets(provisional,{sourceId,sourceRoot:oldRoot});
const sourceFiles={...sourcePlan.sourceFiles,...files};await frozenFileVerifier(sourceFiles)();
await fs.mkdir(root);const runtimeFiles={};
for(const f of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-fresh-review.mjs'),root+'/runtime'))
  runtimeFiles['runtime/'+path.basename(f)]=digest(await fs.readFile(root+'/runtime/'+path.basename(f)));
const plan=freshReviewPlan({...provisional,sourceFiles,runtimeFiles});
await fs.writeFile(root+'/plan.json',JSON.stringify(plan),{flag:'wx'});
await frozenFileVerifier(sourceFiles)();
console.log(JSON.stringify({id,status:'prepared',retainedArtists:completedRecords.length,remainingArtists:remaining.length,
  priorReservedCents:plan.sourceReservedCents,totalSharedAllowanceCents:1000,
  maximumRemainingCents:1000-plan.sourceReservedCents,planSha256:digest(plan),
  paidCalls:0,databaseWrites:0,unknownCharges:0}));
