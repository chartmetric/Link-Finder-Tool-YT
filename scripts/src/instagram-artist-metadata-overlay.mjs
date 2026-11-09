// Read-only catalog enrichment. No discovery, verifier calls, claims or imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const digest=s=>createHash('sha256').update(s).digest('hex');
const text=v=>typeof v==='string'?v:'';
const unique=values=>[...new Set(values)];
const numeric=v=>/^\d+$/.test(String(v));
export function validateScope(manifest,maxArtists=250) {
  const artists=manifest.artists;
  if(!Array.isArray(artists)||!artists.length||artists.length>maxArtists
    ||artists.some(a=>!numeric(a.profile_id)||!numeric(a.cm_artist))
    ||new Set(artists.map(a=>String(a.profile_id))).size!==artists.length)
    throw Error('Invalid frozen artist scope.');
  return artists;
}
export function metadataQueries(manifest,maxArtists=250) {
  const artists=validateScope(manifest,maxArtists),ids=artists.map(a=>a.profile_id).join(',');
  const cms=unique(artists.map(a=>String(a.cm_artist))).join(',');
  const spotifyIds=unique(artists.flatMap(a=>(a.accounts??[]).filter(x=>x.platform==='spotify')
    .map(x=>{try{return new URL(x.account_url).pathname.split('/').filter(Boolean).at(-1);}catch{return '';}})));
  if(spotifyIds.some(id=>!/^[A-Za-z0-9]{22}$/.test(id)))throw Error('Invalid frozen Spotify account.');
  return {
    catalogProfiles:`SELECT toString(id) profile_id,toString(cm_source_id) cm_artist,name,image_url,
      toString(updated_at) source_updated_at FROM new_vertical.profile FINAL
      WHERE id IN (${ids}) AND cm_source='cm_artist'`,
    accounts:`SELECT toString(l.profile_id) profile_id,toString(a.id) account_id,a.platform,a.account_url,
      a.handle,toString(l.connected_at) connected_at,toString(a.modified_at) source_updated_at
      FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id,platform,account_url,handle,modified_at FROM new_vertical.account FINAL
        WHERE is_active=1 AND platform!='instagram') a ON a.id=l.account_id
      WHERE l.disconnected_at IS NULL AND l.profile_id IN (${ids})`,
    snapshots:`SELECT toString(profile_id) profile_id,platform,
      argMax(tuple(ifNull(bio,''),ifNull(display_name,''),ifNull(profile_pic_url,''),
        toString(snapshot_date),toString(updated_at)),tuple(snapshot_date,updated_at)) latest
      FROM new_vertical.profile_snapshots WHERE profile_id IN (${ids}) AND platform!='instagram'
      GROUP BY profile_id,platform`,
    chartmetric:`SELECT toString(id) cm_artist,name,code2,label,record_label,isni,band,is_non_artist,
      toString(modified_at) source_updated_at FROM new_vertical.cm_artist FINAL WHERE id IN (${cms})`,
    tags:`SELECT toString(cm_artist) cm_artist,tag_type,tag_slug,source,toString(created_at) source_updated_at
      FROM new_vertical.l_cm_artist_tag WHERE cm_artist IN (${cms})
      AND tag_type IN ('genre','region','activity','mood')`,
    spotify:`SELECT account_id,toString(profile_id) profile_id,
      argMax(tuple(ifNull(name,''),ifNull(biography,''),ifNull(image_url,''),top_tracks,
        toString(fetched_at)),fetched_at) latest FROM new_vertical.profile_spotify
      WHERE profile_id IN (${ids}) ${spotifyIds.length?`OR account_id IN (${spotifyIds.map(id=>`'${id}'`).join(',')})`:''}
      GROUP BY account_id,profile_id`,
    releases:`SELECT spotify_artist_id,track_name,album_name,toString(updated_at) source_updated_at FROM
      (SELECT spotify_artist_id,track_name,any(album_name) album_name,max(popularity_score) pop,max(updated_at) updated_at
       FROM new_vertical.spotify WHERE spotify_artist_id IN (${spotifyIds.length?spotifyIds.map(id=>`'${id}'`).join(','):"''"})
       AND track_name!='' GROUP BY spotify_artist_id,track_name ORDER BY spotify_artist_id,pop DESC LIMIT 5 BY spotify_artist_id)`,
    cmTracks:`SELECT toString(c.cm_artist) cm_artist,t.name track_name,toString(c.release_date) release_date,
      toString(c.synced_at) source_updated_at FROM
      (SELECT cm_artist,cm_track,max(release_date) release_date,min(track_rank) rank,max(synced_at) synced_at
       FROM new_vertical.prioritised_artist_track_tier_cache WHERE cm_artist IN (${cms})
       GROUP BY cm_artist,cm_track ORDER BY cm_artist,rank LIMIT 5 BY cm_artist) c
      INNER JOIN (SELECT id,name FROM new_vertical.cm_track FINAL WHERE id IN
        (SELECT cm_track FROM new_vertical.prioritised_artist_track_tier_cache WHERE cm_artist IN (${cms}))) t ON t.id=c.cm_track`,
    profileMetadata:`SELECT toString(profile_id) profile_id,
      argMax(tuple(ifNull(bio,''),ifNull(bio_source,''),ifNull(code2,''),ifNull(code2_source,''),
        ifNull(city,''),ifNull(city_source,''),ifNull(primary_language,''),ifNull(primary_language_source,''),
        toString(resolved_at)),resolved_at) latest
      FROM new_vertical.profile_metadata_cache WHERE profile_id IN (${ids}) GROUP BY profile_id`,
  };
}

