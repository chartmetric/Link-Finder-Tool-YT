import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {enrichedRequest} from './instagram-next-saved-batch.mjs';
import {catalogBoundReviewSuggestion,savedCandidateInspection} from './instagram-likely-review-policy.mjs';
const url='https://www.instagram.com/another_artist/';
function fixture(){
  const target={artist:'who.i.am',profileId:'42',
    selected:{url,title:'Search result',snippet:'Search text is not ownership evidence'},
    player:{profile_id:'42',cm_artist:'123',artist:'who.i.am',accounts:[],account_ids:[],
      source_identity_matches:true,catalog_profile:{profile_id:'42',cm_artist:'123'}},
    context:{ownershipConfirmed:false,items:[]}};
  const built=enrichedRequest(target,{url,displayName:'Another Artist',
    bio:'My new single “Who I Am to You” is out now',externalUrls:[],directExternalUrls:[]});
  built.profile.jevVerification={verdict:'likely',sameIdentityProbability:0.49};
  return {target,built,options:{guardPolicy:'targeted_title_guard',modelState:built.body.state}};
}
test('real new-run request builder feeds the targeted hold while historical calls stay unchanged',()=>{
  const {target,built,options}=fixture(),before=JSON.stringify(built);
  assert.equal(catalogBoundReviewSuggestion(built.profile,target.player).reviewSuggestion,true);
  const result=catalogBoundReviewSuggestion(built.profile,target.player,options);
  assert.equal(result.reviewSuggestion,false);assert.equal(result.status,'needs_more_identity_evidence');
  assert.equal(result.reason,'unsupported_release_title_overlap');
  assert.equal(result.guard.application,'future_run');assert.equal(result.verified,false);
  assert.deepEqual(savedCandidateInspection(result),{status:'inconclusive',tryAlternative:true});
  assert.equal(JSON.stringify(built),before);
  assert.equal(built.profile.jevVerification.verdict,'likely');
});
test('new-run calls cannot silently bypass the guard when original outgoing state is absent',()=>{
  const {target,built}=fixture();
  const result=catalogBoundReviewSuggestion(built.profile,target.player,{guardPolicy:'targeted_title_guard'});
  assert.equal(result.reviewSuggestion,false);assert.equal(result.reason,'title_guard_input_unavailable');
});
test('known shared handles and negative model answers remain prior holds',()=>{
  const {target,built,options}=fixture();
  assert.equal(catalogBoundReviewSuggestion(built.profile,target.player,{...options,sharedHandle:true}).reason,
    'shared_handle_across_catalog_artists');
  for(const verdict of ['mismatch','uncertain']){
    built.profile.jevVerification.verdict=verdict;
    const legacy=catalogBoundReviewSuggestion(built.profile,target.player);
    assert.deepEqual(catalogBoundReviewSuggestion(built.profile,target.player,options),legacy);
  }
});
test('scores are not raised and known alternate names are not blocked by the targeted rule',()=>{
  const {target,built,options}=fixture();
  built.profile.jevVerification.sameIdentityProbability=0.05;
  built.profile.identityComparison.candidate.displayName='who.i.am';
  options.modelState.candidates[0].candidate.displayName='who.i.am';
  assert.equal(catalogBoundReviewSuggestion(built.profile,target.player,options).reviewSuggestion,true);
});
test('all new-run entry points explicitly supply the outgoing model state and targeted policy',async()=>{
  for(const name of ['campaign-parallel-adapters','run-instagram-tier-priority','instagram-saved-alternatives-runner']){
    const text=await fs.readFile(new URL('./'+name+'.mjs',import.meta.url),'utf8');
    assert.match(text,/guardPolicy:'targeted_title_guard',modelState:built\.body\.state/,name);
  }
});
