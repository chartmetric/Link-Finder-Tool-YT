import assert from 'node:assert/strict';

// The unprefixed fields are always the newest observation. Old observations
// remain explicit, so filtering the headline columns cannot use stale answers.
export function latestRecheckExport(row){
  assert.ok(typeof row.recheckStatus==='string','Missing latest recheck status.');
  const checked=row.recheckStatus!=='incomplete_not_rechecked';
  if(checked){
    assert.equal(typeof row.recheckLikelyMatch,'boolean');
    assert.equal(row.recheckLikelyMatch,row.recheckStatus==='positive_review_suggestion');
    assert.ok(row.recheckMetadataActuallyUsed&&row.recheckModel);
  }
  return {
    ...row,
    status:row.recheckStatus,
    likelyReviewSuggestion:checked?row.recheckLikelyMatch:false,
    score:checked?row.recheckScore:null,
    verdict:checked?row.recheckVerdict:null,
    reason:row.recheckReason,
    metadataActuallyUsed:checked?row.recheckMetadataActuallyUsed:null,
    model:checked?row.recheckModel:null,
    previousStatus:row.previousStatus??row.status,
    previousLikelyReviewSuggestion:row.likelyReviewSuggestion,
    previousScore:row.previousScore??row.score,
    previousVerdict:row.previousVerdict??row.verdict,
    previousReason:row.reason,
    previousMetadataActuallyUsed:row.metadataActuallyUsed,
    previousModel:row.model,
    primaryColumnsRepresent:'latest_recheck',
  };
}
