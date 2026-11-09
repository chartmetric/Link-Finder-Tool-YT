// Experimental contract only. No HTTP, credentials, persistence, claims or live imports.
import {createHash} from 'node:crypto';
import {assessInstagramCandidates,catalogReferences,instagramProfileUrl,referenceUrl} from './musician-instagram-matching.mjs';

export const OFFLINE_SOURCE_POLICY='trusted-website-offline-v1';
const forbidden=new Set(['expectedArtistOwned','labelEvidence','labelTier','adjudication','stratum']);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical=value=>{
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
    ? `${u.origin}${u.pathname.replace(/\/+$/,'')||'/'}`:null;}catch{return null;}
};
const bound=(metadata,url,normalize)=>[metadata?.url,...(metadata?.urlAliases??[])].some(u=>normalize(u)===url);
const fresh=(at,now,maxAge)=>typeof at==='string'&&Number.isFinite(Date.parse(at))
  &&Date.parse(at)<=now&&now-Date.parse(at)<=maxAge;
const blind=value=>{
  if(!value||typeof value!=='object')return true;
  return Object.entries(value).every(([k,v])=>!forbidden.has(k)&&blind(v));
};

// Digest binds the selected observation, not proof that its contents are true.
// A future approved collector must establish the real provenance and context.
export function sealOfflineSnapshot(snapshot){return {...snapshot,packetSha256:sha(snapshot)};}
function validSnapshot(packet,now,maxAge){
  if(!packet||typeof packet!=='object')return false;
  const {packetSha256,...snapshot}=packet;
  return packetSha256===sha(snapshot)&&/^[a-f0-9]{64}$/.test(snapshot.bodySha256??'')
    &&!!canonical(snapshot.sourceUrl)&&fresh(snapshot.observedAt,now,maxAge)&&Array.isArray(snapshot.links);
}

/**
 * The minimum source score and validity windows are mandatory experimental
 * parameters, not approved policy defaults. No output authorizes a live link.
 * Grading labels are deliberately not part of this interface.
 */
