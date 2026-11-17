// Preparation only. Read-only catalog/ledger checks; zero paid calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeChannelReviews} from './youtube-channel-review-decisions.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {reviewedInput,reviewedCohort,reviewedCaptureOperation,reviewedCapturePlan,
  rejectReviewedCaptureReplay,REVIEWED_TEST_POLICY} from './youtube-reviewed-test.mjs';
import {reviewedCatalogCheck} from './run-youtube-reviewed-captures.mjs';
import {boundedComparisonSchema,boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

export async function prepareReviewedTest(){
  const id='youtube-reviewed-test-captures-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh preparation destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceFiles={},cache=new Map();
  const bytes=async f=>{const b=await fs.readFile(f);sourceFiles[f]=digest(b);return b;};
  const read=async f=>{if(!cache.has(f))cache.set(f,JSON.parse(await bytes(f)));return cache.get(f);};
  const reviewPath='generated-artifacts/youtube-channel-results-100-user-reviewed-2026-11-16/review.json';
  const reviewed=await read(reviewPath),originalReviewed=await bytes(reviewed.source);
  assert.equal(digest(originalReviewed),reviewed.sourceSha256);
  const all=reviewed.results.filter(r=>!r.savedHeld&&r.conflicts.length===0&&r.userReview.status==='looks_correct');
  const positive=[...all.filter(r=>r.channelType!=='topic').slice(0,6),...all.filter(r=>r.channelType==='topic').slice(0,2)];
  assert.equal(positive.length,8);
  let inputs=[],grading=[];
  for(const row of positive){
    const source='generated-artifacts/'+row.sourceRunId,p=await read(source+'/plan.json');
    const a=p.artists.find(a=>a.profileId===row.profileId&&a.cmArtist===row.cmArtist);assert.ok(a);
    const op=p.operations.find(o=>o.profileId===row.profileId&&o.cmArtist===row.cmArtist);assert.ok(op);
    const approval=await read(source+'/approval.json');
    const receiptPath=source+'/receipts/'+digest(op.key)+'.json',receipt=await read(receiptPath);
    assert.equal(receipt.runId,p.id);assert.equal(receipt.planSha256,digest(p));
    assert.equal(receipt.approvalSha256,digest(approval));assert.deepEqual(receipt.request,op.request);
    assert.equal(digest(receipt),row.receiptSha256);
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const raw=await bytes(source+'/'+receipt.rawPath);assert.equal(digest(raw),row.rawSha256);
    assert.equal(digest(raw),receipt.rawBodySha256);
    const capture=normalizeYoutubeChannel({...receipt,at:receipt.capturedAt,data:JSON.parse(raw)},row.youtubeUrl);
    assert.deepEqual(capture.body,row.capture.body);
    const input=reviewedInput({artist:a,url:row.youtubeUrl,capture,sourceObservedAt:receipt.capturedAt,
      sourceRefs:[source+'/plan.json',receiptPath,source+'/'+receipt.rawPath],startingTier:row.startingTier});
    inputs.push(input);grading.push({caseId:input.caseId,userFeedback:'looks_correct',
      feedbackStrength:'batch_looks_correct_not_individual_ownership_adjudication',
      statement:row.userReview.statement,recordedAt:row.userReview.recordedAt,
      labelScope:'historical_user_feedback',ownershipAdjudication:null,
      sourceRefs:[reviewPath],catalogWritesAuthorized:false});
  }
  const videoRoot='generated-artifacts/youtube-video-review-staged-twenty-2026-11-13';
  const videoPlan=await read(videoRoot+'/plan.json'),videoApproval=await read(videoRoot+'/approval.json');
  const negativeIds=['3841420','230803','257398','3547423','3779209','3550422','290069','3568519'];
  const saved=[];
  for(const name of (await fs.readdir(videoRoot+'/results')).filter(n=>n.endsWith('.json')))
    saved.push({path:videoRoot+'/results/'+name,value:await read(videoRoot+'/results/'+name)});
  const reviewSnapshot={source:'scripts/src/youtube-channel-review-decisions.mjs',
    sourceSha256:digest(await fs.readFile('scripts/src/youtube-channel-review-decisions.mjs')),
    reviews:youtubeChannelReviews};
  for(const profileId of negativeIds){
    const label=youtubeChannelReviews.filter(r=>r.profileId===profileId).at(-1);assert.ok(label);
    const found=saved.find(x=>x.value.profileId===profileId&&x.value.cmArtist===label.cmArtist&&x.value.url===label.url);
    assert.ok(found,'Missing saved uploader evidence for reviewed pair');
    const v=found.value,evidencePath=videoRoot+'/evidence/'+profileId+'.json',evidence=await read(evidencePath);
    const receipt=v.rawReceipt,op=videoPlan.operations.find(o=>o.key===receipt.operationKey);assert.ok(op);
    assert.equal(receipt.profileId,profileId);assert.equal(receipt.cmArtist,label.cmArtist);
    assert.equal(receipt.planSha256,digest(videoPlan));assert.deepEqual(receipt.request,op.request);
    assert.equal(videoApproval.planSha256,digest(videoPlan));
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const raw=await bytes(videoRoot+'/'+receipt.rawPath);
    assert.equal(digest(raw),receipt.rawBodySha256);
    assert.equal(raw.toString('base64'),receipt.rawBodyBase64);
    // Never manufacture channel metadata from video-level uploader information.
    const input=reviewedInput({artist:evidence.artist,url:label.url,sourceObservedAt:receipt.capturedAt,
      startingTier:v.tier,sourceRefs:[evidencePath,found.path,videoRoot+'/'+receipt.rawPath]});
    inputs.push(input);grading.push({caseId:input.caseId,userFeedback:'rejected',
      feedbackStrength:'explicit_artist_channel_pair_rejection',statement:label.reason,recordedAt:null,
      labelScope:'historical_user_feedback',ownershipAdjudication:null,
      sourceRefs:[root+'/review-source.json'],catalogWritesAuthorized:false});
  }
  reviewedCohort(inputs,grading);
  const proposed=inputs.filter(i=>!i.channelCaptureAvailable).map(reviewedCaptureOperation);
  const pending=proposed.map(op=>{
    const input=inputs.find(i=>i.profileId===op.profileId);
    return {profileId:op.profileId,cmArtist:op.cmArtist,artist:input.artist.name,tier:input.startingTier};
  });
  const rows=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(pending));
  const eligible=new Set(rows.map(r=>String(r.profile_id)));
  const deferred=pending.filter(s=>!eligible.has(s.profileId)).map(s=>({...s,
    reason:'Current global Tier 1–5 record not confirmed; no paid capture authorized'}));
  const keptNegative=inputs.filter(i=>!i.channelCaptureAvailable&&eligible.has(i.profileId));
  assert.ok(keptNegative.length>=2);
  const topics=inputs.filter(i=>i.channelCaptureAvailable&&/[-–—]\s*topic$/iu.test(i.capture.body.displayName)).slice(0,2);
  const keptPositive=[...inputs.filter(i=>i.channelCaptureAvailable&&!topics.includes(i))
    .slice(0,keptNegative.length-topics.length),...topics];
  const keep=new Set([...keptPositive,...keptNegative].map(i=>i.caseId));
  const heldOut=inputs.filter(i=>!keep.has(i.caseId)).map(i=>({input:i,
    reason:deferred.some(d=>d.profileId===i.profileId)?'Current tier not confirmed':'Unused to keep the diagnostic balanced'}));
  inputs=inputs.filter(i=>keep.has(i.caseId));grading=grading.filter(g=>keep.has(g.caseId));
  const cohort=reviewedCohort(inputs,grading),operations=keptNegative.map(reviewedCaptureOperation);
  const selections=pending.filter(s=>eligible.has(s.profileId)).map(s=>({...s,
    tier:Number(rows.find(r=>String(r.profile_id)===s.profileId).tier)}));
  assertCurrentIdentityEligibility(selections,rows);
  const pool=await connectSavedBatchPool(),c=await pool.connect();let coordinatorSchemaSha256;
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");
    coordinatorSchemaSha256=digest(await boundedComparisonSchema(c));
    await boundedExperimentReadiness(c,{coordinatorSchemaSha256});
    await rejectReviewedCaptureReplay(c,operations);
    const live=reviewedCatalogCheck({selections});for(const op of operations)await live(op);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  await fs.mkdir(root);const save=(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  for(const [name,value] of [['inputs.json',inputs],['grading.json',grading],
    ['held-out.json',heldOut],['review-source.json',reviewSnapshot]]){
    await save(name,value);sourceFiles[root+'/'+name]=digest(await fs.readFile(root+'/'+name));
  }
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-reviewed-captures.mjs'),root+'/runtime'),runtimeFiles={};
  for(const name of modules){const f='runtime/'+path.basename(name);runtimeFiles[f]=digest(await fs.readFile(root+'/'+f));}
  const plan=deepFreeze(reviewedCapturePlan({id,version:REVIEWED_TEST_POLICY,preparedAt:new Date().toISOString(),
    inputs,grading,selections,operations,sourceFiles,runtimeFiles,coordinatorSchemaSha256,deferred,
    maximumSpendCents:operations.length*2}));
  await save('plan.json',plan);
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const table=[['artist','starting_tier','profile_id','cm_artist','youtube_url','user_feedback',
    'channel_capture_available','topic_label','review_scope']];
  for(const input of inputs)table.push([input.artist.name,input.startingTier,input.profileId,input.cmArtist,input.url,
    grading.find(g=>g.caseId===input.caseId).userFeedback,input.channelCaptureAvailable,
    /[-–—]\s*topic$/iu.test(input.capture?.body.displayName??'')?'Topic — auto-generated':'Not established',
    'Historical user feedback, not verified ownership']);
  await fs.writeFile(root+'/examples.csv','\ufeff'+table.map(row=>row.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  const preparation={id,status:'capture_stage_prepared_not_approved',...cohort.summary,
    channelCaptureAllowanceCents:plan.maximumSpendCents,modelStagePlanningAllowanceCents:inputs.length*2,
    modelStageApproved:false,modelStageExecutable:false,planSha256:digest(plan),
    sourceFilesFrozen:true,coordinatorVerified:true,schemaChanges:0,ledgerWrites:0,catalogWrites:0,
    paidCalls:0,approvalWritten:false,currentLabelsReadjudicated:false,deferred,
    nextStep:`Approve only the ${operations.length} missing channel captures for ${plan.maximumSpendCents}¢. Prepare and approve the blinded model requests after capture, without refreshing user labels or scoring ownership accuracy.`};
  await save('preparation.json',preparation);await frozenFileVerifier(sourceFiles)();
  console.log(JSON.stringify(preparation));return preparation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareReviewedTest();
}
