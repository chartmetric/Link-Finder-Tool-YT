import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {COMBINED_ASSESSMENTS,combinedOwnershipRequest,parseCombinedOwnership} from './youtube-combined-ownership.mjs';

function fixture({body={},profileId='1',cmArtist='2',channelId='UC'+'a'.repeat(22),name='Artist'}={}){
  const url='https://www.youtube.com/channel/'+channelId;
  const spotify='https://open.spotify.com/artist/'+'A'.repeat(22);
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
  const capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-16T00:00:00Z',
    request,inputSha256:digest(request),data:{success:true,channelId,channel:url,name,description:'A musician',
      links:[spotify],...body}},url);
  const artist={profileId,cmArtist,name,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
    accounts:[{profile_id:profileId,cm_artist:cmArtist,account_url:spotify}],
    releases:[{track_name:'Unabridged source text '.repeat(500),source:'synthetic release'}]};
  const input=youtubeVerificationInput(artist,{url,capture,title:name});
  const prepared=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
    expectedModel:'typesafe/jev-1.13',maxRequestBytes:100000}});
  const original={key:'model-'+profileId,kind:'model',profileId,cmArtist,channelId,
    request:prepared.request,inputSha256:prepared.inputSha256,policyInputSha256:input.inputSha256,
    requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),requestBytes:prepared.bytes,
    proposedReservationCents:2};
  return {original,capture,proposal:combinedOwnershipRequest(original,capture)};
}
function packet(proposal,category){
  return {kind:'model',status:200,request:proposal.request,inputSha256:proposal.requestSha256,
    data:{model:'typesafe/jev-1.13-20260917',usage:{cost:.0001},
      answers:{combined_assessment:{type:'choice',choice:category}}}};
}
test('one combined question replaces independent votes without dropping source evidence',()=>{
  const {original,capture,proposal}=fixture(),before=structuredClone(original);
  assert.deepEqual(Object.keys(proposal.request.body.questions),['combined_assessment']);
  assert.equal(proposal.request.body.questions.combined_assessment.type,'choice');
  assert.deepEqual(proposal.request.body.state.artist,original.request.body.state.artist);
  assert.deepEqual(proposal.request.body.state.candidate,original.request.body.state.candidate);
  assert.equal(proposal.originalCapture.bodySha256,capture.bodySha256);
  assert.ok(proposal.request.body.state.artist.releases[0].track_name.length>10000);
  assert.ok(!proposal.request.body.state.evidenceRules.includes('Return verdict likely'));
  assert.equal(proposal.executionEnabled,false);assert.equal(proposal.requiresFreshSpendingApproval,true);
  assert.notEqual(proposal.requestSha256,original.inputSha256);
  assert.equal(proposal.requestBytes,Buffer.byteLength(JSON.stringify(proposal.request.body)));
  assert.deepEqual(original,before);
  assert.equal(proposal.request.body.state.candidate.channelCapture.body.isOfficialArtistChannel,null);
});
test('every allowed choice has a single coherent interpretation, including unknown control and Topic labels',()=>{
  const {proposal}=fixture();
  for(const [category,definition] of Object.entries(COMBINED_ASSESSMENTS)){
    const result=parseCombinedOwnership(proposal,packet(proposal,category));
    assert.deepEqual(result.modelAssessment,{category,...definition});
    if(definition.artistOwned===true)assert.equal(definition.ownershipSupport,'supported');
    if(definition.ownershipSupport==='uncertain')assert.equal(definition.artistOwned,null);
    if(definition.channelType==='topic'){
      assert.equal(definition.artistOwned,false);
      assert.equal(result.channelTypeLabel,'Topic — auto-generated');
    }
    assert.equal(result.modelAnswer.derivedFromSingleChoice,true);
    assert.equal(result.channelId,proposal.originalOperation.channelId);
    assert.ok(!('sameIdentityProbability' in result.modelAnswer));
    assert.equal(result.ownershipAccepted,false);assert.equal(result.importEligible,false);
    assert.equal(result.catalogWritten,false);assert.equal(result.decision.reviewSuggestion,false);
  }
});
test('independent contradictory fields, unknown choices, wrong bindings and bad billing are rejected',()=>{
  const {proposal}=fixture();
  for(const change of [
    p=>p.data.answers.ownership_reason={type:'choice',choice:'identity_supported_control_uncertain'},
    p=>p.data.answers.channel_type={type:'choice',choice:'unknown'},
    p=>p.data.answers.combined_assessment.choice='invented',
    p=>p.data.answers.combined_assessment.type='noul',
    p=>delete p.data.answers.combined_assessment,
    p=>delete p.data.usage.cost,
    p=>p.data.usage.cost=.03,
    p=>p.data.model='different-model',
    p=>p.status=500,
    p=>p.inputSha256='0'.repeat(64),
    p=>p.request.body.state.artist.name='Another artist',
  ]){
    const p=structuredClone(packet(proposal,'artist_managed_supported'));change(p);
    assert.throws(()=>parseCombinedOwnership(proposal,p));
  }
  const changed=structuredClone(proposal);changed.request.body.questions.extra={type:'choice'};
  assert.throws(()=>parseCombinedOwnership(changed,packet(changed,'artist_managed_supported')));
});
test('a positive combined choice cannot bypass captured fan, label, Topic, Spotify or group conflicts',()=>{
  for(const body of [
    {description:'Fan channel for Artist'},
    {description:'Independent record label'},
    {name:'Artist - Topic'},
    {links:['https://open.spotify.com/artist/'+'B'.repeat(22)]},
    {name:'Example Band',description:'Artist is a member of Example Band'},
  ]){
    const {proposal}=fixture({body});
    const result=parseCombinedOwnership(proposal,packet(proposal,'artist_managed_supported'));
    assert.equal(result.decision.status,'experimental_safety_hold');
    assert.equal(result.ownershipAccepted,false);
  }
  const {proposal}=fixture();
  assert.equal(parseCombinedOwnership(proposal,packet(proposal,'artist_managed_supported'),
    {sharedChannel:true}).decision.status,'experimental_safety_hold');
  const topic=fixture({body:{name:'Artist - Topic'}}).proposal;
  const heldTopic=parseCombinedOwnership(topic,packet(topic,'artist_managed_supported'));
  assert.equal(heldTopic.channelTypeLabel,'Topic — auto-generated');
  assert.equal(heldTopic.decision.status,'experimental_safety_hold');
});
test('user-rejected group/member pairs remain blocked and new answers are never attached to old inputs',()=>{
  const {proposal,original}=fixture({profileId:'257398',cmArtist:'11498692',name:'William Jakrapatr',
    channelId:'UCso2wzxEVKV-f4iC3MJrRzA',body:{name:'LYKN'}});
  const result=parseCombinedOwnership(proposal,packet(proposal,'artist_managed_supported'));
  assert.equal(result.decision.status,'experimental_safety_hold');
  assert.equal(result.safety.reason,'user_rejected_artist_channel_pair');
  assert.equal(result.modelAnswer.inputSha256,proposal.stateSha256);
  assert.notEqual(result.modelAnswer.inputSha256,original.policyInputSha256);
  assert.equal(result.importEligible,false);
});
