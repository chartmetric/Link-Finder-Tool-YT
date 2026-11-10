import test from 'node:test';
import assert from 'node:assert/strict';
import {latestRecheckExport} from './instagram-recheck-export.mjs';

const fixture=()=>({
  artist:'Example',status:'model_not_positive',likelyReviewSuggestion:false,
  score:0.26,verdict:'uncertain',reason:'recorded_model_uncertain',
  model:'same-model',metadataActuallyUsed:{version:'old'},
  previousStatus:'model_not_positive',previousScore:0.26,previousVerdict:'uncertain',
  recheckStatus:'positive_review_suggestion',recheckScore:0.37,recheckVerdict:'likely',
  recheckLikelyMatch:true,recheckReason:'positive_model_verdict_without_observed_conflict',
  recheckMetadataActuallyUsed:{version:'new'},recheckModel:'same-model',
  verified:false,liveLinkChanged:false,
});
test('main columns use the latest check, while explicitly previous columns preserve the old input and answer',()=>{
  const old=fixture(),before=structuredClone(old),r=latestRecheckExport(old);
  assert.equal(r.likelyReviewSuggestion,true);assert.equal(r.score,0.37);
  assert.equal(r.verdict,'likely');assert.equal(r.status,'positive_review_suggestion');
  assert.deepEqual(r.metadataActuallyUsed,{version:'new'});
  assert.equal(r.previousLikelyReviewSuggestion,false);assert.equal(r.previousScore,0.26);
  assert.deepEqual(r.previousMetadataActuallyUsed,{version:'old'});
  assert.equal(r.verified,false);assert.equal(r.liveLinkChanged,false);assert.deepEqual(old,before);
});
test('latest non-positive and conflict results cannot appear in likely exports',()=>{
  for(const status of ['model_not_positive','observed_identity_conflict','unresolved_ownership_conflict']){
    const r=latestRecheckExport({...fixture(),recheckStatus:status,recheckLikelyMatch:false});
    assert.equal(r.likelyReviewSuggestion,false);assert.equal(r.status,status);
  }
  assert.throws(()=>latestRecheckExport({...fixture(),recheckLikelyMatch:false}));
});
test('an incomplete recheck never presents the older decision as a fresh result',()=>{
  const r=latestRecheckExport({...fixture(),recheckStatus:'incomplete_not_rechecked'});
  assert.equal(r.score,null);assert.equal(r.verdict,null);assert.equal(r.metadataActuallyUsed,null);
  assert.equal(r.likelyReviewSuggestion,false);assert.equal(r.previousScore,0.26);
});
