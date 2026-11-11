import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareYoutubeOwnershipCheck} from './youtube-ownership-check-prep.mjs';
import {evidenceDigest,YOUTUBE_OWNERSHIP_POLICY,YOUTUBE_OWNERSHIP_RULES} from './youtube-ownership-policy.mjs';
function fixture(){
  const scope=Array.from({length:20},(_,i)=>({profile_id:String(i+1),cm_artist:String(i+100),artist:'Artist '+i,tier:i%5+1}));
  const approval={id:'yt-test',discoveryOnly:true,scope,scopeSha256:evidenceDigest(scope),capCents:200};
  const inputs=Array.from({length:34},(_,i)=>{
    const a=scope[i%16],url='https://www.youtube.com/@artist'+i;
    const state={artist:{profileId:a.profile_id,cmArtist:a.cm_artist},candidate:{url,channelCapture:null}};
    return {profileId:a.profile_id,cmArtist:a.cm_artist,url,policy:YOUTUBE_OWNERSHIP_POLICY,rules:YOUTUBE_OWNERSHIP_RULES,
      state,inputSha256:evidenceDigest({policy:YOUTUBE_OWNERSHIP_POLICY,rules:YOUTUBE_OWNERSHIP_RULES,state})};
  });
  return {approval,summary:{status:'completed',reservedUsd:.4,noMatch:4},inputs,
    ledger:{id:'yt-test',scope_sha256:approval.scopeSha256,status:'completed',cap_cents:200,reserved_cents:40,result_count:20},
    receiptsVerified:20,preparedAt:'2026-11-11T00:00:00Z'};
}
test('Preparation binds 34 channel checks to the unchanged $2 parent and preserves earlier charges',()=>{
  const p=prepareYoutubeOwnershipCheck(fixture());
  assert.equal(p.counts.artists,16);assert.equal(p.counts.maximumMetadataCalls,34);
  assert.equal(p.counts.maximumModelCalls,34);assert.equal(p.counts.newSearches,0);
  assert.equal(p.spending.maximumNewReservationCents,136);
  assert.equal(p.spending.maximumCombinedReservationCents,176);
  assert.equal(p.spending.maximumTotalCents,200);
  assert.equal(p.runAllowed,false);assert.equal(p.authorization,null);
  assert.ok(p.metadataRequests.every(r=>r.requestUrl.startsWith('https://api.scrapecreators.com/v1/youtube/channel?url=')));
});
test('Missing receipts, changed charges, different identities or modified frozen evidence block preparation',()=>{
  for(const mutate of [
    f=>{f.receiptsVerified=19;},f=>{f.ledger.reserved_cents=38;},
    f=>{f.ledger.status='running';},f=>{f.ledger.cap_cents=300;},
    f=>{f.inputs[0].state.artist.cmArtist='999';},
    f=>{f.inputs[0].inputSha256='0'.repeat(64);},
    f=>{f.approval.scope[0].cm_artist='999';},
  ]){const f=fixture();mutate(f);assert.throws(()=>prepareYoutubeOwnershipCheck(f));}
});
test('URL identity is frozen and paid requests cannot be authorized by a preparation plan',()=>{
  const f=fixture();f.inputs[0].url='https://youtube.com/watch?v=123';
  assert.throws(()=>prepareYoutubeOwnershipCheck(f));
  const p=prepareYoutubeOwnershipCheck(fixture());
  assert.equal(p.safety.noRetries,true);assert.equal(p.safety.noFreshOrResetSpendingCap,true);
  assert.equal(p.approvalRequired,true);assert.equal(p.safety.noInstagramChanges,true);
});
