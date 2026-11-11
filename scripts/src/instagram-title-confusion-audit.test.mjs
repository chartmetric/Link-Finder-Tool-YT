import test from 'node:test';
import assert from 'node:assert/strict';
import {auditLikelyCandidate,normalizedName} from './instagram-title-confusion-audit.mjs';
const row={artist:'who.i.am',tier:2,profile_id:'fixture',cm_artist:'fixture'};
function fixture(){
  const url='https://www.instagram.com/another_musician/';
  return {url,reviewSuggestion:true,recordedAnswer:{verdict:'likely',sameIdentityProbability:0.49},
    decision:{evidence:[],reason:'positive_model_verdict_without_observed_conflict'},
    metadataActuallyUsed:{catalogAccountEvidence:{accounts:[]},
      candidates:[{url,reference:{platform:'catalog'},candidate:{displayName:'Another Musician',
        bio:'My new single “Who I Am to You” is out now.'},observedExactCatalogLinks:[]}]}};
}
test('flags name-only references with a conflicting account name and release-title overlap',()=>{
  const r=auditLikelyCandidate(row,fixture());
  assert.equal(r.review_priority,'high');assert.equal(r.confirmed_false_positive,false);
  assert.equal(r.model_identity_score,0.49);
});
test('a matching name is not rejected just for announcing a new single',()=>{
  const f=fixture();f.metadataActuallyUsed.candidates[0].candidate.displayName='Who I Am';
  assert.equal(auditLikelyCandidate(row,f).review_priority,'');
});
test('known catalog accounts or explicit link evidence prevent the thin-reference flag',()=>{
  for(const mode of ['accounts','links','evidence','facts']){
    const f=fixture();
    if(mode==='accounts')f.metadataActuallyUsed.catalogAccountEvidence.accounts=[{platform:'spotify'}];
    if(mode==='links')f.metadataActuallyUsed.candidates[0].observedExactCatalogLinks=['exact artist URL'];
    if(mode==='evidence')f.decision.evidence=['recorded corroboration'];
    if(mode==='facts')f.metadataActuallyUsed.artistContext={catalogFacts:['catalog release']};
    assert.equal(auditLikelyCandidate(row,f).review_priority,'');
  }
});
test('missing original inputs are unknown, not proof of missing supplied evidence',()=>{
  const f=fixture();delete f.metadataActuallyUsed;
  f.metadata={candidate:{displayName:'Another Musician',bio:'My single Who I Am to You'}};
  const r=auditLikelyCandidate(row,f);
  assert.equal(r.exact_model_state_available,false);
  assert.equal(r.reference_name_only,false);assert.equal(r.review_priority,'');
});
test('only actual supplied metadata is used when the original model state is available',()=>{
  const f=fixture();
  f.metadata={candidate:{displayName:'who.i.am',bio:'Different available metadata'}};
  assert.equal(auditLikelyCandidate(row,f).review_priority,'high');
});
test('phrase matching respects word boundaries and non-Latin names',()=>{
  assert.equal(normalizedName('who.i.am'),'who i am');
  const f=fixture();f.metadataActuallyUsed.candidates[0].candidate.bio='New single WHOIAMTOYOU';
  f.recordedAnswer.sameIdentityProbability=0.8;
  assert.equal(auditLikelyCandidate(row,f).review_priority,'');
  assert.equal(normalizedName('張 昊'),'張 昊');
});
test('short stage names explicitly present in names and handles are not name conflicts',()=>{
  for(const [artist,displayName,url] of [
    ['Ani','Wé Ani','https://www.instagram.com/we_ani/'],
    ['Bzy','Braxton/BZY','https://www.instagram.com/dj_bzy/'],
  ]){
    const f=fixture();f.url=url;
    f.metadataActuallyUsed.candidates[0].url=url;
    f.metadataActuallyUsed.candidates[0].candidate={displayName,bio:'New single '+artist+' out now'};
    assert.equal(auditLikelyCandidate({...row,artist},f).review_priority,'');
  }
});
test('a name at the start of a bio is not called a song title just because a release follows',()=>{
  const f=fixture();
  f.metadataActuallyUsed.candidates[0].candidate.bio='Who I Am\nNew album out now';
  const r=auditLikelyCandidate(row,f);
  assert.notEqual(r.review_priority,'high');
  assert.equal(r.title_style_overlap,false);
});
test('songwriter identity text is not a song-title introduction',()=>{
  const f=fixture();
  f.metadataActuallyUsed.candidates[0].candidate.bio='Song writer, Dreamer, Lover\nWho I Am Land EP Album - Out Now';
  assert.notEqual(auditLikelyCandidate(row,f).review_priority,'high');
});
test('unbalanced nested quotes do not turn self-identification into a song title',()=>{
  const f=fixture();
  f.metadataActuallyUsed.candidates[0].candidate.bio='Recording Artist “Who I Am Daddy\nNew song “Another Title”';
  assert.notEqual(auditLikelyCandidate(row,f).review_priority,'high');
});