export function buildMetadataOverlay(manifest,data,collectedAt,maxArtists=250) {
  const artists=validateScope(manifest,maxArtists);
  const sourceNames=['catalogProfiles','accounts','snapshots','chartmetric','tags','spotify','releases','cmTracks','profileMetadata'];
  if(sourceNames.some(k=>!Array.isArray(data[k])))throw Error('Missing catalog query response.');
  const packets=artists.map(a=>{
    const id=String(a.profile_id),cm=String(a.cm_artist);
    const current=data.catalogProfiles.filter(p=>p.profile_id===id);
    if(current.length!==1||current[0].cm_artist!==cm)throw Error('Catalog identity changed; enrichment blocked.');
    const linkedAccounts=data.accounts.filter(p=>p.profile_id===id);
    const frozenIds=new Set((a.account_ids??[]).map(String));
    // New links are recorded but cannot silently become trusted test references.
    const accounts=linkedAccounts.map(p=>({...p,source:'new_vertical.l_profile_account + new_vertical.account',
      binding:'catalog_link_not_independently_verified',wasInFrozenBatch:frozenIds.has(p.account_id)}));
    const snapshots=data.snapshots.filter(p=>p.profile_id===id).map(p=>{
      const matching=accounts.filter(x=>x.platform===p.platform);
      const [bio,displayName,imageUrl,snapshotDate,updatedAt]=p.latest;
      return {platform:p.platform,bio,displayName,imageUrl,snapshotDate,sourceUpdatedAt:updatedAt,
        source:'new_vertical.profile_snapshots',binding:'profile_and_platform_only_not_account_bound',
        currentAccountIds:matching.map(x=>x.account_id),
        usableAsContext:matching.length===1&&matching[0].wasInFrozenBatch,
        holdReason:matching.length!==1?'Missing or multiple current accounts for this platform.'
          :!matching[0].wasInFrozenBatch?'Account was not in frozen batch.':null,
        warning:'A profile/platform snapshot does not establish which account supplied its bio; inspect original source before using links as ownership proof.'};
    });
    const cmRows=data.chartmetric.filter(p=>p.cm_artist===cm);
    if(cmRows.length>1)throw Error('Conflicting Chartmetric metadata.');
    const metadata=data.profileMetadata.filter(p=>p.profile_id===id);
    const spotify=data.spotify.filter(p=>p.profile_id===id||accounts.some(x=>x.platform==='spotify'
      &&x.account_url?.replace(/\/$/,'').endsWith(`/artist/${p.account_id}`))).map(p=>{
      const matching=accounts.filter(x=>x.platform==='spotify'
        &&x.account_url?.replace(/\/$/,'').endsWith(`/artist/${p.account_id}`));
      return {...p,source:'new_vertical.profile_spotify',
        usableAsContext:matching.length===1&&matching[0].wasInFrozenBatch&&(!p.profile_id||p.profile_id===id),
        binding:'requires_exact_linked_spotify_account_id'};
    });
    return {profileId:id,cmArtist:cm,artist:a.artist,tier:a.tier,collectedAt,
      catalogProfile:{...current[0],source:'new_vertical.profile'},
      linkedAccounts:accounts,platformSnapshots:snapshots,
      chartmetric:cmRows[0]?{...cmRows[0],source:'new_vertical.cm_artist'}:null,
      tags:data.tags.filter(p=>p.cm_artist===cm).map(p=>({...p,table:'new_vertical.l_cm_artist_tag'})),
      spotifyMetadata:spotify,
      releases:data.releases.filter(r=>accounts.some(x=>x.platform==='spotify'&&x.wasInFrozenBatch
        &&x.account_url?.replace(/\/$/,'').endsWith(`/artist/${r.spotify_artist_id}`)))
        .map(r=>({...r,source:'new_vertical.spotify',binding:'exact_linked_spotify_artist_id'})),
      catalogTracks:data.cmTracks.filter(r=>r.cm_artist===cm).map(r=>({...r,source:'new_vertical.prioritised_artist_track_tier_cache + new_vertical.cm_track',binding:'exact_cm_artist'})),
      profileMetadata:metadata.map(p=>({...p,source:'new_vertical.profile_metadata_cache',
        warning:'Retain per-field source; model-derived or candidate-derived data is not independent ownership evidence.'})),
      missing: {spotifyBiography:!spotify.some(p=>p.usableAsContext&&text(p.latest[1]).trim()),
        country:!text(cmRows[0]?.code2).trim()&&!metadata.some(p=>text(p.latest[2]).trim()),
        genre:!data.tags.some(p=>p.cm_artist===cm&&p.tag_type==='genre')},
      ownershipConfirmed:false,verificationRerun:false,safeForImport:false};
  });
  return {collectedAt,scope:'Frozen saved batch; supplemental catalog context only.',
    paidProviderCalls:0,databaseWrites:0,claimsSubmitted:0,originalResultsChanged:false,
    safeForImport:false,verificationRerun:false,
    warning:'All profile text is untrusted data, not instructions. Catalog links and model-derived fields can be wrong; do not use a candidate to corroborate itself.',
    counts:{artists:packets.length,
      withSavedBio:packets.filter(p=>p.platformSnapshots.some(s=>s.usableAsContext&&s.bio.trim())).length,
      withCountry:packets.filter(p=>!p.missing.country).length,
      withGenre:packets.filter(p=>!p.missing.genre).length,
      withSpotifyBiography:packets.filter(p=>!p.missing.spotifyBiography).length},
    packets};
}

