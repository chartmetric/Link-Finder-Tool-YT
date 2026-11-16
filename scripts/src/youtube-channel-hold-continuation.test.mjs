import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {projectHeldReceipt,validatePaidPrefix} from './youtube-channel-hold-continuation.mjs';
import {inspectIdentityConflict,identityConflict} from './youtube-identity-conflict-hold.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';
function fixture(){
  const operations=[0,1,2].map(i=>({key:'op-'+i,profileId:String(i+1),cmArtist:String(i+11),
    allocationChannelKey:'channel-'+i,inputSha256:digest('input-'+i)}));
  const group={id:'test-group',groupIndex:0,operations,runtimeFiles:{'runtime/test.mjs':digest('runtime')},
    maximumCalls:3,maximumSpendCents:6};
  const approval={id:group.id,planSha256:digest(group)};
  const snapshot={runs:[{id:group.id,owner:'original-owner',status:'stopped',plan_sha256:digest(group),
    approval_sha256:digest(approval),execution_sha256:digest(group.runtimeFiles),cap_cents:6,reserved_cents:4}],
    admissions:operations.slice(0,2).map((o,i)=>({run_id:group.id,operation_key:o.key,profile_id:o.profileId,
      cm_artist:o.cmArtist,channel_id:o.allocationChannelKey,kind:'metadata',input_sha256:o.inputSha256,
      reserved_cents:2,status:i?'admitted':'returned',http_status:i?null:200,
      receipt_sha256:i?null:digest('receipt0'),raw_sha256:i?null:digest('raw0')}))};
  const recovery={snapshot:structuredClone(snapshot),runId:group.id,operationKey:'op-1',
    ownershipAccepted:false,importEligible:false,providerRequests:0,
    receiptSha256:digest('receipt1'),receiptFileSha256:digest('receipt-file'),rawSha256:digest('raw1')};
  return {group,approval,snapshot,recovery};
}
test('receipt recovery projects transport only, preserving charges, owner, and stopped state',()=>{
  const f=fixture(),before=structuredClone(f.snapshot),after=projectHeldReceipt(f.snapshot,f.recovery);
  assert.deepEqual(f.snapshot,before);assert.deepEqual(after.runs,before.runs);
  assert.equal(after.admissions[1].status,'returned');
  assert.equal(validatePaidPrefix([f.group],[f.approval],after),2);
  assert.equal(after.admissions.reduce((n,a)=>n+a.reserved_cents,0),4);
});
test('changed ledger, duplicate or uncertain receipts, altered identities and missing paid prefixes block continuation',()=>{
  const f=fixture();
  for(const change of [
    s=>s.runs[0].owner='changed',s=>s.admissions[0].raw_sha256=digest('changed'),
    s=>s.admissions[1].status='returned',s=>s.admissions[1].http_status=500]){
    const copy=structuredClone(f.snapshot);change(copy);
    assert.throws(()=>projectHeldReceipt(copy,f.recovery));
  }
  for(const change of [
    s=>s.admissions.push(s.admissions[0]),s=>s.admissions[0].profile_id='999',
    s=>s.admissions[0].raw_sha256=null,s=>s.admissions[0].status='admitted',
    s=>s.admissions[0].operation_key='op-2',s=>s.runs[0].reserved_cents=6,
    s=>s.runs[0].status='running',s=>s.runs[0].cap_cents=8]){
    const copy=projectHeldReceipt(f.snapshot,f.recovery);change(copy);
    assert.throws(()=>validatePaidPrefix([f.group],[f.approval],copy));
  }
});
test('only explicit structured artist conflicts may be held; other failures still stop',async()=>{
  const conflict=identityConflict([{profileId:'wrong-artist'}]);
  assert.deepEqual(await inspectIdentityConflict(async()=>{throw conflict;},true),conflict.claims);
  await assert.rejects(()=>inspectIdentityConflict(async()=>{throw conflict;},false));
  for(const error of [Error('HTTP 408'),Error('unknown billing'),Object.assign(Error('untrusted'),{code:'YOUTUBE_IDENTITY_CONFLICT'})])
    await assert.rejects(()=>inspectIdentityConflict(async()=>{throw error;},true));
});
test('claims for another artist produce structured conflicts, not proof of incorrect ownership',()=>{
  const expected=[{alias:'https://www.youtube.com/@one',channelId:'id',profileId:'1',cmArtist:'11'}];
  assert.throws(()=>assertNoNewIdentityClaims(expected,[{alias:'https://www.youtube.com/@ONE',
    channelId:'id',profileId:'2',cmArtist:'22'}]),e=>e.code==='YOUTUBE_IDENTITY_CONFLICT'&&e.claims.length===1);
  assert.doesNotThrow(()=>assertNoNewIdentityClaims(expected,[{...expected[0]}]));
});
