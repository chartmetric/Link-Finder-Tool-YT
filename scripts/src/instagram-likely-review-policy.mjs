// Review-suggestion policies, never ownership verification or catalog acceptance.
import {catalogReferences,instagramProfileUrl,referenceUrl} from './musician-instagram-matching.mjs';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
export const LIKELY_REVIEW_POLICY='likely-review-suggestions-v1';
const norm=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const bound=(p,url,normalize)=>[p?.url,...(p?.urlAliases??[])].some(u=>normalize(u)===url);
const https=value=>{
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:null;}
  catch{return null;}
};
function explicitOtherEntity(candidate,artist){
  const display=norm(candidate.displayName),bio=norm(candidate.bio);
  const fan=/^(?:(?:the|an?|official|unofficial|this is|we are)\s+)*(?:fan (?:account|page|club)|fanpage|fanclub|tribute (?:account|page|band)|not (?:the )?(?:real|official) (?:artist|account))\b/u;
  if(fan.test(bio)||(display!==norm(artist)&&/\b(?:fan account|fan page|fan club|fanpage|fanclub|tribute account)\b/u.test(display)))
    return 'explicit_fan_or_tribute_account';
  // Not a keyword blacklist: "label owner", bookings and affiliations alone
  // are not self-identification as an organization.
  if(/^(?:(?:we are|this is|the|an?|official|independent|music|electronic|dance)\s+)*(?:record label|booking agency|artist management company|music venue|festival organizer)\b/u.test(bio))
    return 'explicit_organization_account';
  if(/^(?:非公式アカウント|팬 계정|팬계정|粉丝账号|粉絲帳號)/u.test(String(candidate.bio??'').trim()))
    return 'explicit_fan_or_tribute_account';
  return null;
}
function observedSpotifyArtistLinks(candidate){
  const direct=candidate.directExternalUrls??(candidate.externalLinkEvidence?[]:candidate.externalUrls??[]);
  const urls=[...direct,...(String(candidate.bio??'').match(/https:\/\/[^\s<>"']+/g)??[]).map(u=>u.replace(/[),;]+$/,''))];
  const reachable=new Set(direct.map(https).filter(Boolean));
  for(let step=0;step<8;step++){
    let added=false;
    for(const page of (candidate.externalLinkEvidence?.pages??[]).slice(0,16)){
      if(!reachable.has(https(page.sourceUrl))||page.status!==200||!/^[a-f0-9]{64}$/.test(page.bodySha256??''))continue;
      for(const edge of page.linkEvidence??[]){
        if(edge.kind!=='declared_profile_link'||https(edge.sourceUrl)!==https(page.sourceUrl))continue;
        urls.push(edge.targetUrl);const next=https(edge.targetUrl);
        if(next&&!reachable.has(next)){reachable.add(next);added=true;}
      }
    }
    if(!added)break;
  }
  return [...new Set(urls.map(u=>referenceUrl(u,'spotify')).filter(Boolean))];
}
export function likelyReviewSuggestion(profile,player,{sharedHandle=false,contradictoryPair=false}={}){
  return evaluateReview(profile,player,{sharedHandle,contradictoryPair},false);
}
// Some saved-discovery artists have a bound catalog identity but no frozen
// Spotify/YouTube/TikTok account. This is a review-only, catalog-context variant.
export function catalogBoundReviewSuggestion(profile,player,options={}){
  const previous=evaluateReview(profile,player,options,true);
  // Explicit opt-in keeps historical audit calls and sealed older policies
  // unchanged. New-run entry points provide the actual outgoing model state.
  if(options.guardPolicy===undefined)return previous;
  if(options.guardPolicy!=='targeted_title_guard')throw Error('Unknown future Instagram review guard');
  if(!previous.reviewSuggestion)return previous;
  const proposal=proposeEvidenceGuard({
    profile_id:String(player.profile_id),cm_artist:String(player.cm_artist),artist:player.artist,
  },{url:profile.url,reviewSuggestion:previous.reviewSuggestion,
    recordedAnswer:profile.jevVerification,metadataActuallyUsed:options.modelState});
  return {...previous,policy:'catalog-bound-targeted-title-guard',
    basePolicy:previous.policy,
    status:proposal.proposedReviewSuggestion===true?previous.status:
      proposal.proposedReviewSuggestion===null?'incomplete_saved_evidence':'needs_more_identity_evidence',
    reason:proposal.proposedReviewSuggestion===true?previous.reason:
      proposal.proposedReviewSuggestion===null?'title_guard_input_unavailable':'unsupported_release_title_overlap',
    reviewSuggestion:proposal.proposedReviewSuggestion===true,
    guard:{mode:'targeted_title_guard',application:'future_run',status:proposal.status,
      reason:proposal.reason,referenceKinds:proposal.referenceKinds}};
}
// Batch inspection state is separate from review/ownership status. A recorded
// mismatch is unsupported, not an unavailable account or an uncertain verdict.
export function savedCandidateInspection(decision){
  if(decision.reviewSuggestion)return {status:'positive_review_suggestion',tryAlternative:false};
  if(decision.status==='observed_identity_conflict'
    ||(decision.status==='model_not_positive'&&decision.reason==='recorded_model_mismatch'))
    return {status:'unsupported',tryAlternative:false};
  return {status:'inconclusive',tryAlternative:true};
}
function evaluateReview(profile,player,{sharedHandle=false,contradictoryPair=false}={},allowCatalogReference){
  assertNoGradingInputs({profile,player});
  const url=instagramProfileUrl(profile?.url);
  const result=(status,reason,evidence=[])=>({policy:allowCatalogReference?'catalog-bound-likely-review-v1':LIKELY_REVIEW_POLICY,url,status,reason,evidence,
    reviewSuggestion:status==='positive_review_suggestion',verified:false,liveLinkAccepted:false});
  if(!url)return result('incomplete_saved_evidence','invalid_instagram_url');
  const decision=profile.jevVerification;
  if(!Number.isFinite(decision?.sameIdentityProbability)||decision.sameIdentityProbability<0||decision.sameIdentityProbability>1
    ||!['likely','verified','uncertain','mismatch'].includes(decision?.verdict))
    return result('incomplete_saved_evidence','missing_or_invalid_recorded_answer');
  const references=catalogReferences({...player,accounts:(player.accounts??[]).filter(a=>a.is_active!==false&&a.is_active!==0)});
  const c=profile.identityComparison;
  const catalogUrl=`https://app.chartmetric.com/artist/${player.cm_artist}`;
  const catalogBound=allowCatalogReference&&/^[1-9]\d*$/.test(String(player.cm_artist))
    &&player.source_identity_matches===true
    &&String(player.catalog_profile?.profile_id)===String(player.profile_id)
    &&String(player.catalog_profile?.cm_artist)===String(player.cm_artist)
    &&c?.reference?.url===catalogUrl;
  if((!catalogBound&&!references.some(r=>bound(c?.reference,r.url,u=>referenceUrl(u,r.platform))))
    ||!bound(c?.candidate,url,instagramProfileUrl))
    return result('incomplete_saved_evidence','unbound_reference_or_account');
  if(sharedHandle)return result('unresolved_ownership_conflict','shared_handle_across_catalog_artists');
  if(contradictoryPair)return result('unresolved_ownership_conflict','conflicting_saved_assessments_for_same_pair');
  for(const key of ['contradictions','conflictingProfileIds']){
    if(profile[key]!==undefined&&(!Array.isArray(profile[key])||profile[key].length))
      return result('unresolved_ownership_conflict','explicit_or_malformed_conflict_record');
  }
  const other=explicitOtherEntity(c.candidate,player.artist);
  if(other)return result('observed_identity_conflict',other);
  const known=new Set(references.filter(r=>r.platform==='spotify').map(r=>r.url));
  const competing=known.size?observedSpotifyArtistLinks(c.candidate).filter(u=>!known.has(u)):[];
  if(competing.length)return result('observed_identity_conflict','different_observed_spotify_artist_id',competing);
  // Previous workflow labels, name similarity and absence of reciprocal links
  // are not negative identity observations. No numeric acceptance cutoff here.
  if(['likely','verified'].includes(decision.verdict))
    return result('positive_review_suggestion','positive_model_verdict_without_observed_conflict');
  return result('model_not_positive',decision.verdict==='mismatch'?'recorded_model_mismatch':'recorded_model_uncertain');
}

// Pure shared evaluator: offline comparisons and opted-in future runs use
// identical logic. No provider requests, database operations, or score cutoff.
export const EVIDENCE_GUARD_PROPOSAL='offline-reference-evidence-guard';
export function normalizedGuardName(value){
  return String(value??'').normalize('NFKD').replace(/\p{M}/gu,'')
    .toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
const guardPhraseIn=(phrase,text)=>phrase.length>=3
  &&(' '+normalizedGuardName(text)+' ').includes(' '+phrase+' ');
export function guardNameAgreement(artist,displayName,url){
  const compact=value=>normalizedGuardName(value).replaceAll(' ','');
  const a=compact(artist),d=compact(displayName);
  let handle='',rawHandle='';
  try{rawHandle=new URL(url).pathname.split('/').filter(Boolean)[0]??'';handle=compact(rawHandle);}catch{}
  if(!a)return null;
  const words=normalizedGuardName(artist);
  if((' '+normalizedGuardName(displayName)+' ').includes(' '+words+' ')
    ||(' '+normalizedGuardName(rawHandle)+' ').includes(' '+words+' '))return true;
  if(a.length<4)return a===d||a===handle;
  return d.includes(a)||(d.length>=4&&a.includes(d))||handle.includes(a);
}
export function guardReleaseCueNear(phrase,text){
  const s=normalizedGuardName(text),i=s.indexOf(phrase);
  if(i<0)return false;
  return /\b(single|song|track|album|release|released|releasing|debut|ep|out now|new music|music video|presave|pre save)\b/
    .test(s.slice(Math.max(0,i-100),i+phrase.length+100));
}
export function guardTitleStyleOverlap(phrase,text){
  if(!guardPhraseIn(phrase,text)||!guardReleaseCueNear(phrase,text))return false;
  const normalized=normalizedGuardName(text),i=normalized.indexOf(phrase);
  const before=normalized.slice(Math.max(0,i-80),i);
  if(/\b(single|song|track|album|ep|debut|music video|new release)\s*$/u.test(before))return true;
  const quoted=String(text).match(/“[^“”]{1,160}”|"[^"]{1,160}"|‘[^‘’]{1,160}’/g)??[];
  return quoted.some(q=>guardPhraseIn(phrase,q));
}
export function proposeEvidenceGuard(artist,finding,{mode='targeted_title_guard'}={}){
  if(!['targeted_title_guard','require_identity_reference'].includes(mode))
    throw Error('Unknown offline guard mode');
  const prior=finding.reviewSuggestion??finding.review?.reviewSuggestion??finding.decision?.reviewSuggestion;
  const output=(status,reason,proposed,referenceKinds=[])=>({
    policy:EVIDENCE_GUARD_PROPOSAL,mode,executionMode:'offline_only',
    originalReviewSuggestion:typeof prior==='boolean'?prior:null,
    proposedReviewSuggestion:proposed,status,reason,referenceKinds,
    verified:false,liveLinkAccepted:false,originalDecisionChanged:false,
  });
  if(prior===false)return output('keep_existing_hold','Never promote a prior nonpositive decision',false);
  if(prior!==true)return output('not_comparable','Missing original decision',null);
  const state=finding.metadataActuallyUsed;
  if(!state||typeof state!=='object'||Array.isArray(state))
    return output('not_comparable','Original model input unavailable',null);
  const evidence=state.catalogAccountEvidence;
  const url=instagramProfileUrl(finding.url);
  const candidate=state.candidates?.find(c=>instagramProfileUrl(c.url)===url);
  if(!url||!candidate||!evidence
    ||String(evidence.profileId)!==String(artist.profile_id)
    ||String(evidence.cmArtist)!==String(artist.cm_artist)
    ||instagramProfileUrl(evidence.candidateUrl)!==url
    ||normalizedGuardName(state.artist)!==normalizedGuardName(artist.artist))
    return output('not_comparable','Saved input identity binding is incomplete or mismatched',null);
  const answer=finding.recordedAnswer;
  if(!['likely','verified'].includes(answer?.verdict)
    ||!Number.isFinite(answer.sameIdentityProbability)
    ||answer.sameIdentityProbability<0||answer.sameIdentityProbability>1)
    return output('keep_existing_hold','Saved positive model answer is missing or invalid',false);
  const kinds=[];
  const accounts=Array.isArray(evidence.accounts)?evidence.accounts:[];
  if(accounts.some(a=>typeof a.platform==='string'&&a.platform!=='instagram'
    &&a.is_active!==false&&a.is_active!==0&&a.is_active!=='0'&&https(a.url)))
    kinds.push('known_other_platform_catalog_account');
  const referenceUrl=https(candidate.reference?.url);
  if(typeof candidate.reference?.platform==='string'
    &&!['catalog','instagram'].includes(candidate.reference.platform)
    &&referenceUrl&&referenceUrl===https(state.knownProfileUrl)
    &&!new URL(referenceUrl).hostname.endsWith('chartmetric.com'))
    kinds.push('supplied_non_catalog_artist_reference');
  const catalogUrl=`https://app.chartmetric.com/artist/${artist.cm_artist}`;
  const direct=(candidate.candidate?.externalUrls??[]).map(https).filter(Boolean);
  const exact=candidate.observedExactCatalogLinks??[];
  if(direct.includes(catalogUrl)&&Array.isArray(exact)&&exact.some(link=>
    https(typeof link==='string'?link:link?.catalogUrl)===catalogUrl))
    kinds.push('candidate_declares_exact_catalog_artist_record');
  if(kinds.length)return output('retain_prior_suggestion',
    'Identity-bearing reference was supplied; original ownership judgment still requires review',true,kinds);
  const nameAgrees=guardNameAgreement(artist.artist,candidate.candidate?.displayName,finding.url);
  const titleOverlap=guardTitleStyleOverlap(normalizedGuardName(artist.artist),candidate.candidate?.bio??'');
  if(mode==='targeted_title_guard'&&!(nameAgrees===false&&titleOverlap))
    return output('retain_prior_suggestion',
      'No targeted title-confusion trigger; this is not independent validation',true);
  return output('needs_more_identity_evidence',mode==='targeted_title_guard'
    ?'Different account name and release-title overlap without a supplied identity-bearing reference'
    :'No identity-bearing artist reference was supplied; keep in review, not a mismatch verdict',false);
}
