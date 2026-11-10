import assert from 'node:assert/strict';
import {catalogReferences,instagramProfileUrl} from './musician-instagram-matching.mjs';

// A catalog association is not a captured declaration by the account owner.
// Exact handle reuse is supporting context, never a link or ownership verdict.
export function catalogAccountContext(player,candidateUrl){
  assert.ok(player?.source_identity_matches===true
    &&player.profile_id!=null&&player.cm_artist!=null
    &&String(player.catalog_profile?.profile_id)===String(player.profile_id)
    &&String(player.catalog_profile?.cm_artist)===String(player.cm_artist),
  'Catalog account context requires a bound artist identity.');
  const canonical=instagramProfileUrl(candidateUrl);
  assert.ok(canonical&&canonical===candidateUrl,'Invalid candidate account.');
  const handle=new URL(canonical).pathname.split('/')[1];
  const current={...player,accounts:(player.accounts??[]).filter(a=>
    a.is_active!==false&&a.is_active!==0&&a.is_active!=='0'
    &&(a.cm_artist==null||String(a.cm_artist)===String(player.cm_artist)))};
  const seen=new Set();
  const accounts=catalogReferences(current).filter(a=>{
    if(seen.has(a.url))return false;seen.add(a.url);return true;
  }).map(a=>{
    const path=new URL(a.url).pathname;
    const publicHandle=['tiktok','youtube'].includes(a.platform)&&path.startsWith('/@')
      ?path.slice(2):null;
    return {...a,...(publicHandle?{publicHandle,
      exactCandidateHandleMatch:publicHandle.toLowerCase()===handle}: {})};
  });
  return {
    source:'frozen_artist_catalog',
    profileId:String(player.profile_id),cmArtist:String(player.cm_artist),
    candidateUrl:canonical,accounts,
    note:'Catalog associations, not newly fetched pages or owner-declared cross-links. Exact public-handle reuse supports identity but is not proof alone. Different handles, absent accounts and unfetched pages are not contradictions. Retain ownership and shared-handle conflict checks.',
  };
}

export function auditCatalogAccountOmissions(outcomes){
  return outcomes.map(row=>{
    const context=catalogAccountContext(row.artistCatalogMetadata,row.candidateInstagramUrl);
    const state=row.metadataActuallyUsed;
    // Count only structured account evidence actually delivered, not incidental
    // URLs in a historical Google snippet or untrusted biography.
    const delivered=new Set([state?.knownProfileUrl,
      ...(state?.candidates??[]).flatMap(c=>[c.reference?.url,...(c.observedExactCatalogLinks??[]).map(e=>e.catalogUrl)]),
      ...(state?.catalogAccountEvidence?.accounts??[]).map(a=>a.url)].filter(Boolean));
    const omitted=state?context.accounts.filter(a=>!delivered.has(a.url)):[];
    return {...row,catalogAccountsOmittedFromSavedCheck:omitted,
      omittedExactHandleMatches:omitted.filter(a=>a.exactCandidateHandleMatch===true),
      revisedCatalogAccountContext:context,
      offlineAuditStatus:!state?'not_checked_no_saved_model_input'
        :omitted.length?'supporting_catalog_accounts_omitted':'no_catalog_account_omission',
      decisionChanged:false};
  });
}
