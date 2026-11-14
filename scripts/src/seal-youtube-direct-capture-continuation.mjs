// Preparation only. Does not authorize/apply recovery or dispatch any request.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {prepareDirectRecoveryContract} from './youtube-direct-capture-recovery-plan.mjs';
import {refreshedDirectCaptureInput} from './youtube-direct-capture-refresh.mjs';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {mixedCaptureReadiness} from './youtube-mixed-capture-readiness.mjs';
import {identityCatalogCheck,identityEligibilitySql} from './youtube-video-identity-catalog.mjs';
import {mixedClaims} from './run-youtube-mixed-captures.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const prep='generated-artifacts/youtube-direct-channel-recovery-preparation-2026-11-14';
const recoveryId='youtube-direct-receipt-recovery-100-2026-11-14',recoveryRoot='generated-artifacts/'+recoveryId;
const id='youtube-batch-channel-checks-continuation-100-2026-11-14',root='generated-artifacts/'+id;
const read=async file=>JSON.parse(await fs.readFile(file));
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});
assert.deepEqual(process.argv.slice(2),['--prepare-only']);
const evidence=await read(prep+'/source-evidence.json'),contract=await read(prep+'/recovery-and-continuation-proposal.json');
assert.deepEqual(prepareDirectRecoveryContract(evidence),contract);
const sourceFiles={...evidence.sourceFiles};
for(const name of ['source-evidence.json','recovery-and-continuation-proposal.json'])
  sourceFiles[prep+'/'+name]=digest(await fs.readFile(prep+'/'+name));
for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
async function runtime(entry,folder){
  const files=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),entry),folder+'/runtime');
  const hashes={};
  for(const file of files){const name='runtime/'+path.basename(file);hashes[name]=digest(await fs.readFile(folder+'/'+name));}
  return hashes;
}
await fs.mkdir(recoveryRoot);
const recovery={version:'exact-saved-direct-channel-receipt-recovery-v1',id:recoveryId,preparedAt:new Date().toISOString(),
  evidencePath:prep+'/source-evidence.json',evidenceSha256:digest(evidence),
  contractPath:prep+'/recovery-and-continuation-proposal.json',contractSha256:digest(contract),
  sourceFiles:structuredClone(sourceFiles),runtimeFiles:await runtime('run-youtube-direct-receipt-recovery.mjs',recoveryRoot),
  maximumAdditionalCents:0,providerRequests:0,createOwnershipClaims:false,catalogWrites:0,
  keepSourceStopped:true,keepConflictHeld:true,explicitApproval:false};
await save(recoveryRoot+'/plan.json',recovery);
sourceFiles[recoveryRoot+'/plan.json']=digest(await fs.readFile(recoveryRoot+'/plan.json'));
const currentRows=await select(identityEligibilitySql(contract.continuation.pending.map(p=>p.selection)));
await fs.mkdir(root);
await save(root+'/current-eligibility.json',{observedAt:new Date().toISOString(),rows:currentRows});
sourceFiles[root+'/current-eligibility.json']=digest(await fs.readFile(root+'/current-eligibility.json'));
const pendingKeys=new Set(contract.continuation.pending.map(p=>p.sourceRunId+':'+p.operation.key)),children=[];
const pool=await connectSavedBatchPool();let c;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  // Verify the full live snapshot is unchanged; no projection is allowed to
  // conceal a second pending request or a changed owner.
  const runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
    [evidence.bundle.children.map(ch=>ch.id)])).rows;
  const admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[])',
    [evidence.bundle.children.map(ch=>ch.id)])).rows;
  assert.deepEqual(prepareDirectRecoveryContract(JSON.parse(JSON.stringify({...evidence,runs,admissions}))).accounting,contract.accounting);
  for(const old of evidence.runs){
    const live=runs.find(r=>r.id===old.id);
    for(const key of ['owner','status','plan_sha256','approval_sha256','execution_sha256','cap_cents','reserved_cents'])
      assert.equal(live[key],old[key]);
  }
  const pending=(await c.query("SELECT run_id,operation_key FROM youtube_video_identity_admissions WHERE status='admitted'")).rows;
  assert.deepEqual(pending,[{run_id:contract.recovery.heldResponse.sourceRunId,operation_key:contract.recovery.heldResponse.operationKey}]);
  // READ-ONLY simulation of the one *future approved* receipt acknowledgment.
  // Never passed to an executor or frozen runtime. Actual execution uses the
  // unchanged readiness guard and blocks until the real recovery is approved.
  const projected={query:async(sql,args)=>{
    assert.match(sql.trim(),/^SELECT\b/i);
    if(sql.includes("FROM youtube_video_identity_admissions")&&sql.includes("status='admitted' AND run_id<>$1")){
      const r=await c.query(sql,args);assert.equal(r.rows[0].n,1);
      return {...r,rows:[{n:0}]};
    }
    return c.query(sql,args);
  }};
  for(const [i,ch] of evidence.bundle.children.entries()){
    const old=ch.plan,keys=old.operations.filter(o=>pendingKeys.has(ch.id+':'+o.key));
    if(!keys.length)continue;
    const rows=currentRows.filter(r=>keys.some(o=>o.profileId===String(r.profile_id)));
    const childId='youtube-mixed-captures-continuation-100-2026-11-14-part-'+(i+1);
    const result=refreshedDirectCaptureInput(old,rows,{id:childId,preparedAt:new Date().toISOString(),
      sourceFiles,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}});
    assert.ok(result.input,'No current eligible remaining artists');
    let plan=mixedCapturePlan(result.input);
    assert.deepEqual(plan.operations,keys,'No substituted, paid or deferred operations');
    await identityCatalogCheck(plan)(mixedClaims(plan));
    await mixedCaptureReadiness(projected,plan,{preparationOnly:true});
    const folder='generated-artifacts/'+childId;await fs.mkdir(folder);
    plan=mixedCapturePlan({...result.input,runtimeFiles:await runtime('run-youtube-mixed-captures.mjs',folder)});
    await save(folder+'/plan.json',plan);children.push({id:childId,plan});
  }
  await c.query('COMMIT');
}catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
const plan=channelCheckBundle({id,preparedAt:new Date().toISOString(),sourceBundleId:evidence.bundle.sourceBundleId,
  sourceBundleSha256:evidence.bundle.sourceBundleSha256,children,
  runtimeFiles:await runtime('run-youtube-channel-check-bundle.mjs',root)});
assert.equal(plan.maximumCalls,contract.continuation.maximumCalls);
assert.equal(plan.maximumSpendCents+contract.accounting.priorReservedCents,contract.accounting.originalMaximumCents);
for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
await save(root+'/plan.json',plan);
const summary={status:'sealed_not_approved_not_started',recoveryId,recoveryPlanSha256:digest(recovery),
  recoveryAdditionalCents:0,continuationId:id,continuationPlanSha256:digest(plan),remainingChecks:plan.maximumCalls,
  maximumAdditionalCents:plan.maximumSpendCents,priorReservedCents:contract.accounting.priorReservedCents,
  combinedMaximumCents:contract.accounting.originalMaximumCents,
  recoveryMustBeApprovedAndAppliedFirst:true,separateContinuationApprovalRequired:true,
  providerRequests:0,coordinatorWrites:0,catalogWrites:0};
await save(root+'/preparation.json',summary);
console.log(JSON.stringify(summary));
