// Read-only readiness checks and sealing. No paid calls or authorization.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedVerificationResult,reviewedVerificationSnapshot} from './youtube-reviewed-verification.mjs';
import {CONTEXT_COMPARISON,contextComparisonOperation,contextComparisonPlan,
  contextReadiness,rejectContextReplay} from './youtube-context-comparison.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

assert.deepEqual(process.argv.slice(2),['--prepare-only']);
const id='youtube-context-comparison-14-ready-2026-11-17',root='generated-artifacts/'+id;
try{await fs.stat(root);assert.fail('Fresh destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
const baselineRoot='generated-artifacts/youtube-reviewed-verification-14-ready-2026-11-17';
const sourceFiles={},read=async f=>{
  const bytes=await fs.readFile(f);sourceFiles[f]=digest(bytes);return JSON.parse(bytes);
};
const baselinePlan=await read(baselineRoot+'/plan.json'),baselineApproval=await read(baselineRoot+'/approval.json');
const summary=await read(baselineRoot+'/summary.json'),results=await read(baselineRoot+'/results.json');
assert.equal(summary.status,'completed');assert.equal(summary.returnedCalls,14);assert.equal(results.length,14);
Object.assign(sourceFiles,baselinePlan.sourceFiles);
for(const [f,sha] of Object.entries(baselinePlan.runtimeFiles))sourceFiles[baselineRoot+'/'+f]=sha;
const offline=await read('generated-artifacts/youtube-context-revision-offline-2026-11-17/proposals.json');
assert.equal(offline.status,'offline_proposals_not_approved');assert.equal(offline.proposals.length,14);
Object.assign(sourceFiles,offline.sourceFiles);
const baselineResponses=[],videoPackets=[],operations=[],expectedAdmissions=[];
for(const row of baselinePlan.inputs){
  const previous=baselinePlan.operations.find(o=>o.caseId===row.caseId);
  const folder=baselineRoot+'/part-1/receipts/'+digest(previous.key);
  const receipt=await read(folder+'.json'),raw=await fs.readFile(folder+'.raw');
  sourceFiles[folder+'.raw']=digest(raw);
  const result=reviewedVerificationResult(baselinePlan,previous,receipt,raw);
  assert.deepEqual(result,results.find(r=>r.profileId===row.profileId));
  const admission={run_id:baselinePlan.groups[0].id,operation_key:previous.key,profile_id:row.profileId,
    kind:'model',input_sha256:previous.inputSha256,reserved_cents:2,status:'returned',
    receipt_sha256:digest(receipt),http_status:200};
  expectedAdmissions.push(admission);
  baselineResponses.push({operationKey:previous.key,receipt,rawBase64:raw.toString('base64')});
  const packets=[];
  for(const file of row.sourceRefs.filter(f=>f.includes('/results/')&&f.endsWith('.json'))){
    const saved=await read(file),receiptFile=file.replace('/results/','/receipts/');
    const videoReceipt=await read(receiptFile),rawFile=receiptFile.replace(/\.json$/,'.raw');
    assert.ok(row.sourceRefs.includes(rawFile));
    const videoRaw=await fs.readFile(rawFile);sourceFiles[rawFile]=digest(videoRaw);
    packets.push({result:saved,receipt:videoReceipt,rawBase64:videoRaw.toString('base64')});
  }
  if(packets.length)videoPackets.push({caseId:row.caseId,packets});
  const op=contextComparisonOperation(previous,row,packets,result,admission);
  assert.deepEqual(op.proposal,offline.proposals.find(p=>p.caseId===row.caseId).proposal);
  operations.push(op);
}
const current=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(baselinePlan.selections));
const selections=baselinePlan.selections.map(s=>({...s,
  tier:Number(current.find(r=>String(r.profile_id)===s.profileId)?.tier)}));
assertCurrentIdentityEligibility(selections,current);
operations.sort((a,b)=>selections.find(s=>s.profileId===a.profileId).tier-
  selections.find(s=>s.profileId===b.profileId).tier);
const pool=await connectSavedBatchPool(),c=await pool.connect();
let baselineLedgerSnapshot,coordinatorSchemaSha256;
try{
  await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL statement_timeout='15000'");
  coordinatorSchemaSha256=digest(await boundedComparisonSchema(c));
  baselineLedgerSnapshot=await reviewedVerificationSnapshot(c,[baselinePlan.groups[0].id]);
  assert.deepEqual(baselineLedgerSnapshot.admissions,
    expectedAdmissions.sort((a,b)=>a.operation_key.localeCompare(b.operation_key)));
  await contextReadiness(c,{baselinePlan,baselineLedgerSnapshot,coordinatorSchemaSha256,runtimeFiles:{}});
  await rejectContextReplay(c,operations);
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE id=$1',
    [id+'-part-1'])).rows[0].n,0);
  await c.query('COMMIT');
}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
await frozenFileVerifier(sourceFiles)();
const pricing=await modelQuote();checkModelQuote(pricing,baselinePlan.pricing);
await fs.mkdir(root);
const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
  'run-youtube-context-comparison.mjs'),root+'/runtime'),runtimeFiles={};
for(const f of modules){const relative='runtime/'+path.basename(f);runtimeFiles[relative]=digest(await fs.readFile(root+'/'+relative));}
const plan=deepFreeze(contextComparisonPlan({id,version:CONTEXT_COMPARISON,preparedAt:new Date().toISOString(),
  baselineRoot,baselinePlan,baselineApproval,baselineResponses,baselineLedgerSnapshot,videoPackets,operations,
  selections,sourceFiles,runtimeFiles,pricing,coordinatorSchemaSha256,maximumSpendCents:28,
  maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))}));
const preparation={id,status:'prepared_not_approved',checks:14,allowanceCents:28,planSha256:digest(plan),
  maximumRequestBytes:plan.maximumRequestBytes,baselineReceiptsVerified:true,changedRequestsOnly:true,
  historicalFeedbackHidden:true,abstentionsSeparate:true,knownSafetyVetoesNotModelSuccess:true,
  paidCalls:0,approvalWritten:false,ledgerWrites:0,schemaChanges:0,catalogWrites:0,
  policyActivated:false,ownershipAccuracyScorable:false,providerEnforcedDollarCeiling:false,
  caveat:plan.caveat,
  nextStep:'Fresh explicit approval for 14 changed model requests with a 28-cent allowance; old approvals do not authorize this comparison.'};
await fs.writeFile(root+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
await fs.writeFile(root+'/preparation.json',JSON.stringify(preparation,null,2),{flag:'wx'});
await frozenFileVerifier(sourceFiles)();console.log(JSON.stringify(preparation));
