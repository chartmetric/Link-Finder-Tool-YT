// Comparison only. This is not an ownership-verification or live-acceptance rule.
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
  return evaluateReview(profile,player,options,true);
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
