// Read-only preflight plus sealing. This command never grants paid approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {comparisonOperation,comparisonPlan,COMPARISON_POLICY,rejectComparisonReplay} from './youtube-ownership-comparison.mjs';
import {prepareOwnershipClarity} from './prepare-youtube-ownership-clarity.mjs';
import {modelQuote,checkModelQuote,readSavedJson,liveSavedModelCatalog} from './run-youtube-saved-model-checks.mjs';
import {savedModelResult} from './youtube-saved-verification-execution.mjs';
import {savedModelClaims} from './youtube-saved-model-gate.mjs';
import {boundedComparisonSchema,comparisonReadiness} from './youtube-ownership-comparison-gate.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';

export async function prepareComparison(){
  const id='youtube-ownership-comparison-13-bounded-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh preparation destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const source='generated-artifacts/youtube-saved-model-checks-500-ready-2026-11-17';
  const sourceFiles={},read=async name=>{
    const bytes=await fs.readFile(name);sourceFiles[name]=digest(bytes);return JSON.parse(bytes);
  };
  const baseline=await read(source+'/plan.json'),results=await read(source+'/results.json');
  const summary=await read(source+'/summary.json'),approval=await read(source+'/approval.json');
  assert.equal(summary.status,'completed');assert.equal(summary.returnedCalls,baseline.operations.length);
  assert.equal(approval.planSha256,digest(baseline));
  const failedSource='generated-artifacts/youtube-ownership-comparison-13-2026-11-17';
  const failedPlan=await read(failedSource+'/plan.json'),failedApproval=await read(failedSource+'/approval.json');
  const failedMarker=await read(failedSource+'/run-started.json');
  assert.equal(failedApproval.planSha256,digest(failedPlan));
  assert.equal(failedMarker.planSha256,digest(failedPlan));
  assert.deepEqual(await read(failedSource+'/part-1/plan.json'),failedPlan.groups[0]);
  assert.deepEqual(await fs.readdir(failedSource+'/part-1/receipts'),[]);
  const failedLaunch={id:failedPlan.groups[0].id,scopeSha256:digest(failedPlan.groups[0]),
    status:'stopped',reservedCents:0,admissions:0};
  const sourceDraft='generated-artifacts/youtube-ownership-clarity-13-ready-2026-11-17/proposal.json';
  const draft=await read(sourceDraft);
  // Fail rather than silently adopting question changes after the offline proposal.
  assert.deepEqual(await prepareOwnershipClarity(source),draft);
  const originals=baseline.operations.filter(o=>draft.proposals.some(p=>p.originalRequestSha256===o.inputSha256));
  assert.equal(originals.length,13);
  const selected=originals.map(o=>baseline.selections.find(s=>s.profileId===o.profileId&&s.cmArtist===o.cmArtist));
  const current=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selected));
  const selections=[],deferred=[];
  for(const s of selected){
    const row=current.find(r=>String(r.profile_id)===s.profileId);
    if(!row){deferred.push({...s,reason:'Current Tier 1–5 eligibility not confirmed; no paid comparison'});continue;}
    const refreshed={...s,tier:Number(row.tier)};
    assert.ok([1,2,3,4,5].includes(refreshed.tier));
    assertCurrentIdentityEligibility([refreshed],[row]);selections.push(refreshed);
  }
  const pool=await connectSavedBatchPool(),c=await pool.connect();
  let baselineLedgerSnapshot,coordinatorSchemaSha256;const operations=[];
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");
    baselineLedgerSnapshot=await sourceChannelSnapshot(c,baseline);
    assert.equal(baselineLedgerSnapshot.runs.length,baseline.groups.length);
    assert.equal(baselineLedgerSnapshot.admissions.length,baseline.operations.length);
    for(const g of baseline.groups){
      const row=baselineLedgerSnapshot.runs.find(r=>r.id===g.id);assert.ok(row);
      for(const [key,v] of Object.entries({status:'completed',plan_sha256:digest(g),approval_sha256:digest(approval),
        execution_sha256:digest(baseline.runtimeFiles),cap_cents:g.maximumSpendCents,
        reserved_cents:g.operations.length*2}))assert.equal(row[key],v);
    }
    for(const original of originals){
      if(!selections.some(s=>s.profileId===original.profileId))continue;
      const g=baseline.groups.find(g=>g.operations.some(o=>o.key===original.key));assert.ok(g);
      const folder=source+'/part-'+(g.groupIndex+1),group=await read(folder+'/plan.json');
      assert.deepEqual(group,g);
      const receipt=await read(folder+'/receipts/'+digest(original.key)+'.json');
      assert.equal(receipt.planSha256,digest(g));assert.equal(receipt.approvalSha256,digest(approval));
      assert.equal(receipt.runId,g.id);assert.equal(receipt.parentId,baseline.id);
      assert.equal(receipt.rawPath,'receipts/'+digest(original.key)+'.raw');
      const rawPath=folder+'/'+receipt.rawPath,raw=await fs.readFile(rawPath);sourceFiles[rawPath]=digest(raw);
      const row=baselineLedgerSnapshot.admissions.find(a=>a.run_id===g.id&&a.operation_key===original.key);assert.ok(row);
      assert.equal(digest(receipt),row.receipt_sha256);assert.equal(digest(raw),row.raw_sha256);
      assert.equal(digest(raw),receipt.rawBodySha256);
      const result=results.find(r=>r.profileId===original.profileId&&r.cmArtist===original.cmArtist);
      assert.deepEqual(savedModelResult(baseline,original,receipt,raw),result,'Original paid answer must exactly reconstruct');
      operations.push(comparisonOperation(original,baseline.capturePackets[original.key],result,row));
    }
    assert.ok(operations.length);
    operations.sort((a,b)=>selections.find(s=>s.profileId===a.profileId).tier-
      selections.find(s=>s.profileId===b.profileId).tier);
    coordinatorSchemaSha256=digest(await boundedComparisonSchema(c));
    await comparisonReadiness(c,{baselineLedgerSnapshot,failedLaunch,coordinatorSchemaSha256});
    await rejectComparisonReplay(c,operations);
    const live=liveSavedModelCatalog({selections});
    for(const op of operations){
      const claims=savedModelClaims(op);assert.ok(claims.length);
      await mixedHistoricalClaims(c,claims);await live(op);
    }
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  const pricing=await modelQuote();checkModelQuote(pricing,baseline.pricing);
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-ownership-comparison.mjs'),root+'/runtime'),runtimeFiles={};
  for(const name of modules){
    const f='runtime/'+path.basename(name);runtimeFiles[f]=digest(await fs.readFile(root+'/'+f));
  }
  const plan=deepFreeze(comparisonPlan({version:COMPARISON_POLICY,id,preparedAt:new Date().toISOString(),
    operations,selections,deferred,baselineLedgerSnapshot,sourceFiles,runtimeFiles,pricing,
    failedLaunch,coordinatorSchemaSha256,
    maximumSpendCents:operations.length*2,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))}));
  const save=(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const bodyBytes=operations.reduce((n,o)=>n+o.requestBytes,0);
  const preparation={id,status:'prepared_not_approved',checks:operations.length,
    spendingAllowanceCents:plan.maximumSpendCents,planSha256:digest(plan),maximumRequestBytes:plan.maximumRequestBytes,
    publishedInputUsdPerMillionTokens:Number(pricing.promptUsdPerToken)*1e6,
    byteBasedPlanningEstimateUsd:bodyBytes*5*Number(pricing.promptUsdPerToken),
    estimateCaveat:'Five billed tokens per body byte is a conservative planning assumption for four questions, not a measured token count or a provider-enforced billing ceiling.',
    baselineReconstructedFromPaidReceipts:true,sourceFilesFrozen:true,oldApprovalsUnchanged:true,
    failedLaunchConfirmedUnspent:true,existingBoundedCoordinator:true,schemaChanges:0,
    ledgerWrites:0,paidCalls:0,catalogWrites:0,providerEnforcedDollarCeiling:false,deferred,
    nextStep:'Fresh explicit approval of this exact comparison and spending allowance; do not rerun the historical baseline.'};
  await save('preparation.json',preparation);
  await frozenFileVerifier(sourceFiles)();
  console.log(JSON.stringify(preparation));return preparation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareComparison();
}
