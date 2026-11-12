import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateYoutubeLink} from './youtube-topic-links.mjs';
import {evidenceDigest,evaluateYoutubeOwnership} from './youtube-ownership-policy.mjs';
import {rankYoutubeSearchCandidates,youtubeSearchPlan} from './youtube-search-plan.mjs';
import {classifyYoutubeResult} from './youtube-campaign-core.mjs';
const spotify='https://open.spotify.com/artist/1234567890123456789012';
const url='https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv';
const artist={profileId:'1',cmArtist:'2',name:'Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
  accounts:[{platform:'spotify',url:spotify}]};
const candidate=(patch={})=>{
  const body={channelId:'UCabcdefghijklmnopqrstuv',url,displayName:'Artist - Topic',
    externalUrls:[],...patch};
  return {url,title:'Artist - Topic',capture:{requestedUrl:url,status:200,capturedAt:'2026-11-12T00:00:00Z',
    body,bodySha256:evidenceDigest(body)}};
};
test('supported Topic is included but is never artist-owned or verified; historical ownership evaluator unchanged',()=>{
  const c=candidate({externalUrls:[spotify]}),before=JSON.stringify(c);
  const d=evaluateYoutubeLink(artist,c);
  assert.equal(d.status,'supported_topic');assert.equal(d.reviewSuggestion,true);
  assert.equal(d.channelType,'topic');assert.equal(d.artistOwned,false);
  assert.equal(d.verified,false);assert.equal(d.liveLinkAccepted,false);
  assert.equal(evaluateYoutubeOwnership(artist,c).reviewSuggestion,false);
  assert.equal(JSON.stringify(c),before);
  assert.equal(classifyYoutubeResult({searchStatus:'candidates_found',candidates:[{decision:d}]}).checked,true);
});
test('name alone, high saved answer, missing capture, wrong artist and shared channel cannot authorize Topic',()=>{
  const c=candidate();
  assert.equal(evaluateYoutubeLink(artist,c).reviewSuggestion,false);
  assert.equal(evaluateYoutubeLink(artist,c,{answer:{answer:{verdict:'likely',sameIdentityProbability:.99}}}).reviewSuggestion,false);
  assert.equal(evaluateYoutubeLink(artist,candidate({displayName:'Someone Else - Topic',externalUrls:[spotify]})).reviewSuggestion,false);
  assert.equal(evaluateYoutubeLink(artist,{...c,capture:null}).reviewSuggestion,false);
  for(const options of [{sharedChannel:true},{contradictoryPair:true}])
    assert.equal(evaluateYoutubeLink(artist,candidate({externalUrls:[spotify]}),options).reviewSuggestion,false);
  assert.throws(()=>evaluateYoutubeLink({...artist,profileId:'9'},c),/Unbound/);
});
test('Spotify conflict is preserved even when a Topic channel has the right name',()=>{
  const d=evaluateYoutubeLink(artist,candidate({externalUrls:[spotify,'https://open.spotify.com/artist/abcdefghijklmnopqrstuv']}));
  assert.equal(d.status,'ownership_conflict');assert.equal(d.reviewSuggestion,false);
});
test('captured exact catalog declarations can support Topic; unbound or modified declarations cannot',()=>{
  const body={sourceUrl:spotify,declaredLinks:[url]};
  const declaration={requestedUrl:spotify,status:200,capturedAt:'2026-11-12',body,bodySha256:evidenceDigest(body)};
  const a={...artist,declarations:[declaration]};
  assert.equal(evaluateYoutubeLink(a,candidate()).status,'supported_topic');
  assert.equal(evaluateYoutubeLink({...a,declarations:[{...declaration,bodySha256:'0'.repeat(64)}]},candidate()).reviewSuggestion,false);
});
test('new discovery includes Topic within the same two slots, while legacy selection remains unchanged',()=>{
  const topic={url,title:'Artist - Topic',snippet:'Artist music'};
  const other={url:'https://www.youtube.com/@other',title:'Other',snippet:'music'};
  const plan=youtubeSearchPlan(artist);
  assert.equal(rankYoutubeSearchCandidates([topic,other],plan,{limit:2}).candidates.length,1);
  const d=rankYoutubeSearchCandidates([topic,other],plan,{limit:2,includeTopicChannels:true});
  assert.equal(d.candidates.length,2);assert.ok(d.candidates.some(c=>c.url===url));
});
