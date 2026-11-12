// Future preparation only. Do not patch the Instagram helper or sealed workers.
import {createHash} from 'node:crypto';
import {metadataQueries,buildMetadataOverlay,select,validateScope} from './instagram-artist-metadata-overlay.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>String(a)===String(b);

export function targetPlatformMetadataQueries(manifest,{targetPlatform='instagram',maxArtists=250}={}){
  if(!['instagram','youtube'].includes(targetPlatform))throw Error('Unsupported catalog target platform.');
  const queries=metadataQueries(manifest,maxArtists);
  // Preserve existing Instagram SQL and behavior, including its exclusions.
  if(targetPlatform==='instagram')return queries;
  const ids=validateScope(manifest,maxArtists).map(a=>a.profile_id).join(',');
  return {...queries,
    accounts:`SELECT toString(l.profile_id) profile_id,toString(p.cm_source_id) cm_artist,
      toString(a.id) account_id,a.platform,a.account_url,a.handle,a.is_active,
      l.disconnected_at,toString(l.connected_at) connected_at,toString(a.modified_at) source_updated_at
      FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id,cm_source_id FROM new_vertical.profile FINAL
        WHERE id IN (${ids}) AND cm_source='cm_artist') p ON p.id=l.profile_id
      INNER JOIN (SELECT id,platform,account_url,handle,is_active,modified_at FROM new_vertical.account FINAL
        WHERE is_active=1 AND platform!='youtube') a ON a.id=l.account_id
      WHERE l.disconnected_at IS NULL AND l.profile_id IN (${ids})`,
    snapshots:`SELECT toString(profile_id) profile_id,platform,
      argMax(tuple(ifNull(bio,''),ifNull(display_name,''),ifNull(profile_pic_url,''),
        toString(snapshot_date),toString(updated_at)),tuple(snapshot_date,updated_at)) latest
      FROM new_vertical.profile_snapshots WHERE profile_id IN (${ids}) AND platform!='youtube'
      GROUP BY profile_id,platform`,
  };
}

function usableCatalogAccount(row,artists){
  if(!artists.some(a=>same(a.profile_id,row.profile_id)&&same(a.cm_artist,row.cm_artist))
    ||!/^\d+$/.test(String(row.account_id))||![1,'1',true].includes(row.is_active)
    ||row.disconnected_at!==null||typeof row.platform!=='string'||row.platform==='youtube')return false;
  try{
    const u=new URL(row.account_url);
    if(u.protocol!=='https:'||u.username||u.password||u.port)return false;
    if(row.platform==='instagram')return ['instagram.com','www.instagram.com'].includes(u.hostname)
      &&/^\/[\w.]+\/?$/.test(u.pathname)&&!u.search&&!u.hash;
    return true;
  }catch{return false;}
}

// Read catalog rows, then freeze only those rows as references for this NEW
// preparation. Supplied campaign accounts/candidates are never a reference pool.
// The injected query seam is for offline fixtures; the function is never startup work.
export async function collectTargetPlatformMetadata(manifest,{
  targetPlatform='instagram',query=select,now=()=>new Date().toISOString(),maxArtists=250,
}={}){
  validateScope(manifest,maxArtists);
  const observedAt=now();
  if(targetPlatform==='instagram'){
    const queries=targetPlatformMetadataQueries(manifest,{targetPlatform,maxArtists}),data={};
    for(const [name,sql] of Object.entries(queries))data[name]=await query(sql);
    return buildMetadataOverlay(manifest,data,observedAt,maxArtists);
  }
  // Clear caller-provided accounts before even constructing Spotify queries.
  const scope={artists:manifest.artists.map(a=>({...a,accounts:[],account_ids:[]}))};
  const accountSql=targetPlatformMetadataQueries(scope,{targetPlatform,maxArtists}).accounts;
  const rows=await query(accountSql);
  if(!Array.isArray(rows))throw Error('Invalid catalog accounts response.');
  const accounts=rows.filter(a=>usableCatalogAccount(a,scope.artists));
  for(const artist of scope.artists){
    artist.accounts=accounts.filter(a=>same(a.profile_id,artist.profile_id)&&same(a.cm_artist,artist.cm_artist));
    artist.account_ids=artist.accounts.map(a=>String(a.account_id));
  }
  const queries=targetPlatformMetadataQueries(scope,{targetPlatform,maxArtists}),data={accounts};
  for(const [name,sql] of Object.entries(queries))if(name!=='accounts')data[name]=await query(sql);
  const overlay=buildMetadataOverlay(scope,data,observedAt,maxArtists);
  for(const packet of overlay.packets){
    packet.targetPlatform=targetPlatform;
    packet.catalogCollection={observedAt,targetPlatform,queries,
      sourceModel:'new_vertical.profile.cm_source=cm_artist',
      warning:'Catalog observations only; no source-page capture or ownership verification.'};
    for(const a of packet.linkedAccounts){
      a.catalogReferenceProvenance={profileId:packet.profileId,cmArtist:packet.cmArtist,
        accountId:String(a.account_id),platform:a.platform,source:a.source,
        observedAt,querySha256:hash(accountSql),isActive:true,disconnectedAt:null,
        binding:'exact_active_catalog_link_not_independently_verified'};
    }
  }
  return overlay;
}