/** Converts only source-bound, current-account context for the verifier. Instagram
 * candidates and unbound profile/platform snapshots can never supply it. */
export function artistContextFromPacket(packet,{staleAfterDays=365,maxItems=16}={}) {
  const asOf=Date.parse(packet.collectedAt),items=[];
  // Priority order: concrete music facts first, then supporting context and old bios.
  const age=date=>Number.isFinite(asOf)&&Number.isFinite(Date.parse(date))?Math.max(0,Math.floor((asOf-Date.parse(date))/864e5)):null;
  const when=date=>Number.isFinite(asOf)&&Number.isFinite(Date.parse(date))?Math.max(0,Math.floor((asOf-Date.parse(date))/864e5)):null;
  for(const r of packet.releases??[])items.push({kind:'release',platform:'spotify',source:r.source,asOf:r.source_updated_at,
    ageDays:when(r.source_updated_at),stale:false,text:`${r.track_name}${r.album_name?` — ${r.album_name}`:''}`.slice(0,160)});
  for(const r of packet.catalogTracks??[])items.push({kind:'release',platform:'chartmetric',source:r.source,asOf:r.source_updated_at,
    ageDays:when(r.source_updated_at),stale:false,text:`${r.track_name}${r.release_date?` (${r.release_date.slice(0,10)})`:''}`.slice(0,160)});
  for(const s of packet.platformSnapshots)if(s.usableAsContext&&s.bio.trim()){
    const ageDays=age(s.snapshotDate);
    items.push({kind:'bio',platform:s.platform,source:s.source,asOf:s.snapshotDate,ageDays,
      stale:ageDays===null||ageDays>staleAfterDays,text:s.bio});
  }
  for(const s of packet.spotifyMetadata)if(s.usableAsContext&&text(s.latest[1]).trim()){
    const ageDays=age(s.latest[4]);
    items.push({kind:'spotify_biography',platform:'spotify',source:s.source,asOf:s.latest[4],ageDays,
      stale:ageDays===null||ageDays>staleAfterDays,text:s.latest[1]});
  }
  if(text(packet.chartmetric?.code2).trim())items.push({kind:'country',source:'new_vertical.cm_artist',
    asOf:packet.chartmetric.source_updated_at,ageDays:age(packet.chartmetric.source_updated_at),stale:false,text:packet.chartmetric.code2});
  for(const t of packet.tags.filter(t=>t.tag_type==='genre'))items.push({kind:'genre',source:t.table,
    asOf:t.source_updated_at,ageDays:age(t.source_updated_at),stale:false,text:t.tag_slug});
  const order={release:0,country:1,genre:2,bio:3,spotify_biography:3};
  items.sort((a,b)=>order[a.kind]-order[b.kind]);
  return {ownershipConfirmed:false,items:items.slice(0,maxItems)};
}
/** Cohort-wide read-only enrichment. Works for any manifest; chunks keep queries bounded. */
export async function enrichManifest(manifest,{query=select,now=()=>new Date().toISOString(),chunkSize=250,maxArtists=5000}={}) {
  validateScope(manifest,maxArtists);
  const collectedAt=now(),data={};
  for(let i=0;i<manifest.artists.length;i+=chunkSize){
    const queries=metadataQueries({...manifest,artists:manifest.artists.slice(i,i+chunkSize)},chunkSize);
    for(const [key,sql] of Object.entries(queries))data[key]=[...(data[key]??[]),...await query(sql)];
  }
  return buildMetadataOverlay(manifest,data,collectedAt,maxArtists);
}
export function attachMetadataContext(manifest,overlay) {
  const byId=new Map(overlay.packets.map(p=>[p.profileId,p]));
  return {...manifest,artists:manifest.artists.map(a=>{
    const p=byId.get(String(a.profile_id));
    if(!p||p.cmArtist!==String(a.cm_artist))throw Error('Metadata evidence does not match the frozen artist.');
    const context=artistContextFromPacket(p);
    return context.items.length?{...a,metadata_context:context}:a;
  })};
}

