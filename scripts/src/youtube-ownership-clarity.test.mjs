import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput,evaluateYoutubeOwnership} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {clarifiedOwnershipRequest} from './youtube-ownership-clarity.mjs';

function fixture({url='https://open.spotify.com/intl-de/artist/'+'A'.repeat(22)+'?si=test',description='An artist who owns a label'}={}){
  const channelId='UC'+'a'.repeat(22),canonical='https://www.youtube.com/channel/'+channelId;
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(canonical)};
  const capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-16T00:00:00Z',
    request,inputSha256:digest(request),data:{success:true,channelId,channel:canonical,name:'Example',
      description,links:[url]}},canonical);
  const artist={profileId:'1',cmArtist:'2',name:'Example',catalogProfile:{profile_id:'1',cm_artist:'2'},
    accounts:[{profile_id:'1',cm_artist:'2',account_url:'https://open.spotify.com/artist/'+'A'.repeat(22),
      platform:'spotify'}],releases:[]};
  const candidate={url:canonical,title:'Example',capture};
  const input=youtubeVerificationInput(artist,candidate);
  const prepared=youtubeDecisionRequest(input,{model:{expectedModel:'typesafe/jev-1.13',
    endpoint:'https://openrouter.ai/api/alpha/decisions',maxRequestBytes:50000}});
  const op={key:'model-1',kind:'model',profileId:'1',cmArtist:'2',channelId,request:prepared.request,
    inputSha256:prepared.inputSha256,policyInputSha256:input.inputSha256,
    requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),
    requestBytes:prepared.bytes,proposedReservationCents:2};
  return {op,capture,artist,candidate};
}
test('exact localized Spotify support is indexed without new evidence, grading labels or ownership acceptance',()=>{
  const {op,capture}=fixture(),before=structuredClone(op);
  const p=clarifiedOwnershipRequest(op,capture);
  assert.deepEqual(op,before);
  assert.deepEqual(p.request.body.state.artist,op.request.body.state.artist);
  assert.deepEqual(p.request.body.state.candidate,op.request.body.state.candidate);
  assert.deepEqual(p.matchingSpotifyIds,['spotify:'+'A'.repeat(22)]);
  assert.equal(p.executionEnabled,false);assert.equal(p.ownershipAccepted,false);
  assert.equal(p.importEligible,false);assert.equal(p.requiresFreshSpendingApproval,true);
  assert.notEqual(p.proposedRequestSha256,p.originalRequestSha256);
  assert.equal(p.proposedRequestBytes,Buffer.byteLength(JSON.stringify(p.request.body)));
  assert.equal(p.request.body.state.candidate.channelCapture.body.isOfficialArtistChannel,null);
  assert.equal(p.request.body.questions.ownership_reason.type,'choice');
  assert.ok(!('baseline' in p.request.body.state));
});
test('different IDs, lookalike hosts and album paths never become matching artist evidence',()=>{
  for(const url of ['https://open.spotify.com/artist/'+'a'.repeat(22),
    'https://open.spotify.com.evil.test/artist/'+'A'.repeat(22),
    'https://open.spotify.com/album/'+'A'.repeat(22)]){
    const {op,capture}=fixture({url}),p=clarifiedOwnershipRequest(op,capture);
    assert.equal(p.matchingSpotifyIds.length,0);
  }
});
test('receipt and request binding cannot be replaced by model-readable captures or altered text',()=>{
  const {op,capture}=fixture();
  assert.throws(()=>clarifiedOwnershipRequest(op,null),/Original capture/);
  assert.throws(()=>clarifiedOwnershipRequest(op,op.request.body.state.candidate.channelCapture));
  const altered=structuredClone(op);altered.request.body.state.artist.name='Someone else';
  assert.throws(()=>clarifiedOwnershipRequest(altered,capture));
});
test('proposed wording never promotes old unknown roles or bypasses Topic, fan, group and identity conflicts',()=>{
  for(const description of ['An artist who owns a label','Fan channel for Example',
    'Independent record label','Example is a member of Another Band']){
    const {op,capture,artist,candidate}=fixture({description});
    const before=evaluateYoutubeOwnership(artist,candidate);
    clarifiedOwnershipRequest(op,capture);
    assert.deepEqual(evaluateYoutubeOwnership(artist,candidate),before);
    assert.equal(before.reviewSuggestion,false);
  }
  const {op,capture,artist,candidate}=fixture();
  const input=youtubeVerificationInput(artist,candidate);
  const answer={inputSha256:input.inputSha256,answer:{verdict:'likely',channelType:'unknown',sameIdentityProbability:.99}};
  clarifiedOwnershipRequest(op,capture);
  assert.equal(evaluateYoutubeOwnership(artist,candidate,{answer}).reviewSuggestion,false);
});
