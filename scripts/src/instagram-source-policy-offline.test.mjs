import test from 'node:test';
import assert from 'node:assert/strict';
import {assessOfflineSourcePolicy,sealOfflineSnapshot} from './instagram-source-policy-offline.mjs';
import {assessInstagramCandidates} from './musician-instagram-matching.mjs';

const now=Date.parse('2026-11-09T20:00:00Z'),at='2026-11-09T19:00:00Z';
const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA',ig='https://www.instagram.com/example_artist_/';
function fixture(){
  const player={profile_id:'1',artist:'Example Artist',account_ids:['11'],
    accounts:[{account_id:'11',profile_id:'1',platform:'spotify',account_url:music}]};
  const candidate={url:ig,title:'Example Artist',ownershipContext:'artist_account',
    identityComparison:{status:'likely',reference:{url:music,externalUrls:[]},
      candidate:{url:ig,displayName:'Example Artist',bio:'Singer',externalUrls:[]}},
    jevVerification:{verdict:'verified',sameIdentityProbability:0.84,model:'fixture-model',
      observedAt:at,profileId:'1',accountUrl:ig,requestSha256:'c'.repeat(64)}};
  const page={sourceUrl:'https://artist.example/',observedAt:at,bodySha256:'a'.repeat(64),links:[
    {url:music,contextKind:'artist_specific',contextId:'artist'},
    {url:ig,contextKind:'artist_specific',contextId:'artist'}]};
  const catalogDeclaration={kind:'catalog_reference_external_links',sourceUrl:music,
    observedAt:at,bodySha256:'b'.repeat(64),links:['https://artist.example/']};
  return {now,player,result:{methodsUsed:[{method:'serper',status:'used'}],profiles:[candidate]},
    websiteEvidence:[{profileId:'1',page:sealOfflineSnapshot(page),
      catalogDeclaration:sealOfflineSnapshot(catalogDeclaration)}],
    // Deliberately arbitrary fixture values, NOT recommended/approved thresholds.
    config:{mode:'offline',minimumSourceIdentityScore:0.83,
      maxEvidenceAgeMs:86400000,maxVerifierAgeMs:86400000}};
}
function run(f){return assessOfflineSourcePolicy(f);}
function reseal(f,key,modify){
  const {packetSha256,...snapshot}=f.websiteEvidence[0][key];modify(snapshot);
  f.websiteEvidence[0][key]=sealOfflineSnapshot(snapshot);
}