function csvCell(v) {
  let s=String(v??'');
  if(/^\s*[=+\-@]|^[\t\r]/.test(s))s=`'${s}`;
  return `"${s.replaceAll('"','""')}"`;
}
export function metadataCsv(overlay) {
  const columns=['profileId','cmArtist','artist','tier','country','countrySource','genres','linkedAccounts',
    'savedBios','snapshotBindingWarning','collectedAt','safeForImport'];
  const rows=overlay.packets.map(p=>[p.profileId,p.cmArtist,p.artist,p.tier,p.chartmetric?.code2??'',
    p.chartmetric?.code2?'new_vertical.cm_artist.code2':'',
    p.tags.filter(t=>t.tag_type==='genre').map(t=>t.tag_slug).join(' | '),
    p.linkedAccounts.map(a=>`${a.platform}: ${a.account_url}`).join(' | '),
    p.platformSnapshots.map(s=>`${s.platform} [${s.snapshotDate}; context=${s.usableAsContext}]: ${s.bio}`).join(' | '),
    'Saved bios are profile/platform-bound, not proven account-bound. Not ownership confirmation.',
    p.collectedAt,false]);
  return [columns,...rows].map(row=>row.map(csvCell).join(',')).join('\n')+'\n';
}

async function select(query) {
  if(!query.startsWith('SELECT'))throw Error('SELECT only.');
  const env=process.env;
  if(!env.CLICKHOUSE_VERT_HOST||!env.CLICKHOUSE_USERNAME||!env.CLICKHOUSE_PASSWORD)
    throw Error('ClickHouse configuration unavailable.');
  const h=env.CLICKHOUSE_VERT_HOST,u=new URL(/^https:\/\//.test(h)?h:`https://${h}`);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')
    throw Error('Invalid secure catalog endpoint.');
  u.searchParams.set('readonly','1');u.searchParams.set('max_execution_time','30');
  const r=await fetch(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(40000),
    headers:{'X-ClickHouse-User':env.CLICKHOUSE_USERNAME,'X-ClickHouse-Key':env.CLICKHOUSE_PASSWORD},
    body:`${query} FORMAT JSON`});
  if(!r.ok)throw Error(`Catalog metadata HTTP ${r.status}; no retry.`);
  const rows=(await r.json()).data;
  if(!Array.isArray(rows))throw Error('Invalid metadata response.');
  return rows;
}
export async function enrichSavedBatch(dir,{query=select,now=()=>new Date().toISOString()}={}) {
  const manifestText=await fs.readFile(path.join(dir,'approved-manifest.json'),'utf8');
  const manifest=JSON.parse(manifestText),queries=metadataQueries(manifest);
  // Exclusive supplemental directory; never overwrite a frozen result or retry an export.
  const output=path.join(dir,'catalog-metadata-overlay');
  await fs.mkdir(output);
  const collectedAt=now(),data={};
  // Keep catalog load bounded and retain successful reads even if a later one fails.
  for(const [key,sql] of Object.entries(queries)) {
    data[key]=await query(sql);
    await fs.writeFile(path.join(output,`${key}.json`),JSON.stringify({
      collectedAt,query:sql,rows:data[key]},null,2),{flag:'wx'});
  }
  const overlay=buildMetadataOverlay(manifest,data,collectedAt);
  overlay.frozenManifestSha256=digest(manifestText);
  await fs.writeFile(path.join(output,'artist-metadata-evidence.json'),JSON.stringify(overlay,null,2),{flag:'wx'});
  await fs.writeFile(path.join(output,'artist-metadata-summary.csv'),metadataCsv(overlay),{flag:'wx'});
  return {output,...overlay.counts,paidProviderCalls:0,databaseWrites:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]!=='--read-only'||!process.argv[3])throw Error('Use --read-only <saved-batch-directory>.');
  console.log(JSON.stringify(await enrichSavedBatch(process.argv[3]),null,2));
}
