// Read-only preparation; no approval, paid requests, claims or catalog writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedVerificationEvidence,reviewedVerificationOperation,reviewedVerificationPlan,
  reviewedVerificationSnapshot,reviewedVerificationReadiness,rejectReviewedVerificationReplay,
  REVIEWED_VERIFICATION_POLICY} from './youtube-reviewed-verification.mjs';
import {reviewedCaptureResult} from './youtube-reviewed-test.mjs';
import {modelQuote} from './run-youtube-saved-model-checks.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

export async function prepareReviewedVerification(){
  const id='youtube-reviewed-verification-14-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh preparation destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceRoot='generated-artifacts/youtube-reviewed-test-captures-six-ready-2026-11-17';
  const sourceFiles={},read=async name=>{
    const bytes=await fs.readFile(name);sourceFiles[name]=digest(bytes);return JSON.parse(bytes);
  };
  const captureSourcePlan=await read(sourceRoot+'/plan.json'),captureSourceApproval=await read(sourceRoot+'/approval.json');
  Object.assign(sourceFiles,captureSourcePlan.sourceFiles);
  for(const [name,sha] of Object.entries(captureSourcePlan.runtimeFiles))sourceFiles[sourceRoot+'/'+name]=sha;
  const summary=await read(sourceRoot+'/summary.json'),results=await read(sourceRoot+'/results.json');
  assert.equal(summary.status,'completed');assert.equal(summary.returnedCalls,6);assert.equal(summary.modelCalls,0);
  assert.equal(results.length,6);
  const marker=await read(sourceRoot+'/run-started.json');assert.equal(marker.planSha256,digest(captureSourcePlan));
  const recovery=await read(sourceRoot+'/recovery.json');
  assert.equal(recovery.recoveredResponses,1);assert.equal(recovery.providerCalls,0);
  assert.equal(recovery.combinedAllowanceCents,14);
  assert.deepEqual(await read(sourceRoot+'/part-1/plan.json'),captureSourcePlan.groups[0]);
  const captureResponses=[];
  for(const op of captureSourcePlan.operations){
    const receipt=await read(sourceRoot+'/part-1/receipts/'+digest(op.key)+'.json');
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const rawPath=sourceRoot+'/part-1/'+receipt.rawPath,raw=await fs.readFile(rawPath);
    sourceFiles[rawPath]=digest(raw);
    assert.deepEqual(reviewedCaptureResult(captureSourcePlan,op,receipt,raw),
      results.find(r=>r.profileId===op.profileId&&r.channelId===op.channelId));
    captureResponses.push({operationKey:op.key,receipt,rawBodyBase64:raw.toString('base64')});
  }
  const evidence=reviewedVerificationEvidence(sourceRoot,captureSourcePlan,captureSourceApproval,captureResponses);
  const pending=evidence.inputs.map(i=>({profileId:i.profileId,cmArtist:i.cmArtist,artist:i.artist.name,tier:i.startingTier}));
  const current=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(pending));
  const selections=pending.map(s=>({...s,tier:Number(current.find(r=>String(r.profile_id)===s.profileId)?.tier)}));
  assertCurrentIdentityEligibility(selections,current);
  const operations=evidence.inputs.map(reviewedVerificationOperation)
    .sort((a,b)=>selections.find(s=>s.profileId===a.profileId).tier-selections.find(s=>s.profileId===b.profileId).tier);
  const pool=await connectSavedBatchPool(),c=await pool.connect();let coordinatorSchemaSha256;
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");
    const snapshot=await reviewedVerificationSnapshot(c,evidence.sourceLedgerSnapshot.runs.map(r=>r.id));
    assert.deepEqual(snapshot,evidence.sourceLedgerSnapshot);
    coordinatorSchemaSha256=digest(await boundedComparisonSchema(c));
    assert.equal(coordinatorSchemaSha256,captureSourcePlan.coordinatorSchemaSha256);
    await reviewedVerificationReadiness(c,{...evidence,coordinatorSchemaSha256});
    await rejectReviewedVerificationReplay(c,operations);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  const pricing=await modelQuote();await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-reviewed-verification.mjs'),root+'/runtime'),runtimeFiles={};
  for(const name of modules){const f='runtime/'+path.basename(name);runtimeFiles[f]=digest(await fs.readFile(root+'/'+f));}
  const plan=deepFreeze(reviewedVerificationPlan({id,version:REVIEWED_VERIFICATION_POLICY,
    preparedAt:new Date().toISOString(),sourceRoot,captureSourcePlan,captureSourceApproval,captureResponses,
    ...evidence,operations,selections,coordinatorSchemaSha256,pricing,sourceFiles,runtimeFiles,
    maximumSpendCents:28,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))}));
  const save=(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const preparation={id,status:'prepared_not_approved',examples:14,positiveFeedback:7,explicitRejections:7,
    model:'typesafe/jev-1.13',questionsPerRequest:1,spendingAllowanceCents:28,planSha256:digest(plan),
    maximumRequestBytes:plan.maximumRequestBytes,fullCapturedEvidencePreserved:true,
    labelsHiddenFromRequests:true,rawAssessmentsSeparateFromSafetyOverrides:true,
    abstentionsAreNotCorrectRejections:true,historicalFeedbackOnly:true,heldOut:false,
    ownershipAccuracyScorable:false,providerEnforcedDollarCeiling:false,
    budgetCaveat:'Two cents per request is a conservative local reservation, not a provider-enforced dollar ceiling. Invalid or excessive reported charges stop further requests.',
    approvalWritten:false,ledgerWrites:0,schemaChanges:0,paidCalls:0,newSearches:0,
    metadataCalls:0,catalogWrites:0,channelClaimWrites:0,labelsReadjudicated:false,
    nextStep:'Fresh explicit approval for the 14 exact Jev requests with a 28¢ allowance. No sourcing, metadata calls, retries, acceptance or catalog changes.'};
  await save('preparation.json',preparation);await frozenFileVerifier(sourceFiles)();
  console.log(JSON.stringify(preparation));return preparation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareReviewedVerification();
}
