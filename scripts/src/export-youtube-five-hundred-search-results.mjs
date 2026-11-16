// Read-only accounting and local discovery export. No ownership promotion.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {approveSearchContinuation,untouchedSearchScope,searchRecordFromReceipt} from './youtube-search-continuation.mjs';
import {readSearchSourceLedger} from './youtube-search-continuation-live.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
assert.deepEqual(process.argv.slice(2),['--read-only-export']);
const root='generated-artifacts/youtube-search-continuation-410-ready-2026-11-16';
const output='generated-artifacts/youtube-search-results-500-completed-2026-11-16';
const read=async file=>JSON.parse(await fs.readFile(file));
const plan=await read(root+'/plan.json'),approval=await read(root+'/approval.json');
const source=await read(root+'/evidence/source.json');
assert.deepEqual(approveSearchContinuation(plan,source,approval),approval);
assert.equal((await read(root+'/summary.json')).status,'completed');
const {assertSearchContinuationFrozen}=await import('../../'+root+'/runtime/run-youtube-search-continuation.mjs');
await assertSearchContinuationFrozen(root,plan);
const scope=untouchedSearchScope(source),pool=await connectSavedBatchPool();
let c,runs,admissions,dbResults;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const old=await readSearchSourceLedger(c,source.plan);
  for(const key of ['runs','admissions','results'])assert.deepEqual(old[key],source[key]);
  const ids=plan.groups.map(g=>g.id);
  runs=(await c.query(`SELECT id,status,scope_sha256,cap_cents,reserved_cents FROM youtube_discovery_test_runs
    WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows;
  admissions=(await c.query(`SELECT run_id,operation_key,profile_id,kind,status,http_status,input_sha256,
    receipt_sha256,reserved_cents FROM youtube_bounded_test_admissions WHERE run_id=ANY($1::text[])`,[ids])).rows;
  dbResults=(await c.query(`SELECT run_id,profile_id,cm_artist,status,candidates_json,metadata_json
    FROM youtube_discovery_test_results WHERE run_id=ANY($1::text[])`,[ids])).rows;
  await c.query('COMMIT');
}catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
assert.equal(runs.length,plan.groups.length);assert.equal(admissions.length,410);assert.equal(dbResults.length,410);
for(const group of plan.groups){
  const run=runs.find(r=>r.id===group.id);assert.ok(run);assert.equal(run.status,'completed');
  assert.equal(run.scope_sha256,group.scopeSha256);
  assert.equal(run.cap_cents,group.maximumSpendCents);assert.equal(run.reserved_cents,group.maximumSpendCents);
}
const recovered=await read(root+'/evidence/recovered-search.json'),results=[];
async function verify(entry,folder,admission,expectedRecord){
  const {artist,packet,operation}=entry;
  assert.equal(admission.operation_key,operation.key);assert.equal(admission.profile_id,operation.profileId);
  assert.equal(admission.kind,'search');assert.equal(admission.reserved_cents,2);
  assert.equal(admission.status,'returned');assert.equal(admission.http_status,200);
  assert.equal(admission.input_sha256,operation.inputSha256);
  const receiptPath=folder+'/receipts/'+archivedSearchReceiptName(operation.profileId);
  const raw=await fs.readFile(receiptPath),receipt=JSON.parse(raw);
  assert.equal(evidenceDigest(receipt),admission.receipt_sha256);
  const record=searchRecordFromReceipt({artist,packet,operation,receipt,receiptPath,receiptBytes:raw});
  assert.deepEqual(expectedRecord,record);
  results.push({sourceRunId:admission.run_id,sourceReceipt:receiptPath,receiptSha256:admission.receipt_sha256,
    processedOffline:record===recovered.record||entry.sourceRunId===recovered.sourceRunId&&
      operation.profileId===recovered.record.artist.profileId,record});
}
for(const entry of scope.paid){
  const folder='generated-artifacts/'+entry.sourceRunId;
  const isRecovery=entry.sourceRunId===recovered.sourceRunId&&entry.operation.profileId===recovered.record.artist.profileId;
  await verify(entry,folder,entry.admission,isRecovery?recovered.record:
    await read(folder+'/artists/'+entry.operation.profileId+'.json'));
}
for(const group of plan.groups)for(const operation of group.operations){
  const admission=admissions.find(a=>a.run_id===group.id&&a.operation_key===operation.key);assert.ok(admission);
  const row=dbResults.find(r=>r.run_id===group.id&&r.profile_id===operation.profileId);assert.ok(row);
  assert.equal(row.cm_artist,operation.cmArtist);assert.equal(row.status,'search_returned');
  assert.equal(row.metadata_json.approvalSha256,digest(approval));
  const folder='generated-artifacts/'+group.id,record=await read(folder+'/artists/'+operation.profileId+'.json');
  assert.deepEqual(row.candidates_json,record.candidates);
  await verify({artist:group.artists.find(a=>a.profile_id===operation.profileId),
    packet:group.packets.find(p=>p.profileId===operation.profileId),operation},folder,admission,record);
}
assert.equal(results.length,500);
for(const key of ['profileId','cmArtist'])assert.equal(new Set(results.map(r=>r.record.artist[key])).size,500);
const direct=results.filter(r=>r.record.candidates.length>0);
const videoOnly=results.filter(r=>!r.record.candidates.length&&r.record.videoPlan.resolutionQueue.length>0);
const noLead=results.filter(r=>!r.record.candidates.length&&!r.record.videoPlan.resolutionQueue.length);
assert.equal(direct.length+videoOnly.length+noLead.length,500);
const reserved=scope.priorReservedCents+runs.reduce((n,r)=>n+r.reserved_cents,0);
assert.equal(reserved,1000);
const summary={status:'all_500_searches_accounted',artistsSearched:500,
  artistsWithDirectChannelCandidates:direct.length,artistsWithVideoFallbackOnly:videoOnly.length,
  artistsWithoutSelectedChannelOrUsableVideo:noLead.length,
  directCandidateRows:direct.reduce((n,r)=>n+r.record.candidates.length,0),
  locallyRecoveredSavedResponses:results.filter(r=>r.processedOffline).length,
  reservedCents:reserved,approvedMaximumCents:1000,paidRequests:500,paidReplays:0,
  channelChecks:0,ownershipAccepted:0,catalogWrites:0,exportCoordinatorWrites:0,
  warning:'Search leads only, not confirmed artist channels. No usable lead does not prove channel absence.'};
await fs.mkdir(output);
const save=(name,value)=>fs.writeFile(output+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
await save('results.json',{summary,runs,results});
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
await save('artist-search-summary.csv','\ufeff'+[
  ['artist','tier','profile_id','cm_artist','direct_channel_candidates','saved_video_leads','outcome','ownership_accepted'],
  ...results.map(({record:r})=>[r.artist.name,r.tier,r.artist.profileId,r.artist.cmArtist,
    r.candidates.length,r.videoPlan.resolutionQueue.length,r.candidates.length?'Channel candidates — not verified':
      r.videoPlan.resolutionQueue.length?'Saved-video fallback only — not verified':'No usable lead — channel absence not proven',false]),
].map(r=>r.map(cell).join(',')).join('\r\n'));
console.log(JSON.stringify({output,...summary}));