export function assessOfflineSourcePolicy({player,result,websiteEvidence=[],config,now}){
  const envelope={policy:OFFLINE_SOURCE_POLICY,offlineOnly:true,productionApproved:false,
    claimsAllowed:false,defaultPolicyChanged:false,noAccountConfirmed:false};
  const hold=reason=>({...envelope,status:'blocked',reason,candidates:[],simulationUrls:[]});
  if(!blind({player,result,websiteEvidence}))return hold('evaluator_labels_in_input');
  if(!Number.isFinite(now))return hold('explicit_evaluation_time_required');
  if(config?.mode!=='offline')return hold('offline_mode_required');
  if(!Array.isArray(websiteEvidence))return hold('malformed_website_evidence');
  let baseline;
  try{baseline=assessInstagramCandidates(result,player);}catch{return hold('incomplete_or_invalid_discovery');}
  const references=catalogReferences(player);
  const sourceParamsValid=Number.isFinite(config.minimumSourceIdentityScore)
    &&config.minimumSourceIdentityScore>=0&&config.minimumSourceIdentityScore<=1
    &&Number.isSafeInteger(config.maxEvidenceAgeMs)&&config.maxEvidenceAgeMs>0
    &&Number.isSafeInteger(config.maxVerifierAgeMs)&&config.maxVerifierAgeMs>0;
  const assess=(profile,index)=>{
    const url=instagramProfileUrl(profile.url),comparison=profile.identityComparison,jev=profile.jevVerification;
    const base=baseline.candidates[index];
    const answer=(route,reason)=>({url:url??String(profile.url??''),baselineStatus:base.status,
      route,reason,simulationAccepted:route!=='hold',productionApproved:false,claimsAllowed:false});
    if(!url)return answer('hold','invalid_account_url');
    if([profile.contradictions,profile.conflictingProfileIds].some(v=>v!==undefined&&!Array.isArray(v))){
      return answer('hold','malformed_conflict_evidence');
    }
    if(comparison?.status==='mismatch'||jev?.verdict==='mismatch')return answer('hold','mismatch');
    if(profile.contradictions?.length||profile.conflictingProfileIds?.length)return answer('hold','unresolved_conflict');
    if(profile.ownershipContext!=='artist_account')return answer('hold','ownership_context_not_established');
    if(/\b(fan ?page|fan account|record label|festival|venue|tribute|manufacturer)\b/i.test(
      `${profile.title??''} ${comparison?.candidate?.displayName??''} ${comparison?.candidate?.bio??''}`)){
      return answer('hold','related_entity');
    }
    if(base.status==='supported')return answer('existing_supported','unchanged_standard_gate_passed');
    if(!sourceParamsValid)return answer('hold','experimental_source_parameters_not_selected');
    const reference=references.find(r=>bound(comparison?.reference,r.url,u=>referenceUrl(u,r.platform)));
    if(!reference||!bound(comparison?.candidate,url,instagramProfileUrl)||comparison.status!=='likely'){
      return answer('hold','unbound_identity_metadata');
    }
    if(jev?.verdict!=='verified'||!Number.isFinite(jev.sameIdentityProbability)
      ||jev.sameIdentityProbability<0||jev.sameIdentityProbability>1
      ||jev.sameIdentityProbability<config.minimumSourceIdentityScore
      ||!jev.model||!/^[a-f0-9]{64}$/.test(jev.requestSha256??'')
      ||!fresh(jev.observedAt,now,config.maxVerifierAgeMs)
      ||String(jev.profileId)!==String(player.profile_id)||instagramProfileUrl(jev.accountUrl)!==url){
      return answer('hold','verifier_missing_stale_unbound_or_below_experimental_floor');
    }
    const proof=websiteEvidence.find(e=>{
      if(!e||typeof e!=='object')return false;
      if(String(e.profileId)!==String(player.profile_id)||!validSnapshot(e.page,now,config.maxEvidenceAgeMs)
        ||!validSnapshot(e.catalogDeclaration,now,config.maxEvidenceAgeMs))return false;
      // Only an existing catalog-bound reference may establish domain trust.
      // Search hits, candidate self-links and page self-assertions cannot.
      if(e.catalogDeclaration.kind!=='catalog_reference_external_links'
        ||referenceUrl(e.catalogDeclaration.sourceUrl,reference.platform)!==reference.url
        ||!e.catalogDeclaration.links.some(u=>canonical(u)===canonical(e.page.sourceUrl)))return false;
      const ig=e.page.links.filter(l=>l&&l.contextKind==='artist_specific'
        &&instagramProfileUrl(l.url)===url&&typeof l.contextId==='string'&&l.contextId.length>0);
      return ig.some(i=>e.page.links.some(l=>l&&l.contextKind==='artist_specific'&&l.contextId===i.contextId
        &&referenceUrl(l.url,reference.platform)===reference.url));
    });
    return proof?{...answer('source_confirmed_simulation','trusted_source_contract_passed'),
      sourceUrl:proof.page.sourceUrl,sourcePacketSha256:proof.page.packetSha256,
      trustPacketSha256:proof.catalogDeclaration.packetSha256,verifierRequestSha256:jev.requestSha256}
      :answer('hold','independent_trust_or_same_context_exact_links_missing');
  };
  const candidates=result.profiles.map(assess);
  // Every occurrence must pass; never select only the most favorable result.
  for(const c of candidates){
    if(c.simulationAccepted&&candidates.some(other=>other.url===c.url&&!other.simulationAccepted)){
      c.simulationAccepted=false;c.route='hold';c.reason='conflicting_duplicate_occurrence';
    }
  }
  return {...envelope,status:'offline_simulation',baselinePolicy:baseline.policy,
    baselineUrls:baseline.urls,candidates,
    simulationUrls:[...new Set(candidates.filter(c=>c.simulationAccepted).map(c=>c.url))],
    sourceParametersSelected:sourceParamsValid,populationAccuracyClaim:false,thresholdCalibrated:false};
}
