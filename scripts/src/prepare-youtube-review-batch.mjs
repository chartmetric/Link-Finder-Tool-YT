// Free catalog/coordinator reads and local sealing only. No provider dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {hundredSearchPlan} from './youtube-hundred-search-plan.mjs';
import {REVIEW_BATCH_POLICY,reviewBatchPlan} from './youtube-review-batch.mjs';
import {reviewBatchGlobalReadiness,assertReviewBatchSchema} from './youtube-review-batch-live.mjs';
import {boundedComparisonSchema,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {searchReadiness} from './run-youtube-staged-search.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {modelQuote} from './run-youtube-saved-model-checks.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

const args=process.argv.slice(2);
assert.ok(args.includes('--prepare-only')&&args.length<=2);
assert.ok(args.every(a=>a==='--prepare-only'||/^--id=youtube-test-100-review-[a-z0-9-]{4,65}$/.test(a)));
const id=args.find(a=>a.startsWith('--id='))?.slice(5)??'youtube-test-100-review-e2e-2026-11-17';
const root='generated-artifacts/'+id;
try{await fs.stat(root);assert.fail('Fresh output required');}catch(e){if(e.code!=='ENOENT')throw e;}
const sourceRoot='generated-artifacts/youtube-batch-100-review-2026-11-17',sourceFiles={};
const priorZeroSpendIds=['youtube-review-100-e2e-2026-11-17','youtube-review-100-e2e-2026-11-17-launch2'];
for(const priorZeroSpendId of priorZeroSpendIds){
  const priorRoot='generated-artifacts/'+priorZeroSpendId;
  for(const name of ['plan.json','approval.json']){
    const f=priorRoot+'/'+name,bytes=await fs.readFile(f);sourceFiles[f]=digest(bytes);
  }
  for(const name of ['admissions.jsonl','summary.json']){
    try{await fs.stat(priorRoot+'/'+name);assert.fail('Prior launch must have stopped before execution');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  try{
    const marker=priorRoot+'/run-started.json',bytes=await fs.readFile(marker);sourceFiles[marker]=digest(bytes);
    assert.equal(JSON.parse(bytes).planSha256,
      digest(JSON.parse(await fs.readFile(priorRoot+'/plan.json'))));
  }catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of ['receipts','inputs']){
    try{assert.equal((await fs.readdir(priorRoot+'/'+name)).length,0,'Prior launch dispatched work');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
const sourceBytes=await fs.readFile(sourceRoot+'/plan.json'),source=JSON.parse(sourceBytes);
sourceFiles[sourceRoot+'/plan.json']=digest(sourceBytes);assert.deepEqual(hundredSearchPlan(source),source);
for(const f of ['approval.json','run-started.json']){
  try{await fs.stat(sourceRoot+'/'+f);assert.fail('Source searches must remain unused');}catch(e){if(e.code!=='ENOENT')throw e;}
}
const artists=source.artists,packets=[];
for(const child of source.children){
  const f='generated-artifacts/'+child.id+'/plan.json',bytes=await fs.readFile(f),p=JSON.parse(bytes);
  assert.equal(digest(p),child.planSha256);sourceFiles[f]=digest(bytes);
  packets.push(...p.packets);
}
const selections=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
assertCurrentIdentityEligibility(selections,
  await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
const pool=await connectSavedBatchPool(),c=await pool.connect();let coordinatorSchemaSha256;
try{
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL statement_timeout='15000'");
  const schema=await boundedComparisonSchema(c);assertReviewBatchSchema(schema);
  coordinatorSchemaSha256=digest(schema);
  await boundedExperimentReadiness(c,{coordinatorSchemaSha256});
  await reviewBatchGlobalReadiness(c,{},'');
  await searchReadiness(c,artists,'full-tiers-1-5-no-youtube-uncapped');
  for(const priorZeroSpendId of priorZeroSpendIds){
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',
      [priorZeroSpendId])).rows[0].n,0);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE run_id=$1',
      [priorZeroSpendId])).rows[0].n,0);
  }
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',[id])).rows[0].n,0);
  const ids=artists.map(a=>a.profile_id),cms=artists.map(a=>a.cm_artist);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[])`,[ids,cms])).rows[0].n,0);
  await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
const pricing=await modelQuote();
await frozenFileVerifier(sourceFiles)();await fs.mkdir(root);
const runtimeFiles={};
for(const f of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-review-batch.mjs'),root+'/runtime')){
  const name='runtime/'+path.basename(f);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));
}
const plan=deepFreeze(reviewBatchPlan({id,version:REVIEW_BATCH_POLICY,preparedAt:new Date().toISOString(),
  artists,packets,scopeSha256:digest(artists),catalogEvidenceSha256:digest(packets),
  sourceFiles,runtimeFiles,coordinatorSchemaSha256,pricing,priorZeroSpendIds,maximumSpendCents:1000,maximumCalls:500,
  maximumCallsPerArtist:5}));
await fs.writeFile(root+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
const preparation={id,status:'prepared',artists:100,tiers:source.tiers,overallAllowanceCents:1000,
  maximumCalls:500,maximumCallsPerArtist:5,planSha256:digest(plan),
  paidCalls:0,databaseWrites:0,catalogWrites:0,approvalWritten:false,
  sequentialEndToEndPerArtist:true,newBulkAcceptanceEnabled:false};
await fs.writeFile(root+'/preparation.json',JSON.stringify(preparation,null,2),{flag:'wx'});
await frozenFileVerifier(sourceFiles)();console.log(JSON.stringify(preparation));
