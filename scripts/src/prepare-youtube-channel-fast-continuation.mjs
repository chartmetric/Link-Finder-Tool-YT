// Read-only preparation and timing only. The active worker is never fenced here.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {fastChannelPlan,recoveredChannelSnapshot,channelSuffix} from './youtube-channel-fast-continuation.mjs';
import {sourceChannelSnapshot,verifySourceChannelReceipts} from './youtube-channel-fast-live.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
const sourceRoot='generated-artifacts/youtube-accounted-channel-groups-265-2026-11-16';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function prepareFastChannelContinuation({withHeldResponse=false}={}){
  const id=withHeldResponse?'youtube-channel-fast-continuation-held-265-2026-11-16':
    'youtube-channel-fast-continuation-265-2026-11-16',root='generated-artifacts/'+id;
  const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
  try{await fs.lstat(root);assert.fail('Fresh preparation required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourcePlan=await read(sourceRoot+'/plan.json'),sourceApproval=await read(sourceRoot+'/approval.json');
  const {assertAccountedGroupsFrozen}=await import('../../'+sourceRoot+'/runtime/run-youtube-accounted-channel-groups.mjs');
  let start=performance.now();await assertAccountedGroupsFrozen(sourceRoot,sourcePlan);
  const oldFrozenCheckMs=Math.round(performance.now()-start),sourceFiles={...sourcePlan.sourceFiles};
  for(const file of ['plan.json','approval.json','run-started.json'])
    sourceFiles[sourceRoot+'/'+file]=digest(await fs.readFile(sourceRoot+'/'+file));
  for(const [file,sha] of Object.entries(sourcePlan.runtimeFiles)){
    assert.equal(digest(await fs.readFile(sourceRoot+'/'+file)),sha);sourceFiles[sourceRoot+'/'+file]=sha;
  }
  const verify=frozenFileVerifier(sourceFiles);
  const initial=await verify();start=performance.now();const repeated=await verify();
  const cachedFrozenCheckMs=Math.round(performance.now()-start);
  assert.equal(repeated.contentReads,0);assert.equal(repeated.filesChecked,Object.keys(sourceFiles).length);
  const pool=await connectSavedBatchPool();let c,snapshot;
  try{
    c=await pool.connect();await c.query('BEGIN READ ONLY');
    snapshot=await sourceChannelSnapshot(c,sourcePlan);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
      [Array.from({length:Math.ceil(sourcePlan.maximumCalls/20)},(_,i)=>id+'-part-'+(i+1))])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
  let savedResponseRecovery;
  if(withHeldResponse){
    const pending=snapshot.admissions.filter(a=>a.status!=='returned');assert.equal(pending.length,1);
    const row=pending[0],group=sourcePlan.groups.find(g=>g.id===row.run_id),op=group.operations.find(o=>o.key===row.operation_key);
    assert.ok(snapshot.runs.every(r=>['completed','stopped'].includes(r.status)));
    assert.equal(row.status,'admitted');
    const receiptPath=sourceRoot+'/part-'+(group.groupIndex+1)+'/receipts/'+digest(op.key)+'.json';
    const receiptBytes=await fs.readFile(receiptPath),receipt=JSON.parse(receiptBytes);
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const rawPath=sourceRoot+'/part-'+(group.groupIndex+1)+'/'+receipt.rawPath,raw=await fs.readFile(rawPath);
    assert.equal(digest(raw),receipt.rawBodySha256);assert.equal(receipt.status,200);
    assert.deepEqual(receipt.request,op.request);const body=JSON.parse(raw);
    assert.equal(body.success,true);assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
    const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
    if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
    const linked=await catalogLinkedYoutubeClaims(bound.aliases.map(alias=>({alias,channelId:bound.body.channelId,
      profileId:op.profileId,cmArtist:op.cmArtist})),select);
    const conflicts=linked.filter(r=>r.profile_id!==op.profileId||r.cm_artist!==op.cmArtist);assert.ok(conflicts.length);
    savedResponseRecovery={version:'exact-held-channel-receipt-only-v1',runId:row.run_id,operationKey:row.operation_key,
      snapshot,receiptPath,rawPath,receiptSha256:digest(receipt),rawSha256:digest(raw),
      receiptFileSha256:digest(receiptBytes),rawFileSha256:digest(raw),
      capturedChannel:bound.body,conflicts,catalogConflictHeld:true,ownershipAccepted:false,importEligible:false,providerRequests:0};
    sourceFiles[receiptPath]=digest(receiptBytes);sourceFiles[rawPath]=digest(raw);
  }
  const allocated=new Set(snapshot.admissions.map(a=>a.profile_id));
  const remaining=sourcePlan.sourcePlan.selections.filter(s=>!allocated.has(s.profileId));
  if(remaining.length)assertCurrentIdentityEligibility(remaining,
    await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(remaining)));
  const benchmark={oldFrozenCheckMs,cachedFrozenCheckMs,filesCheckedPerOperation:repeated.filesChecked,
    firstPassContentReads:initial.contentReads,repeatedContentReads:repeated.contentReads,
    note:'Read-only timing, not a guarantee of total live throughput. Paid requests were not made.'};
  if(remaining.length){
    const target=remaining[0];start=performance.now();
    await targetedCatalogCheck({selections:remaining})([{
      alias:target.url,channelId:target.channelId,profileId:target.profileId,cmArtist:target.cmArtist}]);
    benchmark.singleTargetCatalogCheckMs=Math.round(performance.now()-start);
  }
  await fs.mkdir(root);await save('read-only-preparation.json',{
    observedAt:new Date().toISOString(),sourceSnapshot:snapshot,remainingAtPreparation:remaining.length,benchmark,
    activeWorkerChanged:false,paidCalls:0,ledgerWrites:0,catalogWrites:0});
  sourceFiles[root+'/read-only-preparation.json']=digest(await fs.readFile(root+'/read-only-preparation.json'));
  if(savedResponseRecovery){
    await save('held-response-recovery.json',savedResponseRecovery);
    sourceFiles[root+'/held-response-recovery.json']=digest(await fs.readFile(root+'/held-response-recovery.json'));
  }
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-fast-continuation.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){
    const key='runtime/'+path.basename(file);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));
  }
  const plan=fastChannelPlan({id,preparedAt:new Date().toISOString(),sourcePlan,sourceApproval,sourceFiles,runtimeFiles,
    ...(savedResponseRecovery?{savedResponseRecovery}:{})});
  if(savedResponseRecovery){
    const projected=recoveredChannelSnapshot(plan,snapshot);
    await verifySourceChannelReceipts(sourcePlan,projected);
    assert.equal(channelSuffix(plan,projected).pendingCount,remaining.length);
  }
  await save('plan.json',plan);
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  const summary={id,status:'prepared_not_approved',potentialSourceRequests:plan.maximumCalls,
    completedAtPreparation:snapshot.admissions.filter(a=>a.status==='returned').length,
    reservedAtPreparationCents:snapshot.admissions.reduce((n,a)=>n+a.reserved_cents,0),
    maximumTotalIncludingPriorCents:plan.combinedMaximumSpendCents,
    remainingAtPreparation:remaining.length,remainingRequestsSelectedAtSafeHandover:true,
    ...(savedResponseRecovery?{heldReceiptsToAcknowledge:1,heldArtist:sourcePlan.sourcePlan.selections.find(s=>
      s.profileId===snapshot.admissions.find(a=>a.status==='admitted').profile_id)?.artist,
      heldIdentityStillUnapproved:true,maximumRemainingCents:remaining.length*2}:{}),
    benchmark,activeWorkerChanged:false,paidCalls:0,ledgerWrites:0,catalogWrites:0,planSha256:digest(plan)};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.ok(args.length===1&&
    ['--prepare-only','--prepare-held-continuation'].includes(args[0]));
  console.log(JSON.stringify(await prepareFastChannelContinuation({withHeldResponse:args[0]==='--prepare-held-continuation'})));
}
