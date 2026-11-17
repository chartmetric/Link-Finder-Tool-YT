// Read-only preparation of the untouched suffix. Does not acknowledge the error.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {errorContinuationPlan,serverErrorReceipt} from './youtube-channel-error-continuation.mjs';
import {speedSwitchPlan,approveSpeedSwitch,speedSuffix,speedGroupApproval} from './youtube-channel-speed-switch.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {verifyErrorReceipts,assertErrorHistory} from './run-youtube-channel-error-continuation.mjs';
import {readSourceHolds} from './run-youtube-channel-speed-switch.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function prepareErrorContinuation(){
  const id='youtube-channel-error-continuation-27-2026-11-16',root='generated-artifacts/'+id;
  try{await fs.lstat(root);assert.fail('Fresh sealed destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const oldRoot='generated-artifacts/youtube-channel-speed-switch-safe-suffix-2026-11-16';
  const sourcePlan=deepFreeze(await read(oldRoot+'/plan.json')),sourceApproval=deepFreeze(await read(oldRoot+'/approval.json')),
    cutover=deepFreeze(await read(oldRoot+'/cutover.json'));
  assert.deepEqual(speedSwitchPlan(sourcePlan),sourcePlan);assert.deepEqual(approveSpeedSwitch(sourcePlan,sourceApproval),sourceApproval);
  assert.equal(cutover.planSha256,digest(sourcePlan));
  const source={id:sourcePlan.id,groups:speedSuffix(sourcePlan,cutover.snapshot,cutover.holds).groups};
  const sourceFiles={...sourcePlan.sourceFiles,...cutover.files};
  for(const f of ['plan.json','approval.json','run-started.json','cutover.json'])
    sourceFiles[oldRoot+'/'+f]=digest(await fs.readFile(oldRoot+'/'+f));
  for(const [f,sha] of Object.entries(sourcePlan.runtimeFiles))sourceFiles[oldRoot+'/'+f]=sha;
  const pool=await connectSavedBatchPool();let snapshot,c;
  try{
    c=await pool.connect();await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='15000'");
    snapshot=await sourceChannelSnapshot(c,source);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await sourceChannelSnapshot(c,{groups:[{id:id+'-part-1'},{id:id+'-part-2'}]})).runs.length,0);
    await c.query('COMMIT');
  }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
  const pending=snapshot.admissions.filter(a=>a.status!=='returned');assert.equal(pending.length,1);
  const row=pending[0],g=source.groups.find(g=>g.id===row.run_id),op=g.operations.find(o=>o.key===row.operation_key);
  const receiptPath=oldRoot+'/part-'+(g.groupIndex+1)+'/receipts/'+digest(op.key)+'.json';
  const receiptBytes=await fs.readFile(receiptPath),receipt=JSON.parse(receiptBytes),
    rawPath=receiptPath.replace(/\.json$/,'.raw'),raw=await fs.readFile(rawPath);
  const disposition=serverErrorReceipt(receipt,raw,g,speedGroupApproval(sourcePlan,sourceApproval,cutover,g),op);
  const recovery={snapshot,runId:row.run_id,operationKey:row.operation_key,
    receiptPath,rawPath,receiptFileSha256:digest(receiptBytes),receiptSha256:digest(receipt),rawSha256:digest(raw),
    httpStatus:500,reservedCents:2,ownershipAccepted:false,importEligible:false,noRetry:true,disposition};
  const {holds,files}=await readSourceHolds(source);Object.assign(sourceFiles,files);
  for(const run of snapshot.runs){
    const group=source.groups.find(g=>g.id===run.id),folder=oldRoot+'/part-'+(group.groupIndex+1);
    assert.deepEqual(await read(folder+'/plan.json'),group);
    assert.deepEqual(await read(folder+'/approval.json'),speedGroupApproval(sourcePlan,sourceApproval,cutover,group));
    for(const f of ['plan.json','approval.json'])sourceFiles[folder+'/'+f]=digest(await fs.readFile(folder+'/'+f));
    for(const a of snapshot.admissions.filter(a=>a.run_id===run.id)){
      for(const ext of ['json','raw']){
        const f=folder+'/receipts/'+digest(a.operation_key)+'.'+ext;sourceFiles[f]=digest(await fs.readFile(f));
      }
    }
  }
  // Check every bound source byte before creating a new proposal.
  await frozenFileVerifier(sourceFiles)();
  await fs.mkdir(root);const save=async(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  await save('saved-server-error.json',recovery);sourceFiles[root+'/saved-server-error.json']=digest(await fs.readFile(root+'/saved-server-error.json'));
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-error-continuation.mjs'),root+'/runtime'),runtimeFiles={};
  for(const f of modules){const key='runtime/'+path.basename(f);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));}
  const plan=deepFreeze(errorContinuationPlan({id,preparedAt:new Date().toISOString(),
    sourcePlan,sourceApproval,cutover,snapshot:deepFreeze(snapshot),holds:deepFreeze(holds),recovery:deepFreeze(recovery),sourceFiles,runtimeFiles}));
  assert.equal(plan.maximumCalls,27);assert.equal(plan.maximumSpendCents,54);assert.equal(plan.priorReservedCents,476);
  await verifyErrorReceipts(plan);
  const selections=plan.groups.flatMap(g=>g.selections);
  assertCurrentIdentityEligibility(selections,await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
  const checkPool=await connectSavedBatchPool(),cc=await checkPool.connect();
  try{
    await cc.query('BEGIN READ ONLY');await cc.query("SET LOCAL statement_timeout='15000'");
    await assertErrorHistory(cc,plan,false);
    assert.equal((await cc.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE status='admitted' AND NOT (run_id=$1 AND operation_key=$2)`,[row.run_id,row.operation_key])).rows[0].n,0);
    assert.equal((await cc.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE kind='metadata'
      AND (profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[]) OR channel_id=ANY($3::text[]))`,
    [selections.map(s=>s.profileId),selections.map(s=>s.cmArtist),plan.groups.flatMap(g=>g.operations.map(o=>o.allocationChannelKey))])).rows[0].n,0);
    await cc.query('COMMIT');
  }catch(e){await cc.query('ROLLBACK');throw e;}finally{cc.release();await checkPool.end();}
  await save('plan.json',plan);
  const summary={id,status:'prepared_not_approved',remainingChecks:plan.maximumCalls,
    maximumRemainingCents:plan.maximumSpendCents,priorReservedCents:plan.priorReservedCents,combinedCapCents:plan.combinedCapCents,
    serverErrorArtist:source.groups.flatMap(g=>g.selections).find(s=>s.profileId===row.profile_id)?.artist,
    errorWillNotBeRetried:true,errorIsNotNoMatch:true,sourceSuccessfulResponses:snapshot.admissions.length-1,
    providerReportedErrorCredits:disposition.providerReportedCredits,
    paidCalls:0,ledgerWrites:0,catalogWrites:0,planSha256:digest(plan)};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareErrorContinuation()));
}
