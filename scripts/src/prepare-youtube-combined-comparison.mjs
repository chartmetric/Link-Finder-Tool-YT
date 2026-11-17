// Read-only preflight and sealing only. Never grants or spends an approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {combinedOperation,combinedComparisonPlan,COMBINED_COMPARISON_POLICY,
  priorCombinedSnapshot,rejectCombinedReplay,combinedReadiness} from './youtube-combined-comparison.mjs';
import {COMBINED_OWNERSHIP_VERSION} from './youtube-combined-ownership.mjs';
import {comparisonPlan,comparisonResult} from './youtube-ownership-comparison.mjs';
import {modelQuote,checkModelQuote,liveSavedModelCatalog} from './run-youtube-saved-model-checks.mjs';
import {savedModelClaims} from './youtube-saved-model-gate.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';

export async function prepareCombinedComparison(){
  const id='youtube-combined-comparison-13-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh preparation destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceFiles={},read=async name=>{
    const bytes=await fs.readFile(name);sourceFiles[name]=digest(bytes);return JSON.parse(bytes);
  };
  const draftPath='generated-artifacts/youtube-combined-ownership-offline-13-2026-11-17/proposal.json';
  const draft=await read(draftPath);assert.equal(draft.version,COMBINED_OWNERSHIP_VERSION);
  assert.equal(draft.summary.newModelAnswers,0);assert.equal(draft.summary.executable,false);
  assert.equal(draft.proposals.length,13);Object.assign(sourceFiles,draft.sourceFiles);
  const source=draft.source,previous=await read(source+'/plan.json');
  assert.deepEqual(comparisonPlan(previous),previous);
  const priorApproval=await read(source+'/approval.json'),results=await read(source+'/results.json');
  const summary=await read(source+'/summary.json');
  assert.equal(priorApproval.planSha256,digest(previous));
  assert.equal(summary.status,'completed');assert.equal(summary.returnedCalls,13);
  assert.equal(results.length,13);
  const current=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(previous.selections));
  const selections=[],deferred=[];
  for(const selection of previous.selections){
    const row=current.find(r=>String(r.profile_id)===selection.profileId);
    if(!row){deferred.push({...selection,reason:'Current Tier 1–5 eligibility not confirmed'});continue;}
    const refreshed={...selection,tier:Number(row.tier)};
    assertCurrentIdentityEligibility([refreshed],[row]);selections.push(refreshed);
  }
  const pool=await connectSavedBatchPool(),client=await pool.connect();
  let priorBoundedLedgerSnapshot,coordinatorSchemaSha256;const operations=[];
  try{
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15000'");
    priorBoundedLedgerSnapshot=await priorCombinedSnapshot(client,previous.groups.map(g=>g.id));
    assert.equal(priorBoundedLedgerSnapshot.runs.length,previous.groups.length);
    assert.equal(priorBoundedLedgerSnapshot.admissions.length,previous.operations.length);
    for(const group of previous.groups){
      const row=priorBoundedLedgerSnapshot.runs.find(r=>r.id===group.id);assert.ok(row);
      assert.deepEqual(row,{id:group.id,status:'completed',
        scope_sha256:digest({group,approval:priorApproval,runtimeFiles:previous.runtimeFiles}),
        cap_cents:group.maximumSpendCents,reserved_cents:group.operations.length*2});
    }
    for(const old of previous.operations){
      if(!selections.some(s=>s.profileId===old.profileId&&s.cmArtist===old.cmArtist))continue;
      const candidate=draft.proposals.find(p=>p.profileId===old.profileId&&p.cmArtist===old.cmArtist&&p.channelId===old.channelId);
      assert.ok(candidate);assert.equal(candidate.previousRequestSha256,old.inputSha256);
      const group=previous.groups.find(g=>g.operations.some(o=>o.key===old.key));assert.ok(group);
      const folder=source+'/part-'+(group.groupIndex+1);
      assert.deepEqual(await read(folder+'/plan.json'),group);
      const receipt=await read(folder+'/receipts/'+digest(old.key)+'.json');
      assert.equal(receipt.approvalSha256,digest(priorApproval));
      assert.equal(receipt.rawPath,'receipts/'+digest(old.key)+'.raw');
      const rawPath=folder+'/'+receipt.rawPath,raw=await fs.readFile(rawPath);sourceFiles[rawPath]=digest(raw);
      const admission=priorBoundedLedgerSnapshot.admissions.find(a=>a.run_id===group.id&&a.operation_key===old.key);
      assert.ok(admission);assert.equal(admission.receipt_sha256,digest(receipt));
      const result=results.find(r=>r.profileId===old.profileId&&r.cmArtist===old.cmArtist&&r.channelId===old.channelId);
      assert.deepEqual(comparisonResult(previous,old,receipt,raw),result);
      assert.deepEqual(candidate.baseline,result);assert.equal(candidate.newModelAnswer,null);
      assert.deepEqual(candidate.proposal.originalOperation,old.baseline.operation);
      assert.deepEqual(candidate.proposal.originalCapture,old.baseline.capture);
      const op=combinedOperation(candidate.proposal,result,old.baseline.admission,admission);
      for(const field of ['artist','candidate','evidenceNavigation'])
        assert.deepEqual(op.request.body.state[field],old.request.body.state[field]);
      operations.push(op);
    }
    assert.ok(operations.length,'No currently eligible comparison cases');
    operations.sort((a,b)=>selections.find(s=>s.profileId===a.profileId).tier-
      selections.find(s=>s.profileId===b.profileId).tier);
    coordinatorSchemaSha256=digest(await boundedComparisonSchema(client));
    await combinedReadiness(client,{...previous,priorBoundedLedgerSnapshot,coordinatorSchemaSha256});
    await rejectCombinedReplay(client,operations);
    const live=liveSavedModelCatalog({selections});
    for(const op of operations){await mixedHistoricalClaims(client,savedModelClaims(op));await live(op);}
    assert.equal((await client.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id LIKE $1',
      [id+'-part-%'])).rows[0].n,0);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  const pricing=await modelQuote();checkModelQuote(pricing,previous.pricing);
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-combined-comparison.mjs'),root+'/runtime'),runtimeFiles={};
  for(const name of modules){
    const relative='runtime/'+path.basename(name);runtimeFiles[relative]=digest(await fs.readFile(root+'/'+relative));
  }
  const plan=deepFreeze(combinedComparisonPlan({version:COMBINED_COMPARISON_POLICY,id,preparedAt:new Date().toISOString(),
    operations,selections,deferred,sourceFiles,runtimeFiles,pricing,priorBoundedLedgerSnapshot,
    baselineLedgerSnapshot:previous.baselineLedgerSnapshot,failedLaunch:previous.failedLaunch,coordinatorSchemaSha256,
    maximumSpendCents:operations.length*2,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))}));
  const save=(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const preparation={id,status:'prepared_not_approved',checks:operations.length,questionsPerRequest:1,
    spendingAllowanceCents:plan.maximumSpendCents,planSha256:digest(plan),maximumRequestBytes:plan.maximumRequestBytes,
    publishedInputUsdPerMillionTokens:Number(pricing.promptUsdPerToken)*1e6,
    byteBasedPlanningEstimateUsd:operations.reduce((n,o)=>n+o.requestBytes,0)*5*Number(pricing.promptUsdPerToken),
    estimateCaveat:'Five billed tokens per body byte is an unmeasured conservative planning assumption, not a provider-enforced ceiling.',
    bothBaselinesReceiptBound:true,fullEvidencePreserved:true,existingBoundedCoordinator:true,
    approvalWritten:false,ledgerWrites:0,schemaChanges:0,paidCalls:0,catalogWrites:0,
    providerEnforcedDollarCeiling:false,baselineIsGroundTruth:false,accuracyImprovementMeasured:false,deferred,
    nextStep:'Fresh explicit spending approval for this exact plan; no old approvals may be reused.'};
  await save('preparation.json',preparation);
  await frozenFileVerifier(sourceFiles)();console.log(JSON.stringify(preparation));return preparation;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareCombinedComparison();
}
