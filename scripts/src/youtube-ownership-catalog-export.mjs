// Explicit read-only catalog export, separate from the network-free assembler.
// No source/provider fetch, campaign coordinator, model, discovery or writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {spotifyId,assertYoutubeCatalogBinding} from './youtube-ownership-evidence.mjs';

export async function exportYoutubeCatalogEvidence(source,output,{query=select,now=()=>new Date().toISOString()}={}){
  const files=(await fs.readdir(source+'/metadata')).filter(f=>/^\d+\.json$/.test(f)).sort();
  const packets=await Promise.all(files.map(async f=>JSON.parse(await fs.readFile(source+'/metadata/'+f,'utf8'))));
  const accounts=packets.flatMap(p=>{
    assertYoutubeCatalogBinding({profileId:p.profileId,cmArtist:p.cmArtist},p);
    return p.linkedAccounts.filter(a=>String(a.profile_id)===p.profileId&&String(a.cm_artist)===p.cmArtist&&a.wasInFrozenBatch);
  });
  const ids=[...new Set(accounts.map(a=>String(a.account_id)))];
  if(!ids.length||ids.some(id=>!/^\d+$/.test(id)))throw Error('Invalid catalog account IDs.');
  const spotify=[...new Set(accounts.filter(a=>a.platform==='spotify').map(a=>spotifyId(a.account_url)).filter(Boolean))];
  const cms=packets.map(p=>String(p.cmArtist));
  if(cms.some(id=>!/^\d+$/.test(id)))throw Error('Invalid catalog artist IDs.');
  const queries={
    accountSnapshots:`SELECT toString(account_id) account_id,platform,
      argMax(tuple(ifNull(bio,''),toString(snapshot_date),toString(modified_at)),tuple(snapshot_date,modified_at,id)) latest
      FROM new_vertical.account_snapshots WHERE account_id IN (${ids.join(',')}) GROUP BY account_id,platform`,
    releases:`SELECT spotify_artist_id,spotify_track_id,spotify_album_id,isrc,track_name,album_name,
      toString(updated_at) source_updated_at FROM new_vertical.spotify
      WHERE spotify_artist_id IN (${spotify.length?spotify.map(id=>"'"+id+"'").join(','):"''"})
      ORDER BY spotify_artist_id,popularity_score DESC,updated_at DESC LIMIT 10 BY spotify_artist_id`,
    catalogTracks:`SELECT toString(c.cm_artist) cm_artist,toString(c.cm_track) cm_track,t.name track_name,t.isrc,
      toString(c.release_date) release_date,toString(c.synced_at) source_updated_at
      FROM (SELECT cm_artist,cm_track,max(release_date) release_date,max(synced_at) synced_at,min(track_rank) rank
        FROM new_vertical.prioritised_artist_track_tier_cache WHERE cm_artist IN (${cms.join(',')})
        GROUP BY cm_artist,cm_track ORDER BY cm_artist,rank LIMIT 10 BY cm_artist) c
      INNER JOIN (SELECT id,name,isrc FROM new_vertical.cm_track FINAL WHERE id IN
        (SELECT cm_track FROM new_vertical.prioritised_artist_track_tier_cache WHERE cm_artist IN (${cms.join(',')}))) t ON t.id=c.cm_track`,
  };
  await fs.mkdir(output,{recursive:false});
  const observedAt=now(),data={};
  for(const [name,sql] of Object.entries(queries)){
    data[name]=await query(sql);
    await fs.writeFile(output+'/'+name+'.json',JSON.stringify({sql,observedAt,rows:data[name]}),{flag:'wx'});
  }
  const enriched=packets.map(p=>({...p,collectedAt:observedAt,baselineCatalogPacketSha256:evidenceDigest(p),
    accountSnapshots:data.accountSnapshots.filter(r=>p.linkedAccounts.some(a=>String(a.account_id)===r.account_id&&a.platform===r.platform))
      .map(r=>({...r,bio:r.latest[0],snapshot_date:r.latest[1],source_updated_at:r.latest[2]})),
    releases:data.releases.filter(r=>p.linkedAccounts.some(a=>a.platform==='spotify'&&spotifyId(a.account_url)===r.spotify_artist_id))
      .map(r=>({...r,source:'new_vertical.spotify',binding:'exact_linked_spotify_artist_id'})),
    catalogTracks:data.catalogTracks.filter(r=>r.cm_artist===p.cmArtist)
      .map(r=>({...r,source:'new_vertical.prioritised_artist_track_tier_cache + new_vertical.cm_track',binding:'exact_cm_artist'})),
  }));
  await fs.writeFile(output+'/packets.json',JSON.stringify(enriched),{flag:'wx'});
  return {artists:packets.length,observedAt,queryCount:3,providerRequests:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==5||process.argv[2]!=='--read-only')throw Error('Use --read-only SOURCE OUTPUT; no paid actions supported.');
  console.log(JSON.stringify(await exportYoutubeCatalogEvidence(process.argv[3],process.argv[4])));
}
