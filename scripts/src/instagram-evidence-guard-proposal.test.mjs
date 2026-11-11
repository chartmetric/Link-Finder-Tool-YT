import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeEvidenceGuard as guard} from './instagram-evidence-guard-proposal.mjs';
const artist={profile_id:'1',cm_artist:'2',artist:'who.i.am',tier:2};
const url='https://www.instagram.com/another_artist/';
const fixture=()=>({url,reviewSuggestion:true,
  recordedAnswer:{verdict:'likely',sameIdentityProbability:0.49},
  decision:{reviewSuggestion:true,evidence:[]},
  metadataActuallyUsed:{artist:artist.artist,knownProfileUrl:'https://app.chartmetric.com/artist/2',
    catalogAccountEvidence:{profileId:'1',cmArtist:'2',candidateUrl:url,accounts:[]},
    candidates:[{url,reference:{platform:'catalog',url:'https://app.chartmetric.com/artist/2'},
      candidate:{url,displayName:'Another Artist',bio:'My new single “Who I Am to You” is out now',
        externalUrls:[]},observedExactCatalogLinks:[]}] }});
test('targeted guard holds unsupported title confusion but never calls it a mismatch',()=>{
  const f=fixture(),before=JSON.stringify(f),r=guard(artist,f);
  assert.equal(r.proposedReviewSuggestion,false);assert.equal(r.status,'needs_more_identity_evidence');
  assert.equal(r.verified,false);assert.equal(r.liveLinkAccepted,false);
  assert.equal(r.executionMode,'offline_only');assert.equal(JSON.stringify(f),before);
});
test('no probability cutoff: high scores cannot replace a reference and low scores do not negate one',()=>{
  const f=fixture();f.recordedAnswer.sameIdentityProbability=0.99;
  assert.equal(guard(artist,f).proposedReviewSuggestion,false);
  f.recordedAnswer.sameIdentityProbability=0.05;
  f.metadataActuallyUsed.catalogAccountEvidence.accounts=[{platform:'spotify',url:'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA'}];
  assert.equal(guard(artist,f).proposedReviewSuggestion,true);
});
test('an actually supplied external artist reference is retained',()=>{
  const f=fixture(),music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
  f.metadataActuallyUsed.knownProfileUrl=music;
  f.metadataActuallyUsed.candidates[0].reference={platform:'spotify',url:music};
  assert.equal(guard(artist,f).proposedReviewSuggestion,true);
});
test('exact catalog declaration requires both the observed edge and supplied account link',()=>{
  const f=fixture(),c=f.metadataActuallyUsed.candidates[0],catalog='https://app.chartmetric.com/artist/2';
  c.observedExactCatalogLinks=[{catalogUrl:catalog}];
  assert.equal(guard(artist,f).proposedReviewSuggestion,false);
  c.candidate.externalUrls=[catalog];
  assert.equal(guard(artist,f).proposedReviewSuggestion,true);
});
test('demographic facts, release signals, a badge, and follower counts do not replace a reference',()=>{
  const f=fixture();
  f.metadataActuallyUsed.artistContext={catalogFacts:[{kind:'country',value:'US'},{kind:'genre',value:'pop'}],
    candidateSignals:[{songTitlesInCandidateProfile:{result:'support',titles:['Who I Am']}}]};
  Object.assign(f.metadataActuallyUsed.candidates[0].candidate,{verified:true,followers:1000000});
  assert.equal(guard(artist,f).proposedReviewSuggestion,false);
});
test('targeted and strict alternatives report their false-negative tradeoff explicitly',()=>{
  const f=fixture();f.metadataActuallyUsed.candidates[0].candidate.displayName='who.i.am';
  assert.equal(guard(artist,f).proposedReviewSuggestion,true);
  assert.equal(guard(artist,f,{mode:'require_identity_reference'}).proposedReviewSuggestion,false);
});
test('aliases and short names are not blocked merely for a different display name',()=>{
  const f=fixture(),a={...artist,artist:'Bzy'};
  f.metadataActuallyUsed.artist='Bzy';
  Object.assign(f.metadataActuallyUsed.candidates[0].candidate,{displayName:'Braxton/BZY',bio:'New song BZY is out now'});
  assert.equal(guard(a,f).proposedReviewSuggestion,true);
});
test('missing original states are unknown rather than rejected ownership',()=>{
  const f=fixture();delete f.metadataActuallyUsed;
  const r=guard(artist,f);
  assert.equal(r.proposedReviewSuggestion,null);assert.equal(r.status,'not_comparable');
});
test('changed artist, catalog ID, account URL, and missing bindings cannot be compared',()=>{
  for(const mutate of [
    f=>{f.metadataActuallyUsed.catalogAccountEvidence.cmArtist='3';},
    f=>{f.metadataActuallyUsed.catalogAccountEvidence.profileId='3';},
    f=>{f.metadataActuallyUsed.catalogAccountEvidence.candidateUrl='https://www.instagram.com/other/';},
    f=>{f.metadataActuallyUsed.artist='other';},
    f=>{delete f.metadataActuallyUsed.catalogAccountEvidence;},
  ]){const f=fixture();mutate(f);assert.equal(guard(artist,f).proposedReviewSuggestion,null);}
});
test('prior conflicts and uncertain/mismatch decisions cannot be promoted',()=>{
  for(const status of ['shared_handle','explicit_fan','different_spotify_id','model_uncertain','model_mismatch']){
    const f=fixture();f.reviewSuggestion=false;f.decision={reviewSuggestion:false,status};
    f.metadataActuallyUsed.catalogAccountEvidence.accounts=[{platform:'spotify',url:'https://example.com/artist'}];
    assert.equal(guard(artist,f).proposedReviewSuggestion,false);
  }
});
test('inactive and malformed account references cannot bypass the guard',()=>{
  for(const account of [
    {platform:'spotify',url:'https://example.com',is_active:false},
    {platform:'spotify',url:'javascript:alert(1)'},
    {platform:'instagram',url},
    {platform:'spotify',url:'https://user:password@example.com'},
  ]){const f=fixture();f.metadataActuallyUsed.catalogAccountEvidence.accounts=[account];
    assert.equal(guard(artist,f).proposedReviewSuggestion,false);}
});
test('unsupported modes fail explicitly',()=>assert.throws(()=>guard(artist,fixture(),{mode:'live_accept'}),/Unknown/));
