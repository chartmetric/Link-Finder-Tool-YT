import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {holdChannelPlan,projectHeldReceipt} from './youtube-channel-hold-continuation.mjs';
import {channelSuffix} from './youtube-channel-fast-continuation.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {verifyHoldReceipts,previousFastGroups} from './run-youtube-channel-hold-continuation.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function prepareHoldContinuation(){
  const id='youtube-channel-hold-continuation-136-2026-11-16',root='generated-artifacts/'+id;
  try{await fs.lstat(root);assert.fail('Use a fresh sealed destination');}catch(e){if(e.code!=='ENOENT')throw e;}
  const oldRoot='generated-artifacts/youtube-channel-fast-continuation-held-265-2026-11-16';
  const predecessor=await read(oldRoot+'/plan.json'),predecessorApproval=await read(oldRoot+'/approval.json'),
    cutover=await read(oldRoot+'/cutover.json');
  const {makeFastFrozenCheck}=await import('../../'+oldRoot+'/runtime/run-youtube-channel-fast-continuation.mjs');
  const extra={};
  for(const file of ['approval.json','cutover.json','run-started.json'])
    extra[oldRoot+'/'+file]=digest(await fs.readFile(oldRoot+'/'+file));
  const checkOld=await makeFastFrozenCheck(oldRoot,predecessor,extra);await checkOld();
  const sourceFiles={...predecessor.sourceFiles,...extra,[oldRoot+'/plan.json']:digest(await fs.readFile(oldRoot+'/plan.json'))};
  for(const [file,sha] of Object.entries(predecessor.runtimeFiles))sourceFiles[oldRoot+'/'+file]=sha;
  const source={id:predecessor.id,groups:channelSuffix(predecessor,cutover.snapshot).groups};
  const pool=await connectSavedBatchPool();let c,originalSnapshot,fastSnapshot;
  try{
    c=await pool.connect();await c.query('BEGIN READ ONLY');
    originalSnapshot=await sourceChannelSnapshot(c,predecessor.sourcePlan);
    fastSnapshot=await sourceChannelSnapshot(c,source);
    assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
      [Array.from({length:7},(_,i)=>id+'-part-'+(i+1))])).rows[0].n,0);
    await c.query('COMMIT');
  }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
  const pending=fastSnapshot.admissions.filter(a=>a.status!=='returned');assert.equal(pending.length,1);
  const row=pending[0],group=source.groups.find(g=>g.id===row.run_id),op=group.operations.find(o=>o.key===row.operation_key);
  const receiptPath=oldRoot+'/part-'+(group.groupIndex+1)+'/receipts/'+digest(op.key)+'.json';
  const receiptBytes=await fs.readFile(receiptPath),receipt=JSON.parse(receiptBytes);
  assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
  const rawPath=receiptPath.replace(/\.json$/,'.raw'),raw=await fs.readFile(rawPath);
  assert.equal(receipt.status,200);assert.equal(digest(raw),receipt.rawBodySha256);
  assert.deepEqual(receipt.request,op.request);
  const body=JSON.parse(raw);assert.equal(body.success,true);
  assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
  const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',operationKey:op.key,
    request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl),bound=boundYoutubeCapture(op.targetUrl,capture);
  assert.ok(bound);if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
  const linked=await catalogLinkedYoutubeClaims(bound.aliases.map(alias=>({alias,channelId:bound.body.channelId,
    profileId:op.profileId,cmArtist:op.cmArtist})),select);
  const conflicts=linked.filter(r=>r.profile_id!==op.profileId||r.cm_artist!==op.cmArtist);assert.ok(conflicts.length);
  const recovery={snapshot:fastSnapshot,runId:row.run_id,operationKey:op.key,receiptPath,rawPath,
    receiptSha256:digest(receipt),rawSha256:digest(raw),receiptFileSha256:digest(receiptBytes),
    capturedChannel:bound.body,conflicts,providerRequests:0,ownershipAccepted:false,importEligible:false};
  // Bind all original receipts and partial-group plans, not just the held case.
  for(const [history,snapshot] of [[predecessor.sourcePlan,originalSnapshot],[source,fastSnapshot]]){
    for(const run of snapshot.runs){
      const g=history.groups.find(g=>g.id===run.id),folder='generated-artifacts/'+history.id+'/part-'+(g.groupIndex+1);
      for(const f of ['plan.json','approval.json'])sourceFiles[folder+'/'+f]=digest(await fs.readFile(folder+'/'+f));
      assert.deepEqual(await read(folder+'/plan.json'),g);
      for(const a of snapshot.admissions.filter(a=>a.run_id===run.id)){
        for(const ext of ['json','raw']){
          const f=folder+'/receipts/'+digest(a.operation_key)+'.'+ext;sourceFiles[f]=digest(await fs.readFile(f));
        }
      }
    }
  }
  const projected=projectHeldReceipt(fastSnapshot,recovery);
  const prefix=projected.admissions.length,remaining=source.groups.flatMap(g=>g.operations).slice(prefix);
  const ids=new Set(remaining.map(o=>o.profileId));
  const selections=predecessor.sourcePlan.sourcePlan.selections.filter(s=>ids.has(s.profileId));
  assert.equal(remaining.length,136);assert.equal(selections.length,136);
  assertCurrentIdentityEligibility(selections,await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
  // Exclude all paid identities and active/uncertain stages without changing the ledger.
  const readinessPool=await connectSavedBatchPool(),rc=await readinessPool.connect();
  try{
    await rc.query('BEGIN READ ONLY');
    // Preparation projects only the explicitly saved receipt for this read-only gate.
    // The real readiness check runs after its separately approved acknowledgment.
    assert.equal((await rc.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE status='admitted'
      AND NOT (run_id=$1 AND operation_key=$2)`,[row.run_id,row.operation_key])).rows[0].n,0);
    assert.equal((await rc.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE kind='metadata'
      AND (profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[]) OR channel_id=ANY($3::text[]))`,
    [selections.map(s=>s.profileId),selections.map(s=>s.cmArtist),remaining.map(o=>o.allocationChannelKey)])).rows[0].n,0);
    await rc.query('COMMIT');
  }catch(e){await rc.query('ROLLBACK');throw e;}finally{rc.release();await readinessPool.end();}
  await fs.mkdir(root);
  const save=async(f,v)=>fs.writeFile(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
  await save('held-response-recovery.json',recovery);sourceFiles[root+'/held-response-recovery.json']=digest(await fs.readFile(root+'/held-response-recovery.json'));
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-hold-continuation.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));}
  const plan=holdChannelPlan({id,preparedAt:new Date().toISOString(),predecessor,predecessorApproval,
    cutover,originalSnapshot,fastSnapshot,recovery,sourceFiles,runtimeFiles});
  await verifyHoldReceipts(plan);assert.deepEqual(previousFastGroups(plan),source);
  await save('plan.json',plan);const verify=frozenFileVerifier(sourceFiles);await verify();
  const summary={id,status:'prepared_not_approved',remainingChecks:plan.maximumCalls,
    maximumRemainingCents:plan.maximumSpendCents,priorReservedCents:plan.priorReservedCents,
    combinedCapCents:plan.combinedCapCents,heldArtist:'Braeker',previousHeldArtist:'atlgrandma',
    identityConflictsHeldWithoutStopping:true,providerFailuresStillStop:true,
    paidCalls:0,ledgerWrites:0,catalogWrites:0,planSha256:digest(plan)};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);
  console.log(JSON.stringify(await prepareHoldContinuation()));
}
