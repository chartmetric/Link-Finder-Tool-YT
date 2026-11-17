import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {tierRefreshPlan,refreshTierSelections} from './youtube-channel-tier-refresh.mjs';
import {tierHistory} from './run-youtube-channel-tier-refresh.mjs';
import {verifyErrorReceipts} from './run-youtube-channel-error-continuation.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {identityEligibilitySql} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function prepareTierRefresh(){
  const id='youtube-channel-tier-refresh-27-2026-11-16',root='generated-artifacts/'+id;
  try{await fs.lstat(root);assert.fail('Fresh destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const old='generated-artifacts/youtube-channel-error-continuation-27-2026-11-16';
  const sourcePlan=deepFreeze(await read(old+'/plan.json')),sourceApproval=deepFreeze(await read(old+'/approval.json'));
  const sourceFiles={...sourcePlan.sourceFiles};
  for(const f of ['plan.json','approval.json','run-started.json','error-acknowledgment.json',
    'part-1/plan.json','part-1/approval.json'])sourceFiles[old+'/'+f]=digest(await fs.readFile(old+'/'+f));
  for(const [f,sha] of Object.entries(sourcePlan.runtimeFiles))sourceFiles[old+'/'+f]=sha;
  const ack=await read(old+'/error-acknowledgment.json');
  assert.equal(ack.planSha256,digest(sourcePlan));assert.equal(ack.runId,sourcePlan.recovery.runId);
  assert.equal(ack.operationKey,sourcePlan.recovery.operationKey);assert.equal(ack.noProviderRequests,true);
  assert.equal(ack.originalReservationPreserved,true);
  await frozenFileVerifier(sourceFiles)();await verifyErrorReceipts(sourcePlan);
  const selections=sourcePlan.groups.flatMap(g=>g.selections);
  const currentRows=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections));
  const eligible=selections.filter(s=>currentRows.some(r=>String(r.profile_id)===s.profileId));
  const preparedAt=new Date().toISOString(),updated=refreshTierSelections(eligible,currentRows,Date.parse(preparedAt));
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-tier-refresh.mjs'),root+'/runtime'),runtimeFiles={};
  for(const f of modules){const key='runtime/'+path.basename(f);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));}
  const plan=deepFreeze(tierRefreshPlan({id,preparedAt,sourcePlan,sourceApproval,currentRows,sourceFiles,runtimeFiles}));
  assert.equal(plan.maximumCalls+plan.deferred.length,27);
  assert.equal(plan.maximumSpendCents,plan.maximumCalls*2);assert.equal(plan.priorReservedCents,476);
  const pool=await connectSavedBatchPool(),c=await pool.connect();
  try{
    await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='15000'");
    await tierHistory(c,plan);
    assert.deepEqual(await sourceChannelSnapshot(c,plan),{runs:[],admissions:[]});
    for(const g of plan.groups)await accountedChannelReadiness(c,g,{preparationOnly:true,holdIdentityConflicts:true});
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
  await frozenFileVerifier(sourceFiles)();
  const save=(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const summary={id,status:'prepared_not_approved',remainingChecks:plan.maximumCalls,maximumRemainingCents:plan.maximumSpendCents,
    priorReservedCents:476,combinedCapCents:530,
    changedTiers:updated.flatMap((s,i)=>s.tier!==eligible[i].tier?
      [{artist:s.artist,from:eligible[i].tier,to:s.tier}]:[]),
    deferred:plan.deferred.map(s=>({artist:s.artist,profileId:s.profileId,reason:'Missing from current eligibility results; no paid request'})),
    requestsUnchanged:true,failedRequestNotRetried:true,paidCalls:0,ledgerWrites:0,catalogWrites:0,planSha256:digest(plan)};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareTierRefresh()));
}
