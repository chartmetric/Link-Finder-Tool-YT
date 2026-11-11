// Saved-evidence triage only. Never an ownership verdict or acceptance policy.
import {normalizedGuardName as normalizedName,guardNameAgreement as nameAgrees,
  guardReleaseCueNear as releaseCueNear,guardTitleStyleOverlap as titleStyleOverlap} from './instagram-likely-review-policy.mjs';
export {normalizedName};
const phraseIn=(phrase,text)=>phrase.length>=3&&(' '+normalizedName(text)+' ').includes(' '+phrase+' ');
export function auditLikelyCandidate(row,finding){
  const state=finding.metadataActuallyUsed;
  const stateAvailable=Boolean(state&&typeof state==='object'&&!Array.isArray(state));
  const captured=finding.metadata?.candidate??{};
  const supplied=stateAvailable?state.candidates?.find(c=>c.url===finding.url):null;
  const candidate=stateAvailable?supplied?.candidate:captured;
  // Do not substitute merely available metadata for what the checker received.
  const bio=candidate?.bio??'',displayName=candidate?.displayName??'';
  const snippet=stateAvailable?state.savedSearchEvidence?.snippet??'':finding.snippet??'';
  const phrase=normalizedName(row.artist);
  const agrees=nameAgrees(row.artist,displayName,finding.url);
  const accounts=stateAvailable&&Array.isArray(state.catalogAccountEvidence?.accounts)
    ?state.catalogAccountEvidence.accounts:null;
  const facts=stateAvailable&&Array.isArray(state.artistContext?.catalogFacts)
    ?state.artistContext.catalogFacts:[];
  const referenceOnly=stateAvailable&&supplied?.reference?.platform==='catalog'
    &&accounts!==null&&accounts.length===0&&facts.length===0;
  const exactLinks=Array.isArray(supplied?.observedExactCatalogLinks)?supplied.observedExactCatalogLinks:[];
  const decision=finding.decision??finding.review??{};
  const positiveEvidence=Array.isArray(decision.evidence)?decision.evidence:[];
  const noCorroboration=exactLinks.length===0&&positiveEvidence.length===0;
  const inBio=phraseIn(phrase,bio),inSearch=phraseIn(phrase,snippet);
  const releaseOverlap=inBio&&releaseCueNear(phrase,bio);
  const titleOverlap=inBio&&titleStyleOverlap(phrase,bio);
  const searchReleaseOverlap=inSearch&&releaseCueNear(phrase,snippet);
  const score=finding.recordedAnswer?.sameIdentityProbability;
  const weakScore=Number.isFinite(score)&&score<0.5;
  let priority='',reason='';
  if(referenceOnly&&agrees===false&&noCorroboration&&titleOverlap){
    priority='high';reason='Different account name; artist phrase appears as a quoted title or follows a release cue in the supplied bio; name-only catalog reference.';
  }else if(referenceOnly&&agrees===false&&noCorroboration&&(inBio||searchReleaseOverlap)){
    priority='medium';reason='Different account name and phrase overlap with little artist context; possible song/title or caption confusion.';
  }else if(referenceOnly&&agrees===false&&noCorroboration&&weakScore){
    priority='medium';reason='Different account name and name-only reference; a likely label passed despite an identity score below 0.5.';
  }
  return {
    artist_name:row.artist,tier:row.tier,profile_id:row.profile_id,cm_artist:row.cm_artist,
    instagram_url:finding.url,review_priority:priority,review_reason:reason,
    confirmed_false_positive:false,model_verdict:finding.recordedAnswer?.verdict??'',
    model_identity_score:Number.isFinite(score)?score:null,
    captured_display_name:displayName,captured_bio:bio,saved_search_snippet:snippet,
    name_agreement:agrees,exact_model_state_available:stateAvailable,
    reference_name_only:referenceOnly,known_account_count:accounts?.length??null,
    supplied_catalog_fact_count:stateAvailable?facts.length:null,
    artist_phrase_in_bio:inBio,artist_phrase_in_search:inSearch,
    release_cue_near_bio_phrase:releaseOverlap,
    title_style_overlap:titleOverlap,
    observed_exact_catalog_links:exactLinks.length,
    recorded_positive_evidence_items:positiveEvidence.length,
    acceptance_reason:decision.reason??finding.reason??'',
    request_sha256:finding.requestSha256??'',
    limitation:stateAvailable?'Heuristic review priority, not an ownership verdict. Aliases and non-English release cues may require manual review.'
      :'Original model input unavailable; no claim about evidence supplied to that check.',
  };
}
export const AUDIT_CSV_FIELDS=[
  'artist_name','tier','profile_id','cm_artist','instagram_url','review_priority',
  'review_reason','confirmed_false_positive','model_verdict','model_identity_score',
  'captured_display_name','captured_bio','saved_search_snippet','name_agreement',
  'exact_model_state_available','reference_name_only','known_account_count',
  'supplied_catalog_fact_count','artist_phrase_in_bio','artist_phrase_in_search',
  'release_cue_near_bio_phrase','title_style_overlap','observed_exact_catalog_links',
  'recorded_positive_evidence_items','acceptance_reason','request_sha256','limitation',
];
