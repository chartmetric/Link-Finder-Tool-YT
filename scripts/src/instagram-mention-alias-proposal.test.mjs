import test from 'node:test';
import assert from 'node:assert/strict';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {explicitArtistAliasClues,proposedInstagramSearchCandidates} from './instagram-alias-search-proposal.mjs';
import {proposeMentionReview} from './instagram-mention-review-proposal.mjs';
const artist={profile_id:'1',cm_artist:'2',artist:'Cedar Signal',tier:2};
const url='https://www.instagram.com/other_person/';
const hit=()=>({link:url,title:'Other Person (@other_person)',
  snippet:"Cedar Signal's (a.k.a. @alex_synth ) record returns.",observedAt:'2026-11-11T10:00:00Z'});
const fixture=()=>({url,reviewSuggestion:true,recordedAnswer:{verdict:'likely',sameIdentityProbability:0.38},
  metadataActuallyUsed:{artist:artist.artist,knownProfileUrl:'https://app.chartmetric.com/artist/2',
    catalogAccountEvidence:{profileId:'1',cmArtist:'2',candidateUrl:url,accounts:[]},
    savedSearchEvidence:{url,artistNameAtCapture:artist.artist,snippet:'Cedar Signal was here with our friends'},
    candidates:[{url,reference:{platform:'catalog',url:'https://app.chartmetric.com/artist/2'},
      candidate:{url,displayName:'Other Person',bio:'Enjoying the weekend',externalUrls:[]},
      observedExactCatalogLinks:[]}]}});
