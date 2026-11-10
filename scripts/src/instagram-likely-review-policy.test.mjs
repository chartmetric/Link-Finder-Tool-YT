import test from 'node:test';
import assert from 'node:assert/strict';
import {likelyReviewSuggestion} from './instagram-likely-review-policy.mjs';
const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA',other='https://open.spotify.com/artist/BBBBBBBBBBBBBBBBBBBBBB';
const url='https://www.instagram.com/real_person/';
const player={profile_id:'1',artist:'Stage Name',account_ids:['2'],accounts:[{account_id:'2',platform:'spotify',account_url:music}]};
const fixture=()=>({url,identityComparison:{status:'mismatch',reasons:['historical workflow label'],
  reference:{url:music},candidate:{url,displayName:'A Different Name',bio:'Producer. Label owner.'}},
  jevVerification:{verdict:'likely',sameIdentityProbability:0.31}});
test('likely is a review suggestion without names, backlink or a score cutoff, never verification',()=>{
  const p=fixture(),before=JSON.stringify(p),r=likelyReviewSuggestion(p,player);
  assert.equal(r.reviewSuggestion,true);assert.equal(r.verified,false);assert.equal(r.liveLinkAccepted,false);
  assert.equal(JSON.stringify(p),before);
  p.jevVerification.verdict='verified';assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,true);
  for(const bio of ['DJ. Label owner @label','Singer signed to a record label','New show at a music venue','Label boss @label']){
    p.identityComparison.candidate.bio=bio;assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,true,bio);
  }
});
test('model holds, missing source binding, malformed answers, shared identities and recorded conflicts remain held',()=>{
  for(const mutate of [
    p=>{p.jevVerification.verdict='uncertain';},p=>{p.jevVerification.verdict='mismatch';},
    p=>{p.jevVerification.sameIdentityProbability=NaN;},p=>{p.jevVerification.sameIdentityProbability=1.1;},
    p=>{p.identityComparison.reference.url=other;},p=>{p.identityComparison.candidate.url='https://www.instagram.com/other/';},
    p=>{p.contradictions=['source conflict'];},p=>{p.conflictingProfileIds={malformed:true};},
  ]){const p=fixture();mutate(p);assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,false);}
  assert.equal(likelyReviewSuggestion(fixture(),player,{sharedHandle:true}).reviewSuggestion,false);
  assert.equal(likelyReviewSuggestion(fixture(),player,{contradictoryPair:true}).reviewSuggestion,false);
  const inactive={...player,accounts:player.accounts.map(a=>({...a,is_active:false}))};
  assert.equal(likelyReviewSuggestion(fixture(),inactive).reviewSuggestion,false);
  const leaked=fixture();leaked.expectedArtistOwned=true;assert.throws(()=>likelyReviewSuggestion(leaked,player),/Grading/);
});
test('explicit fan/organization accounts and independently observed different music IDs are conflict holds',()=>{
  for(const bio of ['Fan account for Stage Name','Official fan page','A record label for musicians','We are a booking agency','非公式アカウント']){
    const p=fixture();p.identityComparison.candidate.bio=bio;
    assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,false,bio);
  }
  const p=fixture();p.identityComparison.candidate.directExternalUrls=[other];
  assert.equal(likelyReviewSuggestion(p,player).reason,'different_observed_spotify_artist_id');
  p.identityComparison.candidate.directExternalUrls=['https://links.example/artist'];
  p.identityComparison.candidate.externalLinkEvidence={pages:[{sourceUrl:'https://links.example/artist',status:200,
    bodySha256:'a'.repeat(64),linkEvidence:[{sourceUrl:'https://links.example/artist',targetUrl:other,kind:'declared_profile_link'}]}]};
  assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,false);
  p.identityComparison.candidate.externalLinkEvidence.pages[0].bodySha256='unconfirmed';
  assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,true);
  p.identityComparison.candidate.directExternalUrls=[music];
  assert.equal(likelyReviewSuggestion(p,player).reviewSuggestion,true);
});
