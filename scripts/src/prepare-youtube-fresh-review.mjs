// Catalog/coordinator reads and local sealing only. No paid dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {hundredSearchPlan} from './youtube-hundred-search-plan.mjs';
import {freshReviewPlan,FRESH_REVIEW_POLICY} from './youtube-fresh-review.mjs';
import {REVIEW_BATCH_POLICY} from './youtube-review-batch.mjs';
import {REPRESENTATION_VERSION} from './youtube-artist-representation.mjs';
import {boundedComparisonSchema,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {assertReviewBatchSchema,reviewBatchGlobalReadiness} from './youtube-review-batch-live.mjs';
import {searchReadiness} from './run-youtube-staged-search.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {modelQuote} from './run-youtube-saved-model-checks.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';

const args=process.argv.slice(2);
assert.equal(args.length,3);assert.ok(args.includes('--prepare-only'));
const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
const id=value('id'),sourceId=value('source-id');
assert.match(id??'',/^youtube-test-100-review-repr-[a-z0-9-]{4,55}$/);
assert.match(sourceId??'',/^youtube-batch-100-[a-z0-9-]{4,70}$/);
const root='generated-artifacts/'+id,sourceRoot='generated-artifacts/'+sourceId,sourceFiles={};
try{await fs.stat(root);assert.fail('Fresh destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
const read=async f=>{const bytes=await fs.readFile(f);sourceFiles[f]=digest(bytes);return JSON.parse(bytes);};
const source=await read(sourceRoot+'/plan.json');
assert.deepEqual(hundredSearchPlan(source),source);
const packets=[];
for(const child of source.children){
  const childRoot='generated-artifacts/'+child.id,p=await read(childRoot+'/plan.json');
  assert.equal(digest(p),child.planSha256);packets.push(...p.packets);
  for(const name of ['approval.json','run-started.json']){
    try{await fs.stat(childRoot+'/'+name);assert.fail('Search stage must remain unused');}
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
const artists=source.artists;
const selections=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
assertCurrentIdentityEligibility(selections,await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
const pool=await connectSavedBatchPool(),c=await pool.connect();let schemaSha;
try{
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const schema=await boundedComparisonSchema(c);assertReviewBatchSchema(schema);schemaSha=digest(schema);
  await boundedExperimentReadiness(c,{coordinatorSchemaSha256:schemaSha});
  await reviewBatchGlobalReadiness(c,{});await searchReadiness(c,artists,'full-tiers-1-5-no-youtube-uncapped');
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',[id])).rows[0].n,0);
  await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
const pricing=await modelQuote();await frozenFileVerifier(sourceFiles)();
await fs.mkdir(root);const runtimeFiles={};
for(const f of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-fresh-review.mjs'),root+'/runtime')){
  runtimeFiles['runtime/'+path.basename(f)]=digest(await fs.readFile(root+'/runtime/'+path.basename(f)));
}
const plan=freshReviewPlan({id,sourceRoot,version:REVIEW_BATCH_POLICY,
  freshPolicy:FRESH_REVIEW_POLICY,verificationPolicy:REPRESENTATION_VERSION,
  preparedAt:new Date().toISOString(),artists,packets,scopeSha256:digest(artists),
  catalogEvidenceSha256:digest(packets),coordinatorSchemaSha256:schemaSha,sourceFiles,runtimeFiles,pricing,
  maximumSpendCents:1000,maximumCalls:500,maximumCallsPerArtist:5,
  parallelism:16,providerIntervalMs:100,sourceReservedCents:0,experimentOnly:true,
  verificationScope:'Artist-facing representation with management explicitly unverified where applicable. Bound source references and existing wrong-artist/third-party/conflict safeguards remain required. Topic channels labeled separately. This batch does not activate a production acceptance policy.'});
await fs.writeFile(root+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
await frozenFileVerifier(sourceFiles)();
console.log(JSON.stringify({id,status:'prepared',artists:100,tiers:source.tiers,workers:16,
  totalCapCents:1000,planSha256:digest(plan),verificationPolicy:plan.verificationPolicy,
  paidCalls:0,catalogWrites:0}));
