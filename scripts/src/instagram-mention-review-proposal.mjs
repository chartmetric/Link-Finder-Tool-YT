// OFFLINE ONLY. Extends the targeted guard for comparison, not live execution.
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {proposeEvidenceGuard,normalizedGuardName,guardNameAgreement} from './instagram-likely-review-policy.mjs';
const phraseIn=(phrase,text)=>phrase.length>=3
  &&(' '+normalizedGuardName(text)+' ').includes(' '+phrase+' ');

export function proposeMentionReview(artist,finding){
  const targeted=proposeEvidenceGuard(artist,finding);
  const result=(status,reason,suggestion)=>({...targeted,
    policy:'offline-third-party-mention-guard',proposedReviewSuggestion:suggestion,status,reason,
    targetedGuardSuggestion:targeted.proposedReviewSuggestion,
    executionMode:'offline_only',originalDecisionChanged:false});
  // Existing holds/unknowns remain holds/unknowns. Never rescue a mismatch.
  if(targeted.proposedReviewSuggestion!==true)
    return result(targeted.status,targeted.reason,targeted.proposedReviewSuggestion);
  const strict=proposeEvidenceGuard(artist,finding,{mode:'require_identity_reference'});
  if(strict.status!=='needs_more_identity_evidence')
    return result(targeted.status,targeted.reason,true);
  const state=finding.metadataActuallyUsed,url=instagramProfileUrl(finding.url);
  const supplied=state.candidates.find(c=>instagramProfileUrl(c.url)===url);
  const search=state.savedSearchEvidence,phrase=normalizedGuardName(artist.artist);
  if(!search||instagramProfileUrl(search.url)!==url
    ||(search.artistNameAtCapture!=null&&normalizedGuardName(search.artistNameAtCapture)!==phrase))
    return result('not_comparable','Saved search binding is missing or belongs to a different artist/account',null);
  const candidate=supplied.candidate??{};
  const nameAgrees=guardNameAgreement(artist.artist,candidate.displayName,url);
  const artistInCapturedBio=phraseIn(phrase,candidate.bio??'');
  if(nameAgrees===false&&!artistInCapturedBio&&phraseIn(phrase,search.snippet??''))
    return result('needs_more_identity_evidence',
      'Artist appears only in saved search text, not the supplied account identity; no identity-bearing artist reference',false);
  return result(targeted.status,
    'No mention-only trigger; retaining an old suggestion is not independent ownership validation',true);
}
