// Offline acquisition only. Never imported by live matching; no paid APIs or DB.
import {createHash} from 'node:crypto';
import {catalogReferences,referenceUrl} from './musician-instagram-matching.mjs';
import {sealOfflineSnapshot} from './instagram-source-policy-offline.mjs';
import {createCatalogProfileReader} from './catalog-website-source-fetch.mjs';
import {catalogProfileIdentity} from './catalog-profile-identity.mjs';
export {catalogProfileIdentity} from './catalog-profile-identity.mjs';

export const CATALOG_WEBSITE_COLLECTOR='catalog-profile-declaration-v1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const rejectedKeys=new Set(['expectedArtistOwned','labelEvidence','labelTier','adjudication','stratum']);
const blind=value=>!value||typeof value!=='object'||Object.entries(value).every(
  ([key,v])=>!rejectedKeys.has(key)&&blind(v));
export function assertSourceInputsBlind(value){
  if(!blind(value))throw new Error('Evaluator labels cannot be source inputs.');
}
const pageKey=value=>{
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
    ? u.href:null;}catch{return null;}
};
const ineligibleHosts=['instagram.com','facebook.com','tiktok.com','twitter.com','x.com',
  'youtube.com','youtu.be','spotify.com','google.com','bing.com','search.yahoo.com',
  'duckduckgo.com','linktr.ee'];

// Declaration targets are never fetched. Social/search/link-hub links aren't
// artist website declarations, even when a page labels them "official website".
export function declaredWebsiteUrl(value){
  try{
    const u=new URL(value);
    if(!pageKey(value)||!u.hostname.includes('.')||u.hostname.endsWith('.')
      ||u.hostname==='localhost'||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')
      ||ineligibleHosts.some(host=>u.hostname===host||u.hostname.endsWith(`.${host}`)))return null;
    return u.href;
  }catch{return null;}
}

