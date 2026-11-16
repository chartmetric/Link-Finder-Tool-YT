// Prepares a fresh, unapproved remainder. All database transactions are READ
// ONLY; the old workers, approvals, receipts and reservations are immutable.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {untouchedDirectContinuation} from './youtube-untouched-direct-continuation.mjs';
import {refreshedDirectCaptureInput} from './youtube-direct-capture-refresh.mjs';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {mixedCaptureReadiness} from './youtube-mixed-capture-readiness.mjs';
import {identityCatalogCheck,identityEligibilitySql} from './youtube-video-identity-catalog.mjs';
import {mixedClaims} from './run-youtube-mixed-captures.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const ids=['youtube-batch-channel-checks-direct-100-refreshed-2026-11-13',
  'youtube-batch-channel-checks-continuation-100-2026-11-14'];
const id='youtube-batch-channel-checks-continuation-40-ready-2026-11-16',root='generated-artifacts/'+id;
const sourceFiles={};
const bytes=async file=>{const b=await fs.readFile(file);sourceFiles[file]=digest(b);return b;};
const read=async file=>JSON.parse(await bytes(file));
const save=(name,value)=>fs.writeFile(root+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const mode=process.argv.slice(2);
assert.ok(mode.length===1&&['--prepare-only','--offline-draft'].includes(mode[0]));
try{await fs.lstat(root);assert.fail('Preparation already exists; never overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
const bundles=[];
for(const sourceId of ids){
  const folder='generated-artifacts/'+sourceId,plan=await read(folder+'/plan.json');
  const approval=await read(folder+'/approval.json');await bytes(folder+'/run-started.json');
  for(const [name,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await bytes(folder+'/'+name)),sha);
  const childApprovals=[];
  for(const child of plan.children){
    const folder='generated-artifacts/'+child.id,p=await read(folder+'/plan.json');
    assert.equal(digest(p),child.planSha256);
    childApprovals.push(await read(folder+'/approval.json'));
    for(const [file,sha] of Object.entries(p.runtimeFiles))assert.equal(digest(await bytes(folder+'/'+file)),sha);
    for(const [file,sha] of Object.entries(p.sourceFiles))assert.equal(digest(await bytes(file)),sha);
  }
  bundles.push({plan,approval,childApprovals});
}
const priorResults=await read('generated-artifacts/youtube-channel-results-100-after-continuation-2026-11-16/results.json');
const recovery=await read('generated-artifacts/youtube-direct-receipt-recovery-100-2026-11-14/recovery-result.json');
assert.equal(recovery.status,'saved_receipt_accounted_identity_conflict_still_held');
if(mode[0]==='--offline-draft'){
  // Preserve the successfully read ledger from THIS preparation attempt, but
  // never misrepresent that snapshot as fresh catalog/readiness clearance.
  const snapshotPath='generated-artifacts/youtube-batch-channel-checks-continuation-40-2026-11-16/continuation-evidence.json';
  const snapshot=await read(snapshotPath);
  assert.deepEqual(snapshot.bundles,bundles);
  const scope=untouchedDirectContinuation(snapshot);
  assert.equal(scope.pending.length,40);assert.equal(scope.priorReservedCents,24);
  assert.deepEqual(scope,snapshot.scope);
  for(const [file,sha] of Object.entries(snapshot.sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await fs.mkdir(root);
  const proposal={id,preparedAt:new Date().toISOString(),status:'draft_blocked_catalog_readiness',
    executable:false,explicitApproval:false,scope,ledgerSnapshotPath:snapshotPath,
    ledgerSnapshotSha256:digest(await fs.readFile(snapshotPath)),ledgerObservedAt:snapshot.observedAt,
    sourceFiles,heldResponses:snapshot.heldResponses,
    catalogReadiness:'Not confirmed; HTTP 408 during fresh catalog validation. Do not execute or request spending approval.',
    next:'Revalidate the live ledger, current tier eligibility and linked-account conflicts, then seal a fresh exact plan for separate approval.',
    paidCalls:0,coordinatorWrites:0,catalogWrites:0};
  await save('draft-proposal.json',proposal);
  await save('remaining-channel-checks.csv','\ufeff'+[
    ['artist','tier_at_previous_approval','profile_id','cm_artist','youtube_url','maximum_cost_usd','status'],
    ...scope.pending.map(p=>[p.selection.artist,p.selection.tier,p.operation.profileId,p.operation.cmArtist,
      p.operation.targetUrl,'0.02','Untouched — catalog readiness not confirmed; not approved'])
  ].map(r=>r.map(cell).join(',')).join('\r\n'));
  const summary={id,status:proposal.status,proposalSha256:digest(proposal),remainingChecks:40,
    maximumAdditionalCents:80,priorReservedCents:24,combinedMaximumCents:104,
    priorRecordedChannelPages:11,priorHeldResponses:1,executable:false,paidCalls:0,coordinatorWrites:0,catalogWrites:0};
  await save('preparation.json',summary);console.log(JSON.stringify(summary));
  process.exit(0);
}
const allChildren=bundles.flatMap(b=>b.plan.children),pool=await connectSavedBatchPool();let c,scope,evidence,currentRows;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=ANY($1::text[]) ORDER BY id',
    [allChildren.map(ch=>ch.id)])).rows;
  const admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[]) ORDER BY run_id,operation_key',
    [allChildren.map(ch=>ch.id)])).rows;
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE status='admitted'")).rows[0].n,0);
  scope=untouchedDirectContinuation({bundles,runs,admissions});
  assert.equal(scope.pending.length,40);assert.equal(scope.priorReservedCents,24);
  assert.equal(priorResults.results.length,admissions.length);
  // Validate all prior receipts against the live returned ledger and exact
  // saved bytes, not just the old progress summary.
  for(const a of admissions){
    const child=allChildren.find(ch=>ch.id===a.run_id),op=child.plan.operations.find(o=>o.key===a.operation_key);
    const receipt=await read('generated-artifacts/'+a.run_id+'/receipts/'+digest(op.key)+'.json');
    for(const [key,value] of Object.entries({runId:a.run_id,planSha256:child.planSha256,
      approvalSha256:runs.find(r=>r.id===a.run_id).approval_sha256,operationKey:op.key,
      profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,
      inputSha256:op.inputSha256,rawPath:'receipts/'+digest(op.key)+'.raw',status:200}))
      assert.equal(receipt[key],value);
    assert.deepEqual(receipt.request,op.request);assert.equal(digest(receipt),a.receipt_sha256);
    const raw=await bytes('generated-artifacts/'+a.run_id+'/'+receipt.rawPath);
    assert.equal(digest(raw),a.raw_sha256);assert.equal(digest(raw),receipt.rawBodySha256);
    const body=JSON.parse(raw);assert.equal(body.success,true);
    assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
    const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
    if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
    const saved=priorResults.results.find(r=>r.sourceRunId===a.run_id&&r.profileId===op.profileId);
    assert.ok(saved);assert.equal(saved.receiptSha256,a.receipt_sha256);assert.equal(saved.rawSha256,a.raw_sha256);
    assert.deepEqual(saved.capture,capture);assert.equal(saved.importEligible,false);
  }
  const held=priorResults.results.filter(r=>r.status==='held_identity_conflict_not_accepted');
  assert.equal(held.length,1);assert.equal(held[0].receiptSha256,recovery.receiptSha256);
  assert.equal(held[0].rawSha256,recovery.rawSha256);
  currentRows=await select(identityEligibilitySql(scope.pending.map(p=>p.selection)));
  evidence=JSON.parse(JSON.stringify({bundles,runs,admissions,scope,currentRows,
    heldResponses:held,observedAt:new Date().toISOString(),sourceFiles:structuredClone(sourceFiles),
    paidCallsDuringPreparation:0,coordinatorWritesDuringPreparation:0}));
  await fs.mkdir(root);
  await save('continuation-evidence.json',evidence);
  sourceFiles[root+'/continuation-evidence.json']=digest(await fs.readFile(root+'/continuation-evidence.json'));
  async function runtime(entry,folder){
    const files=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),entry),folder+'/runtime');
    const hashes={};
    for(const file of files){const name='runtime/'+path.basename(file);hashes[name]=digest(await fs.readFile(folder+'/'+name));}
    return hashes;
  }
  const children=[],previous=bundles.at(-1).plan;
  for(const [i,child] of previous.children.entries()){
    const keys=scope.pending.filter(p=>p.sourceRunId===child.id).map(p=>p.operation);
    if(!keys.length)continue;
    const rows=currentRows.filter(r=>keys.some(o=>o.profileId===String(r.profile_id)));
    const childId='youtube-mixed-captures-continuation-40-ready-2026-11-16-part-'+(i+1);
    const result=refreshedDirectCaptureInput(child.plan,rows,{id:childId,preparedAt:new Date().toISOString(),
      sourceFiles,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}});
    assert.ok(result.input,'Latest eligibility requires a revised subset');
    let plan=mixedCapturePlan(result.input);
    assert.deepEqual(plan.operations,keys,'Do not substitute, repeat or silently omit any remaining check');
    await identityCatalogCheck(plan)(mixedClaims(plan));
    // No projected bookkeeping state: the real, unchanged guards must pass.
    await mixedCaptureReadiness(c,plan,{preparationOnly:true});
    const folder='generated-artifacts/'+childId;await fs.mkdir(folder);
    plan=mixedCapturePlan({...result.input,runtimeFiles:await runtime('run-youtube-mixed-captures.mjs',folder)});
    await fs.writeFile(folder+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
    children.push({id:childId,plan});
  }
  await c.query('COMMIT');
  const plan=channelCheckBundle({id,preparedAt:new Date().toISOString(),
    sourceBundleId:previous.sourceBundleId,sourceBundleSha256:previous.sourceBundleSha256,children,
    runtimeFiles:await runtime('run-youtube-channel-check-bundle.mjs',root)});
  assert.equal(plan.maximumCalls,40);assert.equal(plan.maximumSpendCents,80);
  assert.equal(scope.priorReservedCents+plan.maximumSpendCents,scope.originalMaximumCents);
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await save('plan.json',plan);
  await save('remaining-channel-checks.csv','\ufeff'+[
    ['artist','starting_tier','current_tier','profile_id','cm_artist','youtube_url','maximum_cost_usd','status'],
    ...plan.children.flatMap(ch=>ch.plan.selections.map(s=>[
      s.artist,ch.plan.artists.find(a=>a.profileId===s.profileId).startingTier??s.tier,s.tier,
      s.profileId,s.cmArtist,s.url,'0.02','Untouched — separate approval required']))
  ].map(r=>r.map(cell).join(',')).join('\r\n'));
  const summary={id,status:'sealed_not_approved_not_started',planSha256:digest(plan),remainingChecks:40,
    maximumAdditionalCents:80,priorReservedCents:24,combinedMaximumCents:104,
    priorRecordedChannelPages:11,priorHeldResponses:1,
    catalogTimeoutPolicy:'Retry only the identical read-only catalog SELECT once after HTTP 408; stop if it fails again. Never retry a paid provider request.',
    catalogLookupPolicy:'Resolve matching accounts, then all linked profiles; preserve historical and cross-profile conflict checks without catalog-wide joins.',
    paidCalls:0,coordinatorWrites:0,catalogWrites:0,ownershipAccepted:0,importEligible:0};
  await save('preparation.json',summary);console.log(JSON.stringify(summary));
}catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c?.release();await pool.end();}
