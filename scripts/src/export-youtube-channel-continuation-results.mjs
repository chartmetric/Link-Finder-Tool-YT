// Read-only reconstruction across the original paid prefix and its exact
// continuation. Receipt acknowledgment never removes a held identity conflict.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {assertMixedApproval} from './youtube-mixed-capture-readiness.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture,returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
const originalId='youtube-batch-channel-checks-direct-100-refreshed-2026-11-13';
const continuationId='youtube-batch-channel-checks-continuation-100-2026-11-14';
const finalContinuationId='youtube-batch-channel-checks-continuation-40-ready-2026-11-16';
const recoveryRoot='generated-artifacts/youtube-direct-receipt-recovery-100-2026-11-14';
const output='generated-artifacts/youtube-channel-results-100-completed-2026-11-16';
const read=async file=>JSON.parse(await fs.readFile(file));
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const csv=rows=>'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
assert.deepEqual(process.argv.slice(2),['--read-only-export']);
const bundles=[];
for(const id of [originalId,continuationId,finalContinuationId]){
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json'),approval=await read(root+'/approval.json');
  assert.deepEqual(approveChannelCheckBundle(plan,approval),approval);
  bundles.push({root,plan,approval});
}
const original=bundles[0].plan;
const originals=new Map(original.children.flatMap(c=>c.plan.operations.map(o=>[o.key,o])));
for(const o of bundles.slice(1).flatMap(b=>b.plan.children.flatMap(c=>c.plan.operations)))
  assert.deepEqual(o,originals.get(o.key),'Continuation must contain only unchanged original requests');
const recoveryPlan=await read(recoveryRoot+'/plan.json'),recovered=await read(recoveryRoot+'/recovery-result.json');
const recoveryContract=await read(recoveryPlan.contractPath);
assert.equal(digest(recoveryContract),recoveryPlan.contractSha256);
assert.equal(recovered.status,'saved_receipt_accounted_identity_conflict_still_held');
assert.equal(recovered.receiptSha256,recoveryContract.recovery.heldResponse.receiptSha256);
assert.equal(recovered.rawSha256,recoveryContract.recovery.heldResponse.rawSha256);
assert.equal(recovered.importEligible,false);assert.equal(recovered.providerRequests,0);
const children=bundles.flatMap(b=>b.plan.children);
const pool=await connectSavedBatchPool();let c,runs,admissions;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const ids=children.map(ch=>ch.id);
  runs=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=ANY($1::text[]) ORDER BY id',[ids])).rows;
  admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[])',[ids])).rows;
  assert.ok(runs.every(r=>['completed','stopped'].includes(r.status)),'Wait for the bounded worker to stop');
  await c.query('COMMIT');
}catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
const catalog=await select(`SELECT toString(l.profile_id) profile_id,toString(p.cm_source_id) cm_artist,
  a.account_url FROM new_vertical.l_profile_account l FINAL
  INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
  LEFT JOIN new_vertical.profile p FINAL ON p.id=l.profile_id
  WHERE lower(a.platform)='youtube' AND notEmpty(trim(ifNull(a.account_url,'')))`);
