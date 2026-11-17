// Read-only readiness and executor sealing; cannot grant execution permission.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {savedModelPlan,SAVED_MODEL_POLICY} from './youtube-saved-verification-execution.mjs';
import {modelQuote,readSavedJson,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {savedModelReadiness,savedModelClaims} from './youtube-saved-model-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';
import {savedBatchCapture} from './youtube-saved-batch-verification.mjs';
export async function prepareSavedModels(){
  const id='youtube-saved-model-checks-500-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh executor destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceProposalPath='generated-artifacts/youtube-saved-batch-verification-500-ready-2026-11-17/plan.json';
  const bytes=await fs.readFile(sourceProposalPath),source=deepFreeze(JSON.parse(bytes));
  assert.equal(source.executable,false);assert.equal(source.modelCallsExecuted,0);
  await frozenFileVerifier(source.sourceFiles)();
  const quote=await modelQuote();
  checkModelQuote(quote,{id:'typesafe/jev-1.13',promptUsdPerToken:'0.000000042',contextTokens:262144});
  const original=source.operations.map(op=>({profileId:op.profileId,cmArtist:op.cmArtist,
    artist:op.request.body.state.artist.name,tier:source.assessments.find(a=>a.profileId===op.profileId).tier}));
  const rows=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(original));
  const selections=[],deferred=[];
  for(const s of original){
    const r=rows.find(r=>String(r.profile_id)===s.profileId);
    if(!r){deferred.push({...s,reason:'Not present in current Tier 1–5 eligibility; no paid request'});continue;}
    const refreshed={...s,tier:Number(r.tier)};assert.ok([1,2,3,4,5].includes(refreshed.tier));
    assertCurrentIdentityEligibility([refreshed],[r]);selections.push(refreshed);
  }
  let operations=source.operations.filter(op=>selections.some(s=>s.profileId===op.profileId));
  const pool=await connectSavedBatchPool(),c=await pool.connect();
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");
    const prior=[];
    for(const table of ['youtube_video_identity_admissions','youtube_link_campaign_admissions','youtube_bounded_test_admissions']){
      const found=(await c.query(`SELECT profile_id FROM ${table} WHERE kind='model' AND profile_id=ANY($1::text[])`,
        [operations.map(o=>o.profileId)])).rows;prior.push(...found.map(r=>String(r.profile_id)));
    }
    const identities=(await c.query(`SELECT profile_id,cm_artist,channel_id FROM youtube_video_identity_admissions
      WHERE kind='model' AND (profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[]) OR channel_id=ANY($3::text[]))`,
    [operations.map(o=>o.profileId),operations.map(o=>o.cmArtist),operations.map(o=>o.channelId)])).rows;
    const keep=[];
    for(const op of operations){
      if(prior.includes(op.profileId)||identities.some(r=>r.profile_id===op.profileId||r.cm_artist===op.cmArtist||r.channel_id===op.channelId))
        deferred.push({...original.find(s=>s.profileId===op.profileId),reason:'Existing model allocation; will not repeat'});
      else keep.push(op);
    }
    operations=keep;
    const claims=operations.flatMap(savedModelClaims);
    await mixedHistoricalClaims(c,claims);
    const linked=await catalogLinkedYoutubeClaims(claims,select);
    assertNoNewIdentityClaims(claims,linked.map(r=>({alias:returnedYoutubeUrl(r.account_url)??'',
      channelId:returnedYoutubeUrl(r.account_url)?.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
      profileId:String(r.profile_id),cmArtist:String(r.cm_artist)})));
    await savedModelReadiness(c,{groups:[],maximumSpendCents:operations.length*2},source);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
  assert.ok(operations.length);
  // Preserve the user's higher-tier-first priority without changing any
  // previously prepared request body or artist/channel identity.
  operations.sort((a,b)=>selections.find(s=>s.profileId===a.profileId).tier-
    selections.find(s=>s.profileId===b.profileId).tier);
  const capturePackets={};
  for(const op of operations){
    const candidates=Object.keys(source.sourceFiles).filter(f=>f.endsWith('/receipts/'+digest(op.captureOperationKey)+'.json'));
    let found=null;
    for(const name of candidates){
      const receiptBytes=await fs.readFile(name),receipt=JSON.parse(receiptBytes);
      if(receipt.runId!==op.captureRunId)continue;
      assert.equal(found,null,'Ambiguous original channel packet');
      const folder=path.dirname(path.dirname(name));
      const group=await readSavedJson(folder+'/plan.json'),approval=await readSavedJson(folder+'/approval.json');
      const operation=group.operations.find(o=>o.key===op.captureOperationKey);assert.ok(operation);
      const row=source.sourceLedgerSnapshot.admissions.find(r=>r.run_id===op.captureRunId&&r.operation_key===op.captureOperationKey);
      const raw=await fs.readFile(path.dirname(name)+'/'+path.basename(name,'.json')+'.raw');
      found=savedBatchCapture({group,approval,operation,row,receipt,raw,receiptBytes}).capture;
    }
    assert.ok(found,'Original paid capture must be restored without a new request');capturePackets[op.key]=found;
  }
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-saved-model-checks.mjs'),root+'/runtime'),runtimeFiles={};
  for(const f of modules){const n='runtime/'+path.basename(f);runtimeFiles[n]=digest(await fs.readFile(root+'/'+n));}
  const plan=deepFreeze(savedModelPlan({version:SAVED_MODEL_POLICY,id,preparedAt:new Date().toISOString(),
    sourceProposalPath,sourceProposalSha256:digest(source),sourceProposalFileSha256:digest(bytes),
    operations,capturePackets,selections:selections.filter(s=>operations.some(op=>op.profileId===s.profileId)),deferred,
    maximumSpendCents:operations.length*2,maximumRequestBytes:Math.max(...operations.map(op=>op.requestBytes)),
    pricing:quote,runtimeFiles}));
  assert.equal(digest(await fs.readFile(sourceProposalPath)),plan.sourceProposalFileSha256);
  const save=(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const fullBodyBytes=operations.reduce((n,o)=>n+o.requestBytes,0);
  const summary={id,status:'prepared_not_approved',verificationChecks:operations.length,
    spendingAllowanceCents:plan.maximumSpendCents,automaticGroups:plan.groups.length,
    maximumRequestBytes:plan.maximumRequestBytes,fullBodyBytes,publishedInputUsdPerMillionTokens:Number(quote.promptUsdPerToken)*1e6,
    byteBasedPlanningEstimateUsd:fullBodyBytes*4*Number(quote.promptUsdPerToken),
    estimateCaveat:'Planning estimate assumes up to four billed tokens per serialized body byte across the three questions; not a measured token count or provider-enforced ceiling.',
    model:'typesafe/jev-1.13',sourceRequestsUnchanged:true,deferred,
    providerDollarCeiling:false,noPaidCalls:true,ledgerWrites:0,catalogWrites:0,
    requiresExplicitSpendingApproval:true,planSha256:digest(plan)};
  await save('preparation.json',summary);console.log(JSON.stringify(summary));return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareSavedModels();
}
