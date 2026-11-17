// Read-only reconciliation and non-executable local proposal. No paid API calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {savedBatchCapture,assembleSavedVerification,savedRecoveryHolds} from './youtube-saved-batch-verification.mjs';
import {tierHistory} from './run-youtube-channel-tier-refresh.mjs';
import {tierRefreshPlan,approveTierRefresh,tierGroupApproval} from './youtube-channel-tier-refresh.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {verifyCompletedHoldGroup} from './run-youtube-channel-hold-continuation.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
const cell=x=>'"'+String(x??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
export async function prepareSavedBatchVerification(){
  const id='youtube-saved-batch-verification-500-ready-2026-11-17',root='generated-artifacts/'+id;
  try{await fs.stat(root);assert.fail('Fresh destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceRoot='generated-artifacts/youtube-channel-tier-refresh-27-2026-11-16';
  const latest=deepFreeze(await read(sourceRoot+'/plan.json')),approval=deepFreeze(await read(sourceRoot+'/approval.json'));
  assert.deepEqual(tierRefreshPlan(latest),latest);assert.deepEqual(approveTierRefresh(latest,approval),approval);
  const files={...latest.sourceFiles};
  const bind=async f=>{const bytes=await fs.readFile(f);files[f]=digest(bytes);return bytes;};
  for(const f of ['plan.json','approval.json','run-started.json','summary.json'])await bind(sourceRoot+'/'+f);
  for(const [f,sha] of Object.entries(latest.runtimeFiles))files[sourceRoot+'/'+f]=sha;
  const latestSummary=await read(sourceRoot+'/summary.json');assert.equal(latestSummary.status,'completed');
  const groups=[];
  for(const f of Object.keys(files).filter(f=>/\/part-\d+\/plan.json$/.test(f)&&/channel/.test(f))){
    const g=await read(f);
    if(g.operations?.length&&g.operations.every(o=>o.kind==='metadata')){
      const folder=path.dirname(f),a=await read(folder+'/approval.json');
      groups.push({group:g,approval:a,folder});
    }
  }
  for(const g of latest.groups){
    const folder=sourceRoot+'/part-'+(g.groupIndex+1);
    for(const f of ['plan.json','approval.json','returns.json'])await bind(folder+'/'+f);
    assert.deepEqual(await read(folder+'/plan.json'),g);
    const a=await read(folder+'/approval.json');assert.deepEqual(tierGroupApproval(latest,approval,g),a);
    groups.push({group:g,approval:a,folder});
  }
  assert.equal(new Set(groups.map(g=>g.group.id)).size,groups.length);
  const pool=await connectSavedBatchPool(),c=await pool.connect();
  let snapshot,priorModelRows;
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='15000'");await tierHistory(c,latest);
    snapshot=await sourceChannelSnapshot(c,{groups:groups.map(g=>g.group)});
    for(const g of latest.groups){
      assert.equal(snapshot.runs.find(r=>r.id===g.id)?.status,'completed');
      await verifyCompletedHoldGroup(latest,g,snapshot.admissions.filter(r=>r.run_id===g.id));
    }
    assert.equal(snapshot.runs.reduce((n,r)=>n+r.reserved_cents,0),latestSummary.reservedCents);
    assert.equal(snapshot.admissions.length*2,latestSummary.reservedCents);
    priorModelRows=(await c.query("SELECT run_id,profile_id,cm_artist,channel_id,status FROM youtube_video_identity_admissions WHERE kind='model'")).rows;
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
  assert.ok(snapshot.runs.every(r=>['stopped','completed'].includes(r.status)));
  assert.ok(snapshot.admissions.every(r=>r.status==='returned'));
  const baseName='generated-artifacts/youtube-accounted-channel-checks-500-2026-11-16/plan.json';
  assert.ok(files[baseName]);const base=await read(baseName);assert.equal(base.records.length,500);
  const packets=[];
  for(const f of Object.keys(files).filter(f=>/\/plan.json$/.test(f)&&/youtube-test-100-fresh-500-/.test(f))){
    const p=await read(f);
    if(p.packets){assert.equal(p.catalogEvidenceSha256,digest(p.packets));packets.push(...p.packets);}
  }
  assert.ok(packets.length>=500,'Original artist packets must be preserved');
  const heldProfiles=new Set();
  for(const f of Object.keys(files).filter(f=>f.endsWith('.held.json'))){
    const h=await read(f);assert.equal(h.ownershipAccepted,false);assert.equal(h.importEligible,false);
    heldProfiles.add(h.profileId);
  }
  // Specialized, historically approved conflict recoveries stay held even if
  // their normalizer can reconstruct a channel. Do not inherit recovery authority.
  for(const profile of savedRecoveryHolds(latest,snapshot.admissions))heldProfiles.add(profile);
  const captures=[],failures=[];
  for(const row of snapshot.admissions){
    const src=groups.find(g=>g.group.id===row.run_id);assert.ok(src);
    const operation=src.group.operations.find(o=>o.key===row.operation_key);assert.ok(operation);
    const name=src.folder+'/receipts/'+digest(operation.key);
    const receiptBytes=await bind(name+'.json'),receipt=JSON.parse(receiptBytes),raw=await bind(name+'.raw');
    assert.equal(row.receipt_sha256,digest(receipt));assert.equal(row.raw_sha256,digest(raw));
    if(row.http_status!==200){
      assert.equal(row.http_status,500);assert.equal(row.profile_id,latest.sourcePlan.recovery.snapshot.admissions
        .find(a=>a.run_id===latest.sourcePlan.recovery.runId&&a.operation_key===latest.sourcePlan.recovery.operationKey).profile_id);
      failures.push({profileId:row.profile_id,cmArtist:row.cm_artist,httpStatus:500,
        ownershipAccepted:false,noMatch:false,willNotRetry:true});continue;
    }
    const capture=savedBatchCapture({...src,operation,row,receipt,raw,receiptBytes});
    captures.push({...src,operation,...capture});
  }
  const assembled=assembleSavedVerification({captures,packets,records:base.records,claims:base.claims,
    priorModelRows,heldProfiles:[...heldProfiles]});
  await frozenFileVerifier(files)();
  const plan={id,version:'saved-batch-verification-proposal-v1',preparedAt:new Date().toISOString(),
    sourceFiles:files,sourceLedgerSnapshot:snapshot,priorModelRows,sourceId:latest.id,
    searchArtists:500,channelReservedCents:latestSummary.reservedCents,channelCombinedCapCents:530,
    ...assembled,failures,uncapturedSelections:latest.deferred,
    model:{endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13',
      proposedMaximumRequestBytes:Math.max(0,...assembled.operations.map(o=>o.requestBytes)),
      pricingConfirmed:false,proposedPerRequestReservationCents:2},
    proposedMaximumModelCalls:assembled.operations.length,
    proposedMaximumModelReservationCents:assembled.operations.length*2,
    executable:false,explicitApproval:false,inheritsApproval:false,
    searchCalls:0,metadataCalls:0,uploaderCalls:0,modelCallsExecuted:0,ledgerWrites:0,catalogWrites:0,
    ownershipAccepted:0,importEligible:false,
    executionPreconditions:['Separate explicit spending approval and confirmation of model pricing/request size.',
      'A sealed model-only executor with fresh locked reconciliation, exact request bindings and independent non-replay checks.',
      'Preserve held conflicts and failed responses; no recaptures, searches, retries or automatic catalog additions.']};
  await fs.mkdir(root);
  const save=(f,v)=>fs.writeFile(root+'/'+f,typeof v==='string'?v:JSON.stringify(v,null,2),{flag:'wx'});
  await save('plan.json',plan);
  const columns=['artist','tier','profileId','cmArtist','youtubeUrl','channelTypeLabel','status','reason',
    'proposedModelCheck','requestBytes','ownershipAccepted','importEligible'];
  await save('verification-review.csv','\ufeff'+[columns,...plan.assessments.map(a=>columns.map(k=>a[k]))]
    .map(r=>r.map(cell).join(',')).join('\r\n'));
  const counts={};for(const a of plan.assessments)counts[a.status]=(counts[a.status]??0)+1;
  const summary={id,status:'prepared_not_approved',capturedChannels:captures.length,
    statuses:counts,proposedModelCalls:plan.proposedMaximumModelCalls,
    proposedReservationCents:plan.proposedMaximumModelReservationCents,
    proposedMaximumRequestBytes:plan.model.proposedMaximumRequestBytes,
    oversizedLegacy6000Bytes:plan.operations.filter(o=>o.requestBytes>6000).length,
    failedResponses:failures.length,uncapturedSelections:latest.deferred.length,
    pricingConfirmed:false,executable:false,paidCalls:0,ledgerWrites:0,catalogWrites:0,
    planSha256:digest(plan)};
  await save('summary.json',summary);console.log(JSON.stringify(summary));return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);await prepareSavedBatchVerification();
}
