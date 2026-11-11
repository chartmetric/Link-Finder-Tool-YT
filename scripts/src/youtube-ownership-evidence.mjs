// Pure offline assembly. Catalog observations are not newly fetched source pages,
// and release consistency never establishes ownership on its own.
import {evidenceDigest,youtubeOwnershipUrl,boundYoutubeCapture,youtubeMusicKey} from './youtube-ownership-policy.mjs';

const same=(a,b)=>String(a)===String(b);
export function assertYoutubeCatalogBinding(artist,packet){
  if(!packet||!same(packet.profileId,artist.profileId)||!same(packet.cmArtist,artist.cmArtist)
    ||!same(packet.catalogProfile?.profile_id,artist.profileId)
    ||!same(packet.catalogProfile?.cm_artist,artist.cmArtist))
    throw Error('Supplemental catalog evidence does not match the exact artist.');
}
export function declaredYoutubeLinks(value){
  if(typeof value!=='string')return [];
  // Explicit destinations only: no free-form @mentions, names or search text.
  return [...new Set([...value.matchAll(/https:\/\/(?:www\.|m\.|music\.)?youtube\.com\/[^\s<>"']+/giu)]
    .map(m=>youtubeOwnershipUrl(m[0].replace(/[),.;]+$/u,''))).filter(Boolean))];
}
function accountBound(artist,a){
  return same(a.profile_id,artist.profileId)&&same(a.cm_artist,artist.cmArtist)
    &&a.wasInFrozenBatch===true&&typeof a.account_url==='string'&&a.account_url.startsWith('https://');
}
export function assembleYoutubeOwnershipEvidence(artist,packet,candidate){
  assertYoutubeCatalogBinding(artist,packet);
  const accounts=(packet.linkedAccounts??[]).filter(a=>accountBound(artist,a));
  const declarations=[],contextOnly=[];
  for(const row of packet.accountSnapshots??[]){
    const matches=accounts.filter(a=>same(a.account_id,row.account_id)&&a.platform===row.platform);
    if(matches.length!==1||!Number.isFinite(Date.parse(row.source_updated_at))){
      contextOnly.push({kind:'unbound_or_undated_account_snapshot',record:row});continue;
    }
    const a=matches[0],links=declaredYoutubeLinks(row.bio);
    if(!links.length){
      if(row.bio?.trim())contextOnly.push({kind:'catalog_account_bio_without_resolved_youtube_destination',
        sourceUrl:a.account_url,record:row});
      continue;
    }
    declarations.push({kind:'catalog_account_declaration',profileId:String(artist.profileId),
      cmArtist:String(artist.cmArtist),accountId:String(a.account_id),sourceUrl:a.account_url,
      source:'new_vertical.account_snapshots',sourceUpdatedAt:row.source_updated_at,
      observedAt:packet.collectedAt,declaredLinks:links,sourceText:row.bio,
      sourceRecord:row,sourceRecordSha256:evidenceDigest(row),
      binding:'exact_catalog_account_id_not_independently_verified'});
  }
  for(const capture of packet.savedOfficialAccountCaptures??[]){
    const bound=bindSavedInstagramReference(artist,packet,capture.receipt);
    if(!bound){contextOnly.push({kind:'unbound_saved_reference',sourceFile:capture.sourceFile});continue;}
    if(!bound.body.declaredLinks.length)continue;
    declarations.push({kind:'saved_catalog_account_declaration',profileId:String(artist.profileId),
      cmArtist:String(artist.cmArtist),accountId:bound.accountId,sourceUrl:bound.sourceUrl,
      source:'saved_scrapecreators_instagram_profile',sourceUpdatedAt:bound.capturedAt,
      observedAt:packet.collectedAt,declaredLinks:bound.body.declaredLinks,sourceText:bound.body.biography,
      sourceRecord:bound,sourceRecordSha256:evidenceDigest(bound),
      binding:'exact_catalog_account_id_not_independently_verified'});
  }
  for(const row of packet.spotifyMetadata??[]){
    const a=accounts.filter(a=>a.platform==='spotify'&&
      spotifyId(a.account_url)===row.account_id);
    const links=declaredYoutubeLinks(row.latest?.[1]);
    if(!links.length)continue;
    if(a.length!==1||!same(row.profile_id,artist.profileId)||row.usableAsContext!==true){
      contextOnly.push({kind:'unbound_spotify_biography',record:row});continue;
    }
    declarations.push({kind:'catalog_account_declaration',profileId:String(artist.profileId),
      cmArtist:String(artist.cmArtist),accountId:String(a[0].account_id),sourceUrl:a[0].account_url,
      source:'new_vertical.profile_spotify',sourceUpdatedAt:row.latest[4],observedAt:packet.collectedAt,
      declaredLinks:links,sourceText:row.latest[1],sourceRecord:row,sourceRecordSha256:evidenceDigest(row),
      binding:'exact_catalog_account_id_not_independently_verified'});
  }
  for(const row of packet.platformSnapshots??[])contextOnly.push({kind:'profile_platform_snapshot_not_account_bound',record:row});
  for(const row of packet.profileMetadata??[])contextOnly.push({kind:'resolved_profile_context_not_independent',record:row});
  const musicIds=accounts.flatMap(a=>{
    const id=spotifyId(a.account_url);
    return a.platform==='spotify'&&id?[{platform:'spotify',artistId:id,
      catalogAccountId:String(a.account_id),sourceUrl:a.account_url,sourceUpdatedAt:a.source_updated_at}]:[];
  });
  const releases=[
    ...(packet.releases??[]).filter(r=>musicIds.some(i=>i.artistId===r.spotify_artist_id)),
    ...(packet.catalogTracks??[]).filter(r=>same(r.cm_artist,artist.cmArtist)),
  ];
  const capture=boundYoutubeCapture(candidate.url,candidate.capture);
  // Only explicit publisher channel IDs in actual saved records count here.
  // Titles/snippets and a containing response alone cannot supply attribution.
  const raw=candidate.capture?.rawReceipt;
  let videoSourceBound=false;
  try{
    const u=new URL(raw.request.url);
    videoSourceBound=!!capture&&raw.kind==='metadata'&&raw.status===200&&!raw.parseFailed
      &&raw.data?.success===true&&raw.data.channelId===capture.body.channelId
      &&raw.at===candidate.capture.capturedAt&&evidenceDigest(raw)===candidate.capture.rawReceiptSha256
      &&raw.request.method==='GET'&&raw.request.body===undefined
      &&evidenceDigest(raw.request)===raw.inputSha256&&u.origin==='https://api.scrapecreators.com'
      &&!u.username&&!u.password&&!u.hash&&u.pathname==='/v1/youtube/channel'
      &&u.searchParams.size===1&&youtubeOwnershipUrl(u.searchParams.get('url'))===youtubeOwnershipUrl(candidate.url);
  }catch{/* No attributable saved video evidence. */}
  const videos=(videoSourceBound&&Array.isArray(raw.data.videos)?raw.data.videos:[])
    .filter(v=>v.channelId===capture.body.channelId
      &&typeof v.videoId==='string'&&/^[A-Za-z0-9_-]{11}$/.test(v.videoId)
      &&typeof v.title==='string')
    .map(v=>({...v,sourceReceiptSha256:evidenceDigest(raw),capturedAt:raw.at}));
  return {profileId:String(artist.profileId),cmArtist:String(artist.cmArtist),
    catalogPacketSha256:evidenceDigest(packet),observedAt:packet.collectedAt,
    declarations,musicIds,releases,channelAttributedVideos:videos,contextOnly,
    searchEvidence:{title:candidate.title??'',snippet:candidate.snippet??'',sourceUrl:candidate.sourceUrl??candidate.url,
      kind:'saved_search_snippet_not_captured_video'},
    unavailable:{officialSourcePageCaptures:!(artist.declarations??[]).length,
      channelAttributedVideos:!videos.length,officialArtistChannel:capture?.body.isOfficialArtistChannel==null,
      autoGenerated:capture?.body.isAutoGenerated==null},
    warning:'Existing catalog observations, not independent adjudication or new provider evidence. No ownership acceptance.'};
}
// Exact catalog account, exact requested handle, exact returned account and
// archived artist occurrence all have to agree. Discovery candidates do not
// become official references merely because they have a biography.
export function bindSavedInstagramReference(artist,packet,receipt){
  if(receipt?.status!==200||receipt.data?.success!==true||receipt.parseFailed
    ||!Number.isFinite(Date.parse(receipt.at)))return null;
  const profile=receipt.profileId??receipt.operationKey?.match(/^metadata-(\d+)-[a-f0-9]{64}$/)?.[1];
  if(String(profile)!==String(artist.profileId))return null;
  const request=receipt.request;
  if(request&&(request.method!=='GET'||request.body!==undefined
    ||evidenceDigest(request)!==receipt.inputSha256))return null;
  let handle;
  try{
    const u=new URL(request?.url??receipt.url);
    if(u.origin!=='https://api.scrapecreators.com'||u.pathname!=='/v1/instagram/profile'
      ||u.username||u.password||u.hash||u.searchParams.size!==1)return null;
    handle=u.searchParams.get('handle')?.toLowerCase();
  }catch{return null;}
  const user=receipt.data.data?.user;
  if(!handle||user?.username?.toLowerCase()!==handle)return null;
  const accounts=(packet.linkedAccounts??[]).filter(a=>accountBound(artist,a)&&a.platform==='instagram'
    &&instagramHandle(a.account_url)===handle);
  if(accounts.length!==1)return null;
  const body={biography:typeof user.biography==='string'?user.biography:'',
    externalUrl:typeof user.external_url==='string'?user.external_url:null,
    bioLinks:Array.isArray(user.bio_links)?user.bio_links.filter(v=>typeof v?.url==='string').map(v=>v.url):[]};
  body.declaredLinks=declaredYoutubeLinks([body.biography,body.externalUrl,...body.bioLinks].join('\n'));
  return {profileId:String(artist.profileId),cmArtist:String(artist.cmArtist),accountId:String(accounts[0].account_id),
    sourceUrl:accounts[0].account_url,capturedAt:receipt.at,body,receiptSha256:evidenceDigest(receipt),
    requestBinding:request?'saved_request_hash':'legacy_saved_request_url_no_hash'};
}
function instagramHandle(raw){
  try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
    &&['instagram.com','www.instagram.com'].includes(u.hostname)&&/^\/[\w.]+\/?$/.test(u.pathname)
    ?u.pathname.split('/')[1].toLowerCase():null;
  }catch{return null;}
}
export function spotifyId(raw){
  const key=youtubeMusicKey(raw);
  return key?.startsWith('spotify:')?key.slice('spotify:'.length):null;
}
export function youtubeArtistFromCatalogPacket(packet){
  const artist={profileId:packet.profileId,cmArtist:packet.cmArtist,name:packet.artist,catalogProfile:packet.catalogProfile,
    country:packet.chartmetric?.code2??null,label:packet.chartmetric?.label??packet.chartmetric?.record_label??null,
    accounts:packet.linkedAccounts.filter(a=>a.account_url?.trim()),releases:[...packet.releases,...packet.catalogTracks],
    context:{chartmetric:packet.chartmetric,tags:packet.tags,spotify:packet.spotifyMetadata,
      platformSnapshots:packet.platformSnapshots,profileMetadata:packet.profileMetadata,
      warning:'Catalog context is not independent ownership proof. Platform snapshots are not account-bound captures.'}};
  assertYoutubeCatalogBinding(artist,packet);
  return artist;
}
