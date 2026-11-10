import test from 'node:test';
import assert from 'node:assert/strict';
import {assessInstagramCandidates, CORROBORATED_POLICY} from './musician-instagram-matching.mjs';
import {jevRequest, fitArtistContext} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';

const music = 'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const other = 'https://open.spotify.com/artist/BBBBBBBBBBBBBBBBBBBBBB';
const instagram = 'https://www.instagram.com/example_artist/';
const page = 'https://linktr.ee/example_artist';
const player = {profile_id:'1', artist:'Example Artist', account_ids:['2','3','4'], accounts:[
  {profile_id:'1', account_id:'2', platform:'spotify', account_url:music},
  {profile_id:'1', account_id:'3', platform:'youtube', account_url:'https://www.youtube.com/@example_artist'},
  {profile_id:'1', account_id:'4', platform:'tiktok', account_url:'https://www.tiktok.com/@example_artist'},
]};
const result = p => ({methodsUsed:[{method:'serper', status:'used'}], profiles:Array.isArray(p)?p:[p]});
function fixture() {
  return {url:instagram, title:'Example Artist', identityComparison:{
    status:'likely', reference:{url:music, platform:'spotify', displayName:'Example Artist'},
    candidate:{url:instagram, displayName:'Example Artist', bio:'Singer and songwriter. New single out now!',
      directExternalUrls:[page], externalUrls:[page],
      externalLinkEvidence:{sourceUrl:page, status:'exact_catalog_music_identity', pages:[
        {sourceUrl:page, status:200, bodySha256:'a'.repeat(64), musicTargets:[music],
          linkEvidence:[{sourceUrl:page, targetUrl:music, kind:'declared_profile_link'}]},
      ]}},
  }, jevVerification:{verdict:'likely', sameIdentityProbability:0.47}};
}
const assess = (p, extra={}) => assessInstagramCandidates(result(p), player,
  {policy:CORROBORATED_POLICY, mode:'offline', ...extra});

test('a captured exact-ID path with self-identification can pass below .9 without changing model scores', () => {
  const p=fixture(), before=JSON.stringify(p);
  const a=assess(p);
  assert.deepEqual(a.simulationUrls,[instagram]);
  assert.equal(a.candidates[0].route,'catalog_music_path_and_artist_self_identification');
  assert.equal(JSON.stringify(p),before);
  assert.deepEqual(a.urls,[]);
  assert.equal(a.approvedCatalogLinks,false);
  assert.equal(a.productionApproved,false);
  assert.equal(a.noAccountConfirmed,false);
  assert.equal(a.newModelCalls,0);
  assert.throws(()=>assessInstagramCandidates(result(p),player,{policy:CORROBORATED_POLICY}),/offline/);
  assert.throws(()=>assessInstagramCandidates(result(p),player,{policy:'unknown'}),/Unknown/);
  assert.deepEqual(assessInstagramCandidates(result(p),player).urls,[], 'historical policy stays reproducible');
});

test('multiple exact frozen catalog accounts plus self-identification do not require Spotify', () => {
  const p=fixture(), c=p.identityComparison.candidate;
  c.bio='公式Instagram'; delete c.externalLinkEvidence;
  c.directExternalUrls=c.externalUrls=player.accounts.slice(1).map(a=>a.account_url);
  assert.equal(assess(p).candidates[0].route,'multiple_catalog_accounts_and_self_identification');
  c.directExternalUrls=c.externalUrls=[player.accounts[1].account_url];
  assert.deepEqual(assess(p).simulationUrls,[]);
});