test('synthetic source proof can pass only simulation, without changing default matching or inputs',()=>{
  const f=fixture(),before=structuredClone(f),base=assessInstagramCandidates(f.result,f.player);
  assert.deepEqual(base.urls,[]);
  const out=run(f);assert.deepEqual(f,before);
  assert.equal(out.candidates[0].route,'source_confirmed_simulation');
  assert.deepEqual(out.simulationUrls,[ig]);assert.equal(out.claimsAllowed,false);
  assert.equal(out.productionApproved,false);assert.equal(out.thresholdCalibrated,false);
  assert.deepEqual(assessInstagramCandidates(f.result,f.player),base);
});
test('no implicit source threshold, freshness window or live mode',()=>{
  for(const modify of [f=>delete f.config.minimumSourceIdentityScore,
    f=>delete f.config.maxEvidenceAgeMs,f=>f.config.maxVerifierAgeMs=0,
    f=>f.config.minimumSourceIdentityScore=NaN,f=>f.config.minimumSourceIdentityScore=1.2,
    f=>f.config.mode='live',f=>delete f.now]){
    const f=fixture();modify(f);assert.deepEqual(run(f).simulationUrls,[]);
  }
});
test('higher explicit experimental floor holds the same evidence without touching standard 0.90 route',()=>{
  const f=fixture();f.config.minimumSourceIdentityScore=0.85;
  assert.equal(run(f).candidates[0].simulationAccepted,false);
  const c=f.result.profiles[0];c.jevVerification.sameIdentityProbability=0.95;
  c.identityComparison.candidate.externalUrls=[music];delete f.config.minimumSourceIdentityScore;
  assert.equal(run(f).candidates[0].route,'existing_supported');
});
test('self-links, search assertions, wrong source identity, stale/future/tampered proof cannot establish trust',()=>{
  for(const modify of [
    f=>reseal(f,'catalogDeclaration',p=>p.kind='search_result'),
    f=>reseal(f,'catalogDeclaration',p=>p.sourceUrl=ig),
    f=>reseal(f,'catalogDeclaration',p=>p.links=['https://lookalike.example/']),
    f=>reseal(f,'catalogDeclaration',p=>p.observedAt='2026-11-01T00:00:00Z'),
    f=>reseal(f,'page',p=>p.observedAt='2026-11-10T00:00:00Z'),
    f=>f.websiteEvidence[0].page.links[0].url=music+'X',
    f=>f.websiteEvidence[0].profileId='2',
    f=>f.player.accounts[0].disconnected_at=at,
    f=>f.player.accounts[0].profile_id='2',
    f=>reseal(f,'page',p=>p.sourceUrl='https://password:secret@artist.example/'),
  ]){const f=fixture();modify(f);assert.deepEqual(run(f).simulationUrls,[]);}
});
test('global footer, promotion, wrong ID, release URLs, posts and different artist sections stay held',()=>{
  for(const modify of [
    p=>p.links[1].contextKind='global_footer',
    p=>p.links[1].contextKind='promoted_creator',
    p=>p.links[1].contextId='another_artist',
    p=>p.links[0].url=music.replaceAll('A','B'),
    p=>p.links[0].url=music.replace('/artist/','/album/'),
    p=>p.links[1].url='https://www.instagram.com/p/a_post/',
    p=>p.links[1].url='https://www.instagram.com/example_artist/',
  ]){const f=fixture();reseal(f,'page',modify);assert.deepEqual(run(f).simulationUrls,[]);}
});
test('related entities and conflicts cannot be rescued by trusted links or a high score',()=>{
  for(const modify of [
    c=>c.identityComparison.candidate.bio='Official record label',
    c=>c.identityComparison.candidate.bio='Artist fan page',
    c=>c.identityComparison.candidate.bio='Festival venue',
    c=>c.ownershipContext='unknown',
    c=>c.conflictingProfileIds=['2'],
    c=>c.contradictions=['Different documented owner'],
    c=>c.identityComparison.status='mismatch',
    c=>c.jevVerification.verdict='mismatch',
  ]){const f=fixture();const c=f.result.profiles[0];c.jevVerification.sameIdentityProbability=0.99;
    modify(c);assert.deepEqual(run(f).simulationUrls,[]);}
});
test('missing, malformed, stale, different-account or inconclusive verifier decisions fail closed',()=>{
  for(const modify of [
    j=>j.verdict='likely',j=>j.verdict='uncertain',j=>j.sameIdentityProbability=NaN,
    j=>j.sameIdentityProbability=1.1,j=>j.sameIdentityProbability=-0.1,
    j=>j.observedAt='2026-11-01T00:00:00Z',j=>delete j.model,
    j=>delete j.requestSha256,
    j=>j.accountUrl='https://www.instagram.com/other/',j=>j.profileId='2',
  ]){const f=fixture();modify(f.result.profiles[0].jevVerification);
    assert.deepEqual(run(f).simulationUrls,[]);}
});
test('conflicting duplicate occurrences, failed discovery and evaluator-label injection block acceptance',()=>{
  const f=fixture(),other=structuredClone(f.result.profiles[0]);
  other.jevVerification.verdict='mismatch';f.result.profiles.push(other);
  assert.deepEqual(run(f).simulationUrls,[]);
  const failed=fixture();failed.result.methodsUsed=[];assert.equal(run(failed).status,'blocked');
  const labeled=fixture();labeled.websiteEvidence[0].expectedArtistOwned=true;
  assert.equal(run(labeled).reason,'evaluator_labels_in_input');
});

test('malformed observations and conflict evidence hold rather than silently qualifying',()=>{
  const f=fixture();f.websiteEvidence=null;assert.equal(run(f).status,'blocked');
  const g=fixture();g.websiteEvidence=[null];assert.deepEqual(run(g).simulationUrls,[]);
  const h=fixture();reseal(h,'page',p=>p.links=[null,{},'untyped link']);
  assert.deepEqual(run(h).simulationUrls,[]);
  const j=fixture();j.result.profiles[0].contradictions={};assert.deepEqual(run(j).simulationUrls,[]);
});
