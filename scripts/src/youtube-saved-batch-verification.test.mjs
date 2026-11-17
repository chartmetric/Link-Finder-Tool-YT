import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {savedBatchCapture,assembleSavedVerification,savedRecoveryHolds} from './youtube-saved-batch-verification.mjs';
function fixture(topic=false){
  const channelId='UC'+'a'.repeat(22),url='https://www.youtube.com/channel/'+channelId;
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
  const operation={key:'metadata-test',profileId:'1',cmArtist:'11',kind:'metadata',targetUrl:url,
    allocationChannelKey:channelId,inputSha256:digest(request),request,expectedChannelId:channelId};
  const group={id:'test-group',selections:[{profileId:'1',cmArtist:'11',artist:'Test Artist',tier:3}],operations:[operation]};
  const approval={approvedAt:'2026-11-16T00:00:00Z'};
  const raw=Buffer.from(JSON.stringify({success:true,credits_charged:1,channelId,channel:url,
    name:'Test Artist'+(topic?' - Topic':''),description:'Music',links:[]}));
  const receipt={runId:group.id,planSha256:digest(group),approvalSha256:digest(approval),
    operationKey:operation.key,profileId:'1',cmArtist:'11',kind:'metadata',targetUrl:url,
    inputSha256:digest(request),request,capturedAt:'2026-11-17T00:00:00Z',status:200,
    rawPath:'receipts/'+digest(operation.key)+'.raw',rawBodySha256:digest(raw)};
  const row={run_id:group.id,operation_key:operation.key,profile_id:'1',cm_artist:'11',channel_id:channelId,
    kind:'metadata',input_sha256:operation.inputSha256,reserved_cents:2,status:'returned',http_status:200,
    receipt_sha256:digest(receipt),raw_sha256:digest(raw)};
  const receiptBytes=Buffer.from(JSON.stringify(receipt));
  const source={group,approval,operation,row,receipt,raw,receiptBytes};
  const capture={...source,...savedBatchCapture(source)};
  const packet={profileId:'1',cmArtist:'11',artist:'Test Artist',collectedAt:'2026-11-16T00:00:00Z',
    catalogProfile:{profile_id:'1',cm_artist:'11'},linkedAccounts:[],releases:[],catalogTracks:[],
    platformSnapshots:[],spotifyMetadata:[],profileMetadata:[],tags:[]};
  const input={captures:[capture],packets:[packet],records:[{record:{artist:{profileId:'1',cmArtist:'11'},
    candidates:[{url,title:'Test Artist',snippet:'Music'}]}}],claims:[],priorModelRows:[],heldProfiles:[]};
  return {source,input};
}
test('only an exact acknowledged paid capture can enter verification',()=>{
  const {source}=fixture();assert.ok(savedBatchCapture(source).channelId);
  for(const change of [
    s=>s.row.status='admitted',s=>s.row.http_status=500,s=>s.row.profile_id='2',
    s=>s.receipt.request={method:'GET',url:'https://changed.invalid'},
    s=>s.raw=Buffer.from('{}'),s=>s.row.receipt_sha256=digest('changed')]){
    const s=structuredClone(source);change(s);assert.throws(()=>savedBatchCapture(s));
  }
});
test('preparation preserves full request, canonical channel, evidence and no acceptance',()=>{
  const {input}=fixture(),before=digest(input),p=assembleSavedVerification(input);
  assert.equal(p.operations.length,1);assert.equal(p.assessments.length,1);
  const o=p.operations[0];assert.equal(o.inputSha256,digest(o.request));
  assert.equal(o.requestBytes,Buffer.byteLength(JSON.stringify(o.request.body)));
  assert.equal(o.request.body.state.artist.profileId,'1');
  assert.equal(p.assessments[0].ownershipAccepted,false);assert.equal(p.assessments[0].importEligible,false);
  assert.equal(digest(input),before);
});
test('prior allocation, held conflict and shared artist claims never become model dispatches',()=>{
  for(const change of [
    i=>i.priorModelRows=[{profile_id:'1'}],i=>i.priorModelRows=[{cm_artist:'11'}],
    i=>i.priorModelRows=[{channel_id:i.captures[0].channelId}],i=>i.heldProfiles=['1'],
    i=>i.claims=[{url:i.captures[0].operation.targetUrl,profileId:'2',cmArtist:'12'}]]){
    const {input}=fixture();change(input);assert.equal(assembleSavedVerification(input).operations.length,0);
  }
  const {input}=fixture();input.captures.push(input.captures[0]);
  assert.throws(()=>assembleSavedVerification(input));
});
test('Topic captures stay clearly labeled and are not presented as artist ownership',()=>{
  const {input}=fixture(true),p=assembleSavedVerification(input);
  assert.equal(p.assessments[0].channelTypeLabel,'Topic — auto-generated');
  assert.equal(p.assessments[0].ownershipAccepted,false);
  assert.equal(p.operations.length,0);
});
test('both specialized recovery forms stay held while the saved server error is not a capture',()=>{
  const recovery=(runId,operationKey)=>({runId,operationKey,ownershipAccepted:false,importEligible:false});
  const plan={recovery:recovery('failed','error'),sourcePlan:{recovery:recovery('second','b'),
    predecessor:{savedResponseRecovery:recovery('first','a')}}};
  const rows=[{run_id:'failed',operation_key:'error',profile_id:'3',http_status:500},
    {run_id:'second',operation_key:'b',profile_id:'2',http_status:200},
    {run_id:'first',operation_key:'a',profile_id:'1',http_status:200}];
  assert.deepEqual(savedRecoveryHolds(plan,rows),['2','1']);
  assert.throws(()=>savedRecoveryHolds(plan,rows.slice(0,2)));
});
