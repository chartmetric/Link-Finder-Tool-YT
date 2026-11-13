import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceDigest,evaluateYoutubeOwnership,youtubeVerificationInput,youtubeOwnershipUrl,reviewYoutubeBatch} from './youtube-ownership-policy.mjs';
const id='UCabcdefghijklmnopqrstuv',url='https://www.youtube.com/@artist';
const spotify='https://open.spotify.com/artist/1234567890123456789012';
const artist={profileId:'1',cmArtist:'2',name:'Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
  accounts:[{platform:'spotify',url:spotify}],country:'US',label:'Label'};
const capture=(patch={})=>{const body={channelId:id,handle:'artist',url,displayName:'Artist',
  description:'Musician and label owner',externalUrls:[spotify],...patch};
return {requestedUrl:url,status:200,capturedAt:'2026-11-10T12:00:00Z',body,bodySha256:evidenceDigest(body)};};
const candidate=(patch={})=>({url,title:'Artist official',snippet:'An official musician',capture:capture(),...patch});
const answer=(c,a={})=>({inputSha256:youtubeVerificationInput(artist,c).inputSha256,
  answer:{verdict:'likely',sameIdentityProbability:.37,channelType:'artist_owned',...a}});

test('Search snippets, name and official wording never become channel metadata or ownership',()=>{
  const c=candidate({capture:null});
  assert.equal(evaluateYoutubeOwnership(artist,c).status,'needs_channel_metadata');
  assert.equal(youtubeVerificationInput(artist,c).state.candidate.channelCapture,null);
  assert.equal(evaluateYoutubeOwnership(artist,c,{answer:answer(c)}).reviewSuggestion,false);
  assert.equal(evaluateYoutubeOwnership(artist,candidate()).reviewSuggestion,false);
});
test('A bound likely verdict has no arbitrary .9 threshold; audience gaps and label ownership do not veto it',()=>{
  const c=candidate({capture:capture({subscribers:2})});
  const a={...artist,followers:500000};
  const input=youtubeVerificationInput(a,c);
  const result=evaluateYoutubeOwnership(a,c,{answer:{...answer(c),inputSha256:input.inputSha256}});
  assert.equal(result.reviewSuggestion,true);assert.equal(result.verified,false);
  assert.equal(result.score,.37);assert.equal(result.warnings.length,1);
  assert.equal(result.liveLinkAccepted,false);
});
test('captured group membership cannot promote a group channel as an individual artist match',()=>{
  const c=candidate({capture:capture({displayName:'Example Band',
    description:'Artist is a member of Example Band',isOfficialArtistChannel:true})});
  const decision=evaluateYoutubeOwnership(artist,c,{answer:answer(c,{sameIdentityProbability:.99})});
  assert.equal(decision.status,'ownership_conflict');
  assert.equal(decision.reason,'individual_member_is_not_group_channel_identity');
  assert.equal(decision.reviewSuggestion,false);
  assert.match(youtubeVerificationInput(artist,c).rules,/group or band and its individual members are separate identities/i);
  const solo=candidate({capture:capture({description:'Artist is a member of Example Band'})});
  assert.equal(evaluateYoutubeOwnership(artist,solo,{answer:answer(solo)}).reviewSuggestion,true,
    'A member may still have their own channel');
});
test('bound solo context holds explicit group channels but neither loose words nor unbound context veto a channel',()=>{
  const a={...artist,context:{chartmetric:{cm_artist:'2',band:0}}};
  const c=candidate({capture:capture({displayName:'Example Band',description:'We are a pop group'})});
  const input=youtubeVerificationInput(a,c);
  assert.equal(evaluateYoutubeOwnership(a,c,{answer:{...answer(c),inputSha256:input.inputSha256}}).reviewSuggestion,false);
  const unbound={...a,context:{chartmetric:{cm_artist:'999',band:0}}};
  assert.equal(evaluateYoutubeOwnership(unbound,c).status,'needs_identity_check');
  const ordinary=candidate({capture:capture({displayName:'Stage Alias',
    description:'My latest group performance is available now'})});
  assert.equal(evaluateYoutubeOwnership(a,ordinary).status,'needs_identity_check');
  const group={...a,name:'Example Band',context:{chartmetric:{cm_artist:'2',band:1}}};
  const groupInput=youtubeVerificationInput(group,c);
  assert.equal(evaluateYoutubeOwnership(group,c,{answer:{...answer(c),inputSha256:groupInput.inputSha256}}).reviewSuggestion,true,
    'A group remains eligible for its own channel');
});
test('William’s user-rejected LYKN pair stays rejected even with a positive model answer or a bound alias',()=>{
  const william={...artist,profileId:'257398',cmArtist:'11498692',name:'William Jakrapatr',
    catalogProfile:{profile_id:'257398',cm_artist:'11498692'}};
  const lykn='https://www.youtube.com/channel/UCso2wzxEVKV-f4iC3MJrRzA';
  const c={url:lykn,title:'LYKN',capture:null};
  assert.equal(evaluateYoutubeOwnership(william,c).reason,'user_rejected_artist_channel_pair');
  const alias='https://www.youtube.com/@lykn';
  const body={channelId:'UCso2wzxEVKV-f4iC3MJrRzA',handle:'lykn',url:alias,displayName:'LYKN',
    description:'Official channel',externalUrls:[]};
  const bound={url:alias,capture:{requestedUrl:alias,status:200,capturedAt:'2026-11-13T23:00:00Z',
    body,bodySha256:evidenceDigest(body)}};
  const input=youtubeVerificationInput(william,bound);
  const answerForWilliam={inputSha256:input.inputSha256,
    answer:{verdict:'likely',sameIdentityProbability:.99,channelType:'artist_owned'}};
  assert.equal(evaluateYoutubeOwnership(william,bound,{answer:answerForWilliam}).reviewSuggestion,false);
});
test('Confirmed Topic, fan and organizational channels do not pass despite matching music IDs or high scores',()=>{
  for(const [patch,type] of [
    [{displayName:'Artist - Topic'},'topic'],
    [{isAutoGenerated:true},'topic'],
    [{description:'Fan channel for Artist'},'fan'],
    [{description:'Independent record label'},'organization'],
  ]){
    const c=candidate({capture:capture(patch)});
    const r=evaluateYoutubeOwnership(artist,c,{answer:answer(c,{verdict:'verified',sameIdentityProbability:.99})});
    assert.equal(r.channelType,type);assert.equal(r.reviewSuggestion,false);
  }
});
test('Artist, alias, hash, input and channel-ID bindings cannot be substituted',()=>{
  const c=candidate();
  assert.throws(()=>youtubeVerificationInput({...artist,profileId:'9'},c),/Unbound/);
  assert.equal(evaluateYoutubeOwnership(artist,{...c,capture:{...c.capture,bodySha256:'0'.repeat(64)}}).status,'needs_channel_metadata');
  assert.equal(evaluateYoutubeOwnership(artist,candidate({capture:capture({handle:'somebody_else',url:'https://youtube.com/@somebody_else'})})).status,'needs_channel_metadata');
  assert.equal(evaluateYoutubeOwnership(artist,c,{answer:{...answer(c),inputSha256:'0'.repeat(64)}}).reviewSuggestion,false);
  const c2=candidate({url:'https://www.youtube.com/channel/'+id,capture:{...capture(),requestedUrl:'https://www.youtube.com/channel/'+id}});
  assert.equal(evaluateYoutubeOwnership(artist,c2,{answer:answer(c2)}).reviewSuggestion,true);
  const changedId=candidate({url:'https://www.youtube.com/channel/UCAbcdefghijklmnopqrstuv',capture:capture()});
  assert.equal(evaluateYoutubeOwnership(artist,changedId).reviewSuggestion,false);
});
test('Different music identities, reused channels and contradictory saved evidence require review',()=>{
  const c=candidate({capture:capture({externalUrls:['https://open.spotify.com/artist/abcdefghijklmnopqrstuv']})});
  assert.equal(evaluateYoutubeOwnership(artist,c,{answer:answer(c)}).status,'ownership_conflict');
  assert.equal(evaluateYoutubeOwnership(artist,candidate(),{sharedChannel:true}).reviewSuggestion,false);
  assert.equal(evaluateYoutubeOwnership(artist,candidate(),{contradictoryPair:true}).reviewSuggestion,false);
  const second={...artist,profileId:'3',cmArtist:'4',catalogProfile:{profile_id:'3',cm_artist:'4'}};
  assert.ok(reviewYoutubeBatch([{artist,candidates:[candidate()]},{artist:second,candidates:[candidate()]}])
    .every(r=>r.outcome==='ownership_conflict'));
});
test('Only a captured declaration from the exact catalog account can support the direct-link route',()=>{
  const body={sourceUrl:spotify,declaredLinks:[url]};
  const declaration={requestedUrl:spotify,status:200,capturedAt:'2026-11-10',body,bodySha256:evidenceDigest(body)};
  const a={...artist,declarations:[declaration]};
  assert.equal(evaluateYoutubeOwnership(a,candidate()).reviewSuggestion,true);
  assert.equal(evaluateYoutubeOwnership({...a,declarations:[{...declaration,requestedUrl:'https://example.test'}]},candidate()).reviewSuggestion,false);
});
test('No-match is a completed search assessment, not account absence; grading inputs are rejected',()=>{
  assert.equal(reviewYoutubeBatch([{artist,candidates:[],searchStatus:'no_match'}])[0].outcome,'completed_no_channel_result');
  assert.equal(reviewYoutubeBatch([{artist,candidates:[],searchStatus:'failed'}])[0].outcome,'incomplete_search');
  assert.throws(()=>youtubeVerificationInput({...artist,groundTruth:true},candidate()),/Grading/);
  assert.equal(youtubeOwnershipUrl('https://music.youtube.com/@Artist/videos'),'https://www.youtube.com/@artist');
  assert.equal(youtubeOwnershipUrl('https://youtube.com/watch?v=123'),null);
});
test('Badge alone and a high uncertain score cannot establish artist ownership',()=>{
  const c=candidate({capture:capture({isOfficialArtistChannel:true})});
  assert.equal(evaluateYoutubeOwnership(artist,c).reviewSuggestion,false);
  assert.equal(evaluateYoutubeOwnership(artist,c,{answer:answer(c,{verdict:'uncertain',sameIdentityProbability:.99})}).reviewSuggestion,false);
  assert.equal(evaluateYoutubeOwnership(artist,c,{answer:answer(c,{channelType:'unknown'})}).reviewSuggestion,false);
});
test('Two legitimately supported artist channels are preserved, not automatically called a conflict',()=>{
  const first=candidate(),second=candidate({url:'https://www.youtube.com/@second',
    capture:{...capture({handle:'second',url:'https://www.youtube.com/@second',channelId:'UCABCDEFGHIJKLMNOPQRSTUV'}),
      requestedUrl:'https://www.youtube.com/@second'}});
  first.recordedAnswer=answer(first);second.recordedAnswer=answer(second);
  const row=reviewYoutubeBatch([{artist,candidates:[first,second]}])[0];
  assert.equal(row.outcome,'multiple_likely_artist_channels');
  assert.ok(row.candidates.every(c=>c.decision.reviewSuggestion));
});
test('An exact first-party link still needs consistent self-identification for the direct route',()=>{
  const body={sourceUrl:spotify,declaredLinks:[url]};
  const a={...artist,declarations:[{requestedUrl:spotify,status:200,capturedAt:'2026-11-10',body,bodySha256:evidenceDigest(body)}]};
  assert.equal(evaluateYoutubeOwnership(a,candidate({capture:capture({displayName:'Different Person'})})).reviewSuggestion,false);
  assert.equal(evaluateYoutubeOwnership(artist,candidate({capture:{status:200,bodySha256:'a'.repeat(64),capturedAt:'2026-11-10',requestedUrl:url}})).reviewSuggestion,false);
});
test('Exact-host localized Spotify artist paths compare IDs without granting ownership or resolving unknown roles',()=>{
  for(const prefix of ['intl-pt','intl-en','intl-de','INTL-PT']){
    const c=candidate({capture:capture({externalUrls:[spotify.replace('/artist/','/'+prefix+'/artist/')+'?si=fixture']})});
    assert.equal(evaluateYoutubeOwnership(artist,c).status,'needs_identity_check');
    assert.equal(evaluateYoutubeOwnership(artist,c).reviewSuggestion,false);
    const result=evaluateYoutubeOwnership(artist,c,{answer:answer(c,{channelType:'unknown'})});
    assert.equal(result.reason,'recorded_model_uncertain_or_unresolved_channel_type');
    assert.equal(result.reviewSuggestion,false);
    const conflicting=candidate({capture:capture({externalUrls:[
      spotify, 'https://open.spotify.com/'+prefix+'/artist/abcdefghijklmnopqrstuv']})});
    assert.equal(evaluateYoutubeOwnership(artist,conflicting,{answer:answer(conflicting)}).status,'ownership_conflict');
    const localizedArtist={...artist,accounts:[{url:spotify.replace('/artist/','/'+prefix+'/artist/')}]};
    assert.equal(evaluateYoutubeOwnership(localizedArtist,conflicting).status,'ownership_conflict');
  }
  // Spotify artist IDs are case-sensitive even when the locale is not.
  const known={...artist,accounts:[{url:'https://open.spotify.com/artist/'+'A'.repeat(22)}]};
  const c=candidate({capture:capture({externalUrls:['https://open.spotify.com/intl-pt/artist/'+'a'.repeat(22)]})});
  assert.equal(evaluateYoutubeOwnership(known,c).status,'ownership_conflict');
});
test('Spoofed Spotify hosts, credentials, ports and unsupported paths do not supply music IDs',()=>{
  const conflictingId='abcdefghijklmnopqrstuv';
  for(const raw of [
    'https://open.spotify.com.evil.test/intl-pt/artist/',
    'https://www.open.spotify.com/intl-pt/artist/',
    'https://open.spotify.com@evil.test/intl-pt/artist/',
    'https://evil.test@open.spotify.com/intl-pt/artist/',
    'https://open.spotify.com:444/intl-pt/artist/',
    'http://open.spotify.com/intl-pt/artist/',
    'https://open.spotify.com/arbitrary/artist/',
    'https://open.spotify.com/intl-pt/album/',
    'https://open.spotify.com/intl-pt-BR/artist/',
    'https://open.spotify.com/intl-pt/intl-en/artist/',
  ]){
    const c=candidate({capture:capture({externalUrls:[raw+conflictingId]})});
    const decision=evaluateYoutubeOwnership(artist,c);
    assert.equal(decision.status,'needs_identity_check',raw);
    assert.equal(decision.reviewSuggestion,false);
  }
  const shared=candidate({capture:capture({externalUrls:[spotify.replace('/artist/','/intl-pt/artist/')]})});
  assert.equal(evaluateYoutubeOwnership(artist,shared,{sharedChannel:true}).status,'ownership_conflict');
  assert.equal(evaluateYoutubeOwnership(artist,shared,{contradictoryPair:true}).status,'ownership_conflict');
});