const results=[],untouched=[];
for(const child of children){
  const folder='generated-artifacts/'+child.id,p=await read(folder+'/plan.json'),approval=await read(folder+'/approval.json');
  assert.equal(digest(p),child.planSha256);assertMixedApproval(p,approval);
  const run=runs.find(r=>r.id===child.id),rows=admissions.filter(a=>a.run_id===child.id);
  if(run){
    assert.equal(run.plan_sha256,digest(p));assert.equal(run.approval_sha256,digest(approval));
    assert.equal(run.execution_sha256,digest(p.runtimeFiles));assert.equal(run.cap_cents,p.maximumSpendCents);
    assert.equal(run.reserved_cents,rows.reduce((n,a)=>n+a.reserved_cents,0));
    if(run.status==='completed')assert.equal(rows.length,p.operations.length);
  }else assert.equal(rows.length,0);
  for(const op of p.operations){
    const a=rows.find(a=>a.operation_key===op.key);
    if(!a){untouched.push({sourceRunId:child.id,...op});continue;}
    for(const [key,value] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,
      channel_id:op.allocationChannelKey,kind:'metadata',input_sha256:op.inputSha256,reserved_cents:2}))
      assert.equal(a[key],value);
    const receipt=await read(folder+'/receipts/'+digest(op.key)+'.json');
    for(const [key,value] of Object.entries({runId:child.id,planSha256:digest(p),approvalSha256:digest(approval),
      operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',
      targetUrl:op.targetUrl,inputSha256:op.inputSha256,rawPath:'receipts/'+digest(op.key)+'.raw',status:200}))
      assert.equal(receipt[key],value);
    assert.deepEqual(receipt.request,op.request);
    const raw=await fs.readFile(folder+'/'+receipt.rawPath);assert.equal(digest(raw),receipt.rawBodySha256);
    const body=JSON.parse(raw);assert.equal(body.success,true);
    assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
    const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
      operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
    const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
    if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
    const conflicts=catalog.filter(r=>{
      const alias=returnedYoutubeUrl(r.account_url);
      return alias&&bound.aliases.some(v=>v.toLowerCase()===alias.toLowerCase())
        &&(String(r.profile_id)!==op.profileId||String(r.cm_artist)!==op.cmArtist);
    });
    const savedHeld=child.id===recovered.sourceRunId&&op.key===recovered.operationKey;
    assert.ok(['admitted','returned'].includes(a.status));
    if(a.status==='returned'){
      assert.equal(a.http_status,200);assert.equal(a.receipt_sha256,digest(receipt));assert.equal(a.raw_sha256,digest(raw));
    }
    if(savedHeld){
      assert.equal(digest(receipt),recovered.receiptSha256);assert.equal(digest(raw),recovered.rawSha256);
    }
    const held=savedHeld||a.status!=='returned'||conflicts.length>0;
    const s=p.selections.find(s=>s.profileId===op.profileId),artist=p.artists.find(s=>s.profileId===op.profileId);
    const topic=bound.body.isAutoGenerated===true||/\s*[-–—]\s*Topic\s*$/iu.test(bound.body.displayName??'');
    results.push({artist:s.artist,startingTier:artist.startingTier??s.tier,tierAtApproval:s.tier,profileId:op.profileId,
      cmArtist:op.cmArtist,youtubeUrl:'https://www.youtube.com/channel/'+bound.body.channelId,
      requestedUrl:op.targetUrl,channelName:bound.body.displayName,handle:bound.body.handle,
      channelType:topic?'topic':bound.body.isOfficialArtistChannel===true?'official_artist_channel':'unknown',
      channelTypeLabel:topic?'Topic — auto-generated; artist association unverified':
        bound.body.isOfficialArtistChannel===true?'Official Artist Channel badge — artist match unverified':
          'Channel captured — artist ownership unverified',
      status:held?'held_identity_conflict_not_accepted':'metadata_captured_ownership_unverified',
      sourceRunId:child.id,capturedAt:receipt.capturedAt,receiptSha256:digest(receipt),rawSha256:digest(raw),
      conflicts,savedHeld,capture,ownershipAccepted:false,importEligible:false});
  }
}
assert.equal(results.length,admissions.length);
assert.equal(new Set(results.map(r=>r.profileId+':'+r.youtubeUrl)).size,results.length,'One canonical channel per artist row');
const reservedCents=runs.reduce((n,r)=>n+r.reserved_cents,0);
assert.ok(reservedCents<=104);
// Untouched original suffix is superseded, not a second pending allocation.
const remaining=original.children.flatMap(ch=>ch.plan.operations).filter(o=>!results.some(r=>r.profileId===o.profileId));
const captured=results.filter(r=>r.status==='metadata_captured_ownership_unverified');
const held=results.filter(r=>r.status!=='metadata_captured_ownership_unverified');
assert.equal(results.length+remaining.length,52);
const summary={sourceArtists:100,selectedChannelChecks:52,previouslyRecorded:10,
  newlyRecorded:captured.filter(r=>r.sourceRunId.includes('continuation')).length,
  recordedChannelPages:captured.length,heldResponses:held.length,untouchedChecks:remaining.length,
  topicChannels:captured.filter(r=>r.channelType==='topic').length,paidRequests:admissions.length,
  reservedCents,approvedMaximumCents:104,continuationReservedCents:runs.filter(r=>r.id.includes('continuation')).reduce((n,r)=>n+r.reserved_cents,0),
  retries:0,modelCalls:0,catalogWrites:0,ownershipAccepted:0,importEligible:0,exportCoordinatorWrites:0,
  status:remaining.length?'stopped_with_untouched_checks':'channel_metadata_stage_accounted'};
await fs.mkdir(output);
const save=(name,data)=>fs.writeFile(output+'/'+name,typeof data==='string'?data:JSON.stringify(data,null,2),{flag:'wx'});
const headers=['artist','starting_tier','tier_at_approval','profile_id','cm_artist','youtube_url','channel_name',
  'handle','channel_type','channel_type_label','status','ownership_accepted','import_eligible','result_json'];
const row=r=>[r.artist,r.startingTier,r.tierAtApproval,r.profileId,r.cmArtist,r.youtubeUrl,r.channelName,
  r.handle,r.channelType,r.channelTypeLabel,r.status,false,false,JSON.stringify(r)];
await save('youtube-channels-captured.csv',csv([headers,...captured.map(row)]));
await save('youtube-channels-held.csv',csv([headers,...held.map(row)]));
await save('results.json',{summary,runs,results,remaining});
console.log(JSON.stringify({output,...summary}));