test('extracts an explicit alias from a direct profile result without changing the original parser',()=>{
  const h=hit(),before=JSON.stringify(h);
  assert.deepEqual(instagramSearchCandidates([h],artist.artist).map(c=>c.url),[url]);
  const found=proposedInstagramSearchCandidates([h],artist.artist);
  assert.equal(found[0].url,'https://www.instagram.com/alex_synth/');
  assert.equal(found[0].discoveryEvidence[0].ownershipConfirmed,false);
  assert.equal(found[0].discoveryEvidence[0].sourceUrl,url);
  assert.equal(found[0].discoveryEvidence[0].kind,'explicit_artist_alias');
  assert.equal(found[0].verified,undefined);assert.equal(JSON.stringify(h),before);
});
test('accepts explicit forward and reverse alias syntax, punctuation, accents and case',()=>{
  for(const snippet of ["Cedar Signal aka @alex_synth","Cedar Signal (also known as @alex_synth)",
    '@alex_synth (a.k.a. Cedar Signal)',"CEDAR SIGNAL’s (a.k.a. @Alex_Synth)"]){
    assert.equal(explicitArtistAliasClues({...hit(),snippet},artist.artist)[0]?.url,
      'https://www.instagram.com/alex_synth/',snippet);
  }
  assert.equal(explicitArtistAliasClues({...hit(),snippet:'José aka @jose_stage'},'José').length,1);
});
test('does not guess handles, collect unrelated mentions, match another artist or join fields',()=>{
  for(const snippet of ['Cedar Signal also works with @alex_synth','Cedar Signal aka Alex Synth',
    'Other Artist aka @alex_synth','Cedar Signalizer aka @alex_synth','Email artist@alex_synth',
    'Cedar Signal aka @p','Cedar Signal aka @'+ 'a'.repeat(31)]){
    assert.equal(explicitArtistAliasClues({...hit(),snippet},artist.artist).length,0,snippet);
  }
  assert.equal(explicitArtistAliasClues({link:url,title:artist.artist,snippet:'aka @alex_synth'},artist.artist).length,0);
});
test('rejects unsafe sources and preserves distinct artists sharing an alias',()=>{
  for(const link of ['http://instagram.com/other/','https://instagram.com.evil.test/other/',
    'https://user:password@instagram.com/other/','https://example.com/other/']){
    assert.deepEqual(explicitArtistAliasClues({...hit(),link},artist.artist),[]);
  }
  const a=explicitArtistAliasClues(hit(),artist.artist)[0];
  const b=explicitArtistAliasClues({...hit(),snippet:'Other Band aka @alex_synth'},'Other Band')[0];
  assert.equal(a.url,b.url);assert.notEqual(a.artistName,b.artistName);
  assert.equal(a.ownershipConfirmed,false);assert.equal(b.ownershipConfirmed,false);
});
test('deduplicates candidates and repeated provenance without altering old candidates',()=>{
  const direct={link:'https://www.instagram.com/alex_synth/',title:'Alex Synth',snippet:'DJ'};
  const old=instagramSearchCandidates([hit(),direct],artist.artist),before=JSON.stringify(old);
  const proposed=proposedInstagramSearchCandidates([hit(),hit(),direct],artist.artist);
  assert.equal(proposed.filter(c=>c.url===direct.link).length,1);
  assert.equal(proposed.find(c=>c.url===direct.link).discoveryEvidence.filter(e=>e.kind==='explicit_artist_alias').length,1);
  assert.equal(JSON.stringify(old),before);
});
test('mention guard holds search-only name overlap, without a score cutoff or changing source answers',()=>{
  const f=fixture(),before=JSON.stringify(f),r=proposeMentionReview(artist,f);
  assert.equal(r.targetedGuardSuggestion,true);assert.equal(r.proposedReviewSuggestion,false);
  assert.equal(r.status,'needs_more_identity_evidence');assert.equal(r.verified,false);
  assert.equal(JSON.stringify(f),before);
  f.recordedAnswer.sameIdentityProbability=0.99;
  assert.equal(proposeMentionReview(artist,f).proposedReviewSuggestion,false);
});
test('names, sparse context and a search alias are not automatic mismatches or ownership proof',()=>{
  const f=fixture();
  f.metadataActuallyUsed.candidates[0].candidate.displayName=artist.artist;
  assert.equal(proposeMentionReview(artist,f).proposedReviewSuggestion,true);
  const alias=fixture();
  alias.metadataActuallyUsed.savedSearchEvidence.snippet='Cedar Signal aka @other_person';
  assert.equal(proposeMentionReview(artist,alias).proposedReviewSuggestion,false);
  alias.metadataActuallyUsed.catalogAccountEvidence.accounts=[{platform:'spotify',url:'https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA'}];
  alias.recordedAnswer.sameIdentityProbability=0.1;
  assert.equal(proposeMentionReview(artist,alias).proposedReviewSuggestion,true);
});
test('captured profile context is kept distinct from search snippets and explicit support remains usable',()=>{
  const f=fixture();f.metadataActuallyUsed.candidates[0].candidate.bio='Producer performing as Cedar Signal';
  assert.equal(proposeMentionReview(artist,f).proposedReviewSuggestion,true);
  f.metadataActuallyUsed.candidates[0].candidate.bio='Unrelated bio';
  f.metadataActuallyUsed.artistContext={catalogFacts:[{kind:'genre',value:'pop'}]};
  assert.equal(proposeMentionReview(artist,f).proposedReviewSuggestion,false);
});
test('missing inputs, conflicting pairings, earlier holds and missing search bindings stay separate',()=>{
  const missing=fixture();delete missing.metadataActuallyUsed;
  assert.equal(proposeMentionReview(artist,missing).proposedReviewSuggestion,null);
  const held=fixture();held.reviewSuggestion=false;
  assert.equal(proposeMentionReview(artist,held).proposedReviewSuggestion,false);
  const other=fixture();other.metadataActuallyUsed.catalogAccountEvidence.cmArtist='3';
  assert.equal(proposeMentionReview(artist,other).proposedReviewSuggestion,null);
  const search=fixture();search.metadataActuallyUsed.savedSearchEvidence.url='https://www.instagram.com/elsewhere/';
  assert.equal(proposeMentionReview(artist,search).proposedReviewSuggestion,null);
});