function releaseFixture() {
  const p=fixture(), c=p.identityComparison.candidate;
  c.bio='Singer. Listen to Silver Horizon and Velvet River.';
  c.directExternalUrls=c.externalUrls=[]; delete c.externalLinkEvidence;
  p.discoveryEvidence=[{kind:'post_caption_owner',sourceUrl:'https://www.instagram.com/p/Release123/',
    title:'Example Artist — Silver Horizon',snippet:'35 likes, 2 comments - example_artist on July 19, 2026: \"Listen to my new single Silver Horizon\".'}];
  const context={profileId:'1', metadata:{ownershipConfirmed:false, items:[
    {kind:'release',source:'frozen_catalog',text:'Silver Horizon — Silver Horizon'},
    {kind:'release',source:'frozen_catalog',text:'Velvet River — Velvet River'},
  ]}};
  return {p,context};
}
test('distinctive releases and an attributed first-person release post provide a no-music-link route', () => {
  const {p,context}=releaseFixture();
  assert.equal(assess(p,{context}).candidates[0].route,'catalog_releases_and_self_attributed_release_post');
  for(const mutate of [
    f=>{f.context.profileId='someone_else';},
    f=>{f.context.metadata.items.pop();},
    f=>{f.p.discoveryEvidence[0].snippet=f.p.discoveryEvidence[0].snippet.replace('example_artist','someone_else');},
    f=>{f.p.discoveryEvidence[0].snippet+=' My cover remix';},
    f=>{f.p.discoveryEvidence[0].snippet=f.p.discoveryEvidence[0].snippet.replace('my new single','a single');},
    f=>{f.context.metadata.items.forEach(i=>{i.stale=true;});},
  ]) {const f=releaseFixture();mutate(f);assert.deepEqual(assess(f.p,{context:f.context}).simulationUrls,[]);}
});
test('non-Latin artist roles and first-person words use Unicode boundaries', () => {
  const {p,context}=releaseFixture();
  p.identityComparison.candidate.bio='Певица. Silver Horizon и Velvet River.';
  p.discoveryEvidence[0].snippet='35 likes - example_artist on July 19, 2026: \"Слушайте мой новый трек Silver Horizon\".';
  assert.equal(assess(p,{context}).candidates[0].route,'catalog_releases_and_self_attributed_release_post');
  const korean=fixture();korean.identityComparison.candidate.bio='가수';
  assert.equal(assess(korean).candidates[0].route,'catalog_music_path_and_artist_self_identification');
  p.identityComparison.candidate.bio='Фан аккаунт певицы. Silver Horizon и Velvet River.';
  assert.deepEqual(assess(p,{context}).simulationUrls,[]);
});

test('diverse related entities, ambiguous assessments and malformed evidence remain held', () => {
  for(const bio of ['Record label','Festival official','Venue for musicians','Fan account','Fan club',
    'Fankonto','非公式ファン','팬 계정','Tribute musician','Manufacturer']) {
    const p=fixture();p.identityComparison.candidate.bio=bio;
    assert.deepEqual(assess(p).simulationUrls,[],bio);
  }
  for(const mutate of [
    p=>{p.jevVerification.verdict='mismatch';},
    p=>{p.jevVerification.verdict='uncertain';},
    p=>{p.jevVerification.sameIdentityProbability=99;},
    p=>{delete p.jevVerification;},
    p=>{p.contradictions=['different catalog identity'];},
    p=>{p.conflictingProfileIds={unexpected:true};},
    p=>{p.identityComparison.reference.url=other;},
    p=>{p.identityComparison.candidate.url='https://www.instagram.com/another_artist/';},
    p=>{p.identityComparison.candidate.displayName='Someone Else';},
    p=>{p.identityComparison.candidate.bio='';},
    p=>{p.identityComparison.candidate.externalLinkEvidence.pages[0].linkEvidence[0].targetUrl=other;},
    p=>{p.identityComparison.candidate.externalLinkEvidence.pages[0].linkEvidence.push(
      {sourceUrl:page,targetUrl:other,kind:'declared_profile_link'});},
    p=>{p.identityComparison.candidate.externalLinkEvidence.pages[0].sourceUrl=page+'?different_artist';},
    p=>{delete p.identityComparison.candidate.externalLinkEvidence.pages[0].bodySha256;},
    p=>{p.identityComparison.candidate.externalLinkEvidence.pages[0].linkEvidence=[];},
    p=>{p.identityComparison.candidate.directExternalUrls=[];},
  ]) {const p=fixture();mutate(p);assert.deepEqual(assess(p).simulationUrls,[]);}
});

test('duplicate conflicts, inactive catalog identities and grading leakage fail closed', () => {
  const p=fixture(), conflict=fixture();conflict.jevVerification.verdict='mismatch';
  assert.deepEqual(assess([p,conflict]).simulationUrls,[]);
  assert.equal(assess([p,conflict]).candidates[0].reason,'conflicting_duplicate_occurrence');
  assert.deepEqual(assessInstagramCandidates(result(p),{...player,accounts:player.accounts.map(a=>({...a,is_active:0}))},
    {policy:CORROBORATED_POLICY,mode:'offline'}).simulationUrls,[]);
  p.expectedArtistOwned=true;
  assert.throws(()=>assess(p),/Grading field/);
});

test('new rubric supports corroboration and preserves missing/negative evidence rules and byte caps', () => {
  const p=fixture();
  const payload={artist:player.artist,catalogReference:{platform:'spotify',url:music},profiles:[p],ownershipRubric:CORROBORATED_RUBRIC};
  const before=JSON.stringify(payload), req=jevRequest(fitArtistContext(payload,6000));
  assert.match(req.questions.candidate_0_verdict.criteria.verified,/No mandatory backlink/);
  assert.doesNotMatch(JSON.stringify(req.state),/identityComparisonStatus|identityComparisonReasons|expectedArtistOwned/);
  assert.ok(Buffer.byteLength(JSON.stringify(req))<=6000);
  assert.equal(JSON.stringify(payload),before);
  assert.deepEqual(assess([]).simulationUrls,[]);
  assert.equal(assess([]).noAccountConfirmed,false);
});
