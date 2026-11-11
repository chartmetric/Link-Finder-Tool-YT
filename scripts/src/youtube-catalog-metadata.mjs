// New YouTube preparations only. Never upgrade a frozen Instagram packet.
import assert from 'node:assert/strict';
import {metadataQueries,validateScope} from './instagram-artist-metadata-overlay.mjs';

export function youtubeMetadataQueries(manifest,maxArtists=250){
  const queries=metadataQueries(manifest,maxArtists);
  for(const name of ['accounts','snapshots']){
    assert.ok(queries[name].includes("platform!='instagram'"));
    queries[name]=queries[name].replaceAll("platform!='instagram'","platform!='youtube'");
  }
  return queries;
}
export function bindYoutubeCatalogAccounts(manifest,rows){
  const artists=validateScope(manifest),byId=new Map(artists.map(a=>[String(a.profile_id),a]));
  const accepted=[];
  for(const row of rows){
    const artist=byId.get(String(row.profile_id));
    assert.ok(artist&&String(row.cm_artist)===String(artist.cm_artist),'Catalog account artist binding changed');
    assert.match(String(row.account_id),/^\d+$/);
    if(row.platform==='youtube'||row.is_active===0||row.is_active===false||row.disconnected_at)continue;
    assert.ok(!row.source||row.source==='new_vertical.l_profile_account + new_vertical.account',
      'Research candidates are not catalog account references');
    let url;try{url=new URL(row.account_url);}catch{continue;}
    if(url.protocol!=='https:'||url.username||url.password||url.port)continue;
    accepted.push({...row,profile_id:String(row.profile_id),cm_artist:String(row.cm_artist),account_id:String(row.account_id)});
  }
  return {...manifest,artists:artists.map(a=>{
    const accounts=accepted.filter(r=>r.profile_id===String(a.profile_id));
    return {...a,accounts,account_ids:[...new Set(accounts.map(r=>r.account_id))]};
  })};
}