function jsonObject(text,start){
  // Parse inert JSON only, never JavaScript or JSON.parse(...) wrappers.
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<text.length;i++){
    const c=text[i];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;
    else if(c==='{'||c==='[')depth++;
    else if(c==='}'||c===']'){if(--depth===0)return JSON.parse(text.slice(start,i+1));}
  }
  throw new Error('Incomplete profile JSON.');
}
function profileData(body,platform){
  const scripts=[...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if(platform==='spotify'){
    const selected=scripts.filter(m=>/\bid\s*=\s*["']__NEXT_DATA__["']/i.test(m[1]));
    if(selected.length!==1)throw new Error('Unsupported Spotify profile layout.');
    return JSON.parse(selected[0][2]);
  }
  const selected=scripts.map(m=>/^\s*(?:var\s+)?ytInitialData\s*=\s*(?=\{)/.exec(m[2]))
    .filter(Boolean);
  if(selected.length!==1)throw new Error('Unsupported YouTube profile layout.');
  const m=selected[0];return jsonObject(m.input,m[0].length);
}

/** Context validation is separate from transport safety. Only named artist
 * external-link fields qualify; arbitrary anchors, copied IDs and footers don't. */
export function selectCatalogWebsiteLinks(reference,body){
  const data=profileData(body,reference.platform);
  let items=[],contextPath;
  if(reference.platform==='spotify'){
    const entity=data?.props?.pageProps?.state?.data?.entity;
    if(entity?.type!=='artist'||`spotify:artist:${reference.url.split('/').at(-1)}`!==entity.uri)
      throw new Error('Wrong Spotify artist identity.');
    contextPath='props.pageProps.state.data.entity.externalLinks.items';
    items=entity.externalLinks?.items??[];
  }else{
    const metadata=data?.metadata?.channelMetadataRenderer;
    const identityUrls=[metadata?.channelUrl,metadata?.vanityChannelUrl,
      metadata?.externalId?`https://www.youtube.com/channel/${metadata.externalId}`:null];
    if(!identityUrls.some(url=>referenceUrl(url,'youtube')===reference.url))
      throw new Error('Wrong YouTube channel identity.');
    const tabs=data?.contents?.twoColumnBrowseResultsRenderer?.tabs??[];
    for(const [t,tab] of tabs.entries()){
      const r=tab?.tabRenderer;
      if(r?.selected!==true||r.title!=='About')continue;
      for(const [s,section] of (r.content?.sectionListRenderer?.contents??[]).entries()){
        for(const [i,item] of (section?.itemSectionRenderer?.contents??[]).entries()){
          const about=item?.channelAboutFullMetadataRenderer;
          if(!about)continue;
          if(about.channelId&&about.channelId!==metadata.externalId)throw new Error('Wrong about-section channel identity.');
          if(contextPath)throw new Error('Ambiguous channel about sections.');
          contextPath=`contents.twoColumnBrowseResultsRenderer.tabs[${t}].tabRenderer.content.sectionListRenderer.contents[${s}].itemSectionRenderer.contents[${i}].channelAboutFullMetadataRenderer.primaryLinks`;
          items=(about.primaryLinks??[]).map(link=>({
            name:link.title?.simpleText??link.title?.runs?.map(r=>r.text).join(''),
            url:link.navigationEndpoint?.urlEndpoint?.url,
          }));
        }
      }
    }
  }
  if(!Array.isArray(items)||items.length>100)throw new Error('Malformed external-link section.');
  const links=items.flatMap((item,index)=>{
    if(!item||! /^(?:official )?website$/i.test(item.name??''))return [];
    const url=declaredWebsiteUrl(item.url);
    return url?[{url,rawUrl:item.url,label:item.name,contextKind:'catalog_artist_external_link',
      contextId:reference.url,contextPath:`${contextPath}[${index}]`}]:[];
  });
  if(!links.length)throw new Error('No independently declared artist website in supported source context.');
  return links;
}

export function adaptCatalogWebsiteArchive({player,reference,archive,now,maxEvidenceAgeMs}){
  assertSourceInputsBlind({player,reference,archive});
  if(!catalogReferences(player).some(r=>r.platform===reference.platform&&r.url===reference.url)
    ||!['spotify','youtube'].includes(reference.platform))throw new Error('Inactive or unbound catalog account.');
  if(archive?.kind!=='catalog_profile_http'||archive.status!==200
    ||typeof archive.body!=='string'||Buffer.byteLength(archive.body)>2_000_000)
    throw new Error('Original catalog-profile HTTP body required; summaries/search/grading pages are ineligible.');
  if(!Number.isFinite(now)||!Number.isSafeInteger(maxEvidenceAgeMs)||maxEvidenceAgeMs<=0)
    throw new Error('Explicit evaluation time and evidence age required.');
  const at=typeof archive.observedAt==='string'?Date.parse(archive.observedAt):NaN;
  if(!Number.isFinite(at)||at>now||now-at>maxEvidenceAgeMs)throw new Error('Unknown, stale or future source observation time.');
  if(archive.bodySha256!==hash(archive.body))throw new Error('Original body hash mismatch.');
  if(archive.packetSha256!==undefined){
    const {packetSha256,...original}=archive;
    if(packetSha256!==hash(JSON.stringify(original)))throw new Error('Original archive packet digest mismatch.');
  }
  if(catalogProfileIdentity(archive.sourceUrl,reference.platform)!==reference.url
    ||catalogProfileIdentity(archive.finalUrl,reference.platform)!==reference.url)
    throw new Error('Source/final URL is not the exact catalog artist.');
  const redirects=archive.redirects??[];
  if(!Array.isArray(redirects)||redirects.length>3)throw new Error('Invalid redirect chain.');
  let previous=archive.sourceUrl;
  for(const hop of redirects){
    if(hop?.sourceUrl!==previous||![301,302,303,307,308].includes(hop.status)
      ||catalogProfileIdentity(hop.finalUrl,reference.platform)!==reference.url)
      throw new Error('Unbound profile redirect.');
    previous=hop.finalUrl;
  }
  if(previous!==archive.finalUrl)throw new Error('Missing redirect provenance.');
  const selectedLinks=selectCatalogWebsiteLinks(reference,archive.body);
  const activeIds=new Set(player.account_ids.map(String));
  const catalogAccountIds=player.accounts.filter(account=>activeIds.has(String(account.account_id))
    &&!account.disconnected_at&&(account.profile_id===undefined||String(account.profile_id)===String(player.profile_id))
    &&String(account.platform).toLowerCase()===reference.platform
    &&referenceUrl(account.account_url,reference.platform)===reference.url).map(account=>String(account.account_id));
  return sealOfflineSnapshot({
    kind:'catalog_reference_external_links',collector:CATALOG_WEBSITE_COLLECTOR,
    profileId:String(player.profile_id),referencePlatform:reference.platform,
    catalogAccountIds,catalogSnapshotSha256:hash(JSON.stringify(player)),
    sourceUrl:archive.sourceUrl,finalUrl:archive.finalUrl,observedAt:archive.observedAt,
    bodySha256:archive.bodySha256,archivePacketSha256:hash(JSON.stringify(archive)),
    ...(archive.packetSha256?{originalPacketSha256:archive.packetSha256}:{}),
    redirects:structuredClone(redirects),selectedLinks,
    links:[...new Set(selectedLinks.map(link=>link.url))],
  });
}

/** Prefer usable archived observations; public HTTP is a separately bounded,
 * explicit opt-in. No website fetches, search, providers, credentials or writes.
 * `pages` must already be independently captured, same-section page snapshots;
 * this collector never synthesizes them from grading sites. */
export async function collectCatalogWebsiteDeclarations({
  player,archives=[],pages=[],now,maxEvidenceAgeMs,publicFetch,
}){
  assertSourceInputsBlind({player,archives,pages});
  if(!Array.isArray(archives)||!Array.isArray(pages)||archives.length>1000||pages.length>1000)
    throw new Error('Bounded archive/page arrays required.');
  if(archives.reduce((bytes,a)=>bytes+(typeof a?.body==='string'?Buffer.byteLength(a.body):0),0)>20_000_000)
    throw new Error('Archived source bodies exceed 20 MB total limit.');
  if(!Number.isFinite(now)||!Number.isSafeInteger(maxEvidenceAgeMs)||maxEvidenceAgeMs<=0)
    throw new Error('Explicit evaluation time and evidence age required.');
  const references=catalogReferences(player).filter(r=>['spotify','youtube'].includes(r.platform));
  if(references.length>20)throw new Error('Too many catalog references.');
  const read=publicFetch?.enabled===true?createCatalogProfileReader(publicFetch):null;
  const declarations=[],unresolved=[],capturedArchives=[];
  let sourceEvaluationTime=now;
  for(const reference of references){
    const failures=[];
    const matching=archives.filter(a=>catalogProfileIdentity(a?.sourceUrl,reference.platform)===reference.url);
    // Never recover a removed/revoked declaration by falling back to an older
    // successful page. Unknown observation times cannot be ordered safely.
    const latest=Math.max(...matching.map(a=>Date.parse(a.observedAt)));
    const newest=matching.some(a=>!Number.isFinite(Date.parse(a.observedAt)))?matching:
      matching.filter(a=>Date.parse(a.observedAt)===latest);
    const usable=[];
    for(const archive of newest){
      try{usable.push(adaptCatalogWebsiteArchive({player,reference,archive,now,maxEvidenceAgeMs}));}
      catch(error){failures.push(error.message);}
    }
    let declaration=failures.length?undefined:usable[0];
    if(declaration&&usable.some(d=>JSON.stringify(d.links)!==JSON.stringify(declaration.links))){
      unresolved.push({reference,reason:'Conflicting declarations at the same observation time.'});continue;
    }
    if(!declaration&&read){
      try{
        const archive=await read(reference);
        capturedArchives.push(archive);
        // Public acquisition occurs after the caller's preflight time. Report
        // the actual later evaluation time; never backdate the new observation.
        sourceEvaluationTime=Math.max(now,Date.now());
        declaration=adaptCatalogWebsiteArchive({player,reference,archive,
          now:sourceEvaluationTime,maxEvidenceAgeMs});
      }catch(error){failures.push(error.message);}
    }
    if(declaration)declarations.push(declaration);
    else unresolved.push({reference,reason:'Independent catalog website declaration unresolved.',
      details:failures.length?failures:['No original catalog-profile declaration archived.']});
  }
  const websiteEvidence=declarations.flatMap(catalogDeclaration=>pages.filter(page=>
    pageKey(page?.sourceUrl)&&catalogDeclaration.links.some(url=>pageKey(url)===pageKey(page.sourceUrl)))
    .map(page=>({profileId:String(player.profile_id),catalogDeclaration,page})));
  return {collector:CATALOG_WEBSITE_COLLECTOR,offlineOnly:true,productionApproved:false,
    claimsAllowed:false,paidCalls:0,databaseWrites:0,sourceEvaluationTime,
    declarations,websiteEvidence,unresolved,capturedArchives,
    ...(references.length?{}:{reason:'No active supported catalog music/video account.'})};
}
