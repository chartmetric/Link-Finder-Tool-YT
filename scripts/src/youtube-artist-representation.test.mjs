import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {revisedContextRequest} from './youtube-context-revision.mjs';
import {reviewedVerificationFixture} from './youtube-reviewed-verification-fixture.mjs';
import {artistRepresentationRequest,parseArtistRepresentationResponse,representationReviewGate,
  catalogReferenceKey,exactCatalogLinks,REPRESENTATION_RULES} from './youtube-artist-representation.mjs';

const spotify='https://open.spotify.com/artist/3UvBjnS0xNdifivRctkxok';
function fixture({accounts=true,links=[spotify],profileId='123',cmArtist='456',
  channelId='UC'+'z'.repeat(22),name='Distinct Artist',description='My music project.'}={}){
  const url='https://www.youtube.com/channel/'+channelId;
  const artist={profileId,cmArtist,name,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
    accounts:accounts?[{profile_id:profileId,cm_artist:cmArtist,account_id:'789',
      platform:'spotify',account_url:spotify,is_active:1,disconnected_at:null}]:[],releases:[]};
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url})};
  const capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-17T23:00:00Z',
    request,inputSha256:digest(request),
    data:{success:true,channelId,channel:url,name,description,links}},url);
  const input=youtubeVerificationInput(artist,{url,capture});
  const prepared=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
    expectedModel:'typesafe/jev-1.13',maxRequestBytes:24576}});
  const original={key:'synthetic',kind:'model',profileId,cmArtist,channelId,
    request:prepared.request,inputSha256:prepared.inputSha256,policyInputSha256:input.inputSha256,
    requestBytes:prepared.bytes,requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),
    proposedReservationCents:2};
  return {original,capture,proposal:artistRepresentationRequest(original,capture)};
}
function response(p,choice='artist_representation_supported'){
  return {kind:'model',status:200,request:p.request,inputSha256:p.requestSha256,
    profileId:p.originalOperation.profileId,cmArtist:p.originalOperation.cmArtist,
    data:{model:'typesafe/jev-1.13-20260917',usage:{cost:.0001},
      answers:{combined_assessment:{type:'choice',choice}}}};
}
test('supports artist representation without inventing management, verification or import approval',()=>{
  const {proposal:p}=fixture(),r=parseArtistRepresentationResponse(p,response(p));
  assert.equal(r.decision.reviewSuggestion,true);
  assert.equal(r.modelAssessment.artistOwned,null);
  assert.equal(r.modelAssessment.ownershipSupport,'uncertain');
  assert.equal(r.channelTypeLabel,'Artist-facing — management unverified');
  for(const x of [r.ownershipAccepted,r.importEligible,r.catalogWritten,r.policyActivated,
    r.decision.verified,r.decision.liveLinkAccepted])assert.equal(x,false);
});
test('name-only and unbound outbound accounts stay held even if a model overstates support',()=>{
  for(const options of [{accounts:false},{links:[]},
    {links:['https://open.spotify.com/artist/'+ 'A'.repeat(22)]}]){
    const {proposal:p}=fixture(options),r=parseArtistRepresentationResponse(p,response(p));
    assert.equal(r.decision.reviewSuggestion,false);
    assert.equal(r.decision.status,'experimental_safety_hold');
  }
});
test('retains exact artist binding and active references across Spotify, Instagram, TikTok, X and Facebook',()=>{
  const {proposal:p}=fixture(),state=structuredClone(p.request.body.state);
  const urls=['https://instagram.com/artist','https://tiktok.com/@artist',
    'https://x.com/artist','https://facebook.com/profile.php?id=1234'];
  for(const [i,url] of urls.entries())state.artist.accounts.push({
    profile_id:'123',cm_artist:'456',account_id:String(i),is_active:true,disconnected_at:null,account_url:url});
  state.candidate.channelCapture.body.externalUrls.push(...urls);
  const links=exactCatalogLinks(state);
  assert.equal(links.length,5);assert.ok(links.every(l=>l.establishesOwnership===false));
  state.artist.accounts[0].is_active=0;assert.equal(exactCatalogLinks(state).length,4);
  state.artist.accounts[1].disconnected_at='2026-11-01';assert.equal(exactCatalogLinks(state).length,3);
  state.artist.accounts[2].cm_artist='999';assert.throws(()=>exactCatalogLinks(state));
});
test('URL comparison never invents aliases, merges Spotify ID case, or accepts posts and lookalikes',()=>{
  assert.equal(catalogReferenceKey('https://open.spotify.com/intl-ar/artist/3UvBjnS0xNdifivRctkxok?si=x'),
    catalogReferenceKey(spotify));
  assert.notEqual(catalogReferenceKey(spotify.toLowerCase()),catalogReferenceKey(spotify));
  assert.equal(catalogReferenceKey('https://twitter.com/Artist'),catalogReferenceKey('https://x.com/artist'));
  assert.notEqual(catalogReferenceKey('https://facebook.com/profile.php?id=1'),
    catalogReferenceKey('https://facebook.com/profile.php?id=2'));
  for(const u of ['https://open.spotify.com.evil.example/artist/3UvBjnS0xNdifivRctkxok',
    'https://user:password@instagram.com/artist','https://instagram.com:123/artist',
    'https://instagram.com/p/post','https://tiktok.com/@artist/video/123',
    'https://instagram.com/artist/new','https://facebook.com/watch','https://x.com/intent',
    'https://facebook.com/profile.php?id=1&id=2',
    spotify.replace('/artist/','/track/')])assert.equal(catalogReferenceKey(u),null,u);
});
test('shared channels, contradictory sources and known group/member rejection cannot become suggestions',()=>{
  const {proposal:p}=fixture();
  for(const options of [{sharedChannel:true},{contradictoryPair:true}]){
    assert.equal(representationReviewGate(p,options).eligible,false);
    assert.equal(parseArtistRepresentationResponse(p,response(p),options).decision.reviewSuggestion,false);
  }
  const {proposal:bad}=fixture({profileId:'257398',cmArtist:'11498692',
    channelId:'UCso2wzxEVKV-f4iC3MJrRzA',name:'William Jakrapatr'});
  assert.equal(parseArtistRepresentationResponse(bad,response(bad)).decision.reviewSuggestion,false);
});
test('exact catalog links cannot override explicit fan or multi-artist label captures',()=>{
  for(const description of ['This is a fan channel. Not affiliated with the artist.',
    'We are an independent record label and music distributor.']){
    const {proposal:p}=fixture({description});
    assert.equal(parseArtistRepresentationResponse(p,response(p)).decision.reviewSuggestion,false);
  }
});
test('third-party, wrong-artist, ambiguous and weak captures remain held; Topic stays explicitly labeled',()=>{
  const {proposal:p}=fixture();
  for(const category of ['third_party_channel','different_artist','identity_uncertain',
    'conflicting_evidence','insufficient_capture','identity_supported_control_uncertain']){
    const r=parseArtistRepresentationResponse(p,response(p,category));
    assert.equal(r.decision.reviewSuggestion,false);assert.equal(r.modelAssessment.category,category);
  }
  const {proposal:topic}=fixture({name:'Distinct Artist - Topic'});
  const r=parseArtistRepresentationResponse(topic,response(topic,'topic_identity_supported'));
  assert.equal(r.channelTypeLabel,'Topic — auto-generated');assert.equal(r.modelAssessment.artistOwned,false);
  assert.equal(parseArtistRepresentationResponse(topic,response(topic)).decision.reviewSuggestion,false);
});
test('source fields and historical questions stay immutable; feedback never enters a request',()=>{
  const {original,capture}=fixture(),before=structuredClone(original);
  const archived=revisedContextRequest(original,capture),p=artistRepresentationRequest(original,capture);
  assert.deepEqual(p.request.body.state.artist,archived.request.body.state.artist);
  assert.deepEqual(p.request.body.state.candidate,archived.request.body.state.candidate);
  assert.deepEqual(revisedContextRequest(original,capture),archived);
  assert.deepEqual(original,before);assert.notEqual(p.requestSha256,archived.requestSha256);
  assert.deepEqual(Object.keys(p.request.body.questions),['combined_assessment']);
  assert.doesNotMatch(JSON.stringify(p.request),/"(?:userFeedback|userReview|grading|expectedVerdict)"\s*:/i);
  assert.equal(p.executionEnabled,false);assert.equal(p.requiresFreshSpendingApproval,true);
  assert.equal(p.requestBytes,Buffer.byteLength(JSON.stringify(p.request.body)));
  assert.doesNotMatch(p.request.body.state.evidenceRules,/Judge exact artist ownership|Return verdict likely/);
  assert.match(REPRESENTATION_RULES,/group is not its individual member/);
  assert.match(REPRESENTATION_RULES,/lyrics uploader/);
});
test('wrong receipts, altered source/request, extra answers, invalid model or billing cannot be interpreted',()=>{
  const {proposal:p}=fixture();
  for(const change of [r=>r.kind='metadata',r=>r.status=500,r=>r.inputSha256='0'.repeat(64),
    r=>r.profileId='999',r=>r.cmArtist='999',r=>r.channelId='UC'+'a'.repeat(22),
    r=>r.data.model='other',r=>r.data.usage.cost=.03,r=>delete r.data.usage,
    r=>r.data.answers.extra={type:'choice',choice:'yes'},
    r=>r.data.answers.combined_assessment.choice='new_unapproved_outcome']){
    const r=structuredClone(response(p));change(r);
    assert.throws(()=>parseArtistRepresentationResponse(p,r));
  }
  const mutated=structuredClone(p);mutated.request.body.state.artist.name='Other';
  assert.throws(()=>parseArtistRepresentationResponse(mutated,response(mutated)));
  const over=artistRepresentationRequest(p.originalOperation,p.originalCapture,[],100);
  assert.equal(over.readyForComparison,false);
  assert.deepEqual(over.request,p.request);
  assert.throws(()=>parseArtistRepresentationResponse(over,response(over)));
});
test('the exposed synthetic reviewed examples still retain their original single-choice contract',()=>{
  const {plan}=reviewedVerificationFixture();
  for(const op of plan.operations){
    const p=artistRepresentationRequest(op.proposal.originalOperation,op.proposal.originalCapture);
    assert.equal(Object.keys(op.request.body.questions.combined_assessment.criteria).length,9);
    assert.equal(Object.keys(p.request.body.questions.combined_assessment.criteria).length,10);
    assert.equal(p.request.body.state.evidenceNavigation.exactCatalogLinks.length,0);
  }
});
