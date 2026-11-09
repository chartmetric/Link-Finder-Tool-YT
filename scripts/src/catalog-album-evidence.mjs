import fs from 'node:fs/promises';

const source='catalog.l_spotify_album_spotify_artist';
const id=/^[A-Za-z0-9]{22}$/;
function spotifyAlbum(value) {
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.hostname!=='open.spotify.com'||u.username||u.password||u.port) return null;
    const match=/^\/(?:(?:intl-[a-z]{2}|embed)\/)?album\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname);
    return match?{id:match[1],url:`https://open.spotify.com/album/${match[1]}`}:null;
  }catch{return null;}
}

/** Exact catalog data is music evidence, never an Instagram ownership verdict. */
export function albumCreditEvidence(albumUrl,data,catalog) {
  const album=spotifyAlbum(albumUrl);
  if(!album) throw Error('A source-linked Spotify album is required.');
  const base={source,albumUrl:album.url,albumId:album.id,checkedAt:data.checkedAt,
    albumRows:data.album_rows,artistRows:data.artist_rows,
    status:'unresolved',externalUrls:[],ownershipConfirmed:false};
  const unresolved=reason=>({...base,reason});
  if(!Array.isArray(data.album_rows)||!Array.isArray(data.artist_rows)) return unresolved('Missing catalog album evidence.');
  if(data.album_rows.length!==1) return unresolved('Missing or conflicting catalog album record.');
  if(!Array.isArray(data.album_rows[0])) return unresolved('Malformed catalog album record.');
  const [albumId,albumType,active,updatedAt]=data.album_rows[0];
  if(albumId!==album.id||active!==1||!['album','single'].includes(albumType)||typeof updatedAt!=='string'||!updatedAt) {
    return unresolved('Inactive, compilation, conflicting or incomplete album record.');
  }
  if(data.artist_rows.some(row=>!Array.isArray(row)||row[0]!==album.id||!id.test(row[1])
    ||![0,1].includes(row[2])||typeof row[3]!=='string'||!row[3])) {
    return unresolved('Malformed or foreign catalog artist relationship.');
  }
  const activeRows=data.artist_rows.filter(row=>row[2]===0);
  const artists=[...new Set(activeRows.map(row=>row[1]))];
  if(artists.length!==1) return unresolved('Missing or multiple active album artists.');
  const artistUrl=`https://open.spotify.com/artist/${artists[0]}`;
  if(catalog.platform!=='spotify'||artistUrl!==catalog.url) return unresolved('Album artist differs from the target catalog artist.');
  return {...base,status:'exact_catalog_music_identity',externalUrls:[artistUrl],
    albumType,albumUpdatedAt:updatedAt,relationshipUpdatedAt:activeRows.map(row=>row[3])};
}

export function albumQuery(albumId) {
  if(!id.test(albumId)) throw Error('Invalid album ID.');
  // Never select the expected artist here: all current relationships must be
  // considered so another artist/compilation cannot be filtered away.
  return `SELECT
    (SELECT groupArray(tuple(spotify_album_id,album_type,active,toString(updated_at)))
      FROM catalog.spotify_album FINAL WHERE spotify_album_id='${albumId}') AS album_rows,
    (SELECT groupArray(tuple(spotify_album_id,spotify_artist_id,is_deleted,toString(updated_at)))
      FROM catalog.l_spotify_album_spotify_artist FINAL WHERE spotify_album_id='${albumId}') AS artist_rows`;
}

/** Bounded, separately journaled SELECTs. Only explicit live entrypoints enable
 * this; importing modules and all ordinary fixture runs remain zero-network. */
export function createCatalogAlbumLookup({profileIds,responseDir,env=process.env,fetchImpl=fetch,
  maxPerArtist=4,maxTotal=profileIds.length*maxPerArtist}) {
  if(!Number.isInteger(maxPerArtist)||maxPerArtist<1||maxPerArtist>4
    ||!Number.isInteger(maxTotal)||maxTotal<1||maxTotal>profileIds.length*maxPerArtist) throw Error('Invalid catalog lookup limits.');
  const allowed=new Set(profileIds.map(String)),counts=new Map(),cache=new Map();
  let total=0,serial=Promise.resolve();
  return async ({profileId,url,deadlineAt=Infinity})=>{
    profileId=String(profileId);
    const album=spotifyAlbum(url);
    if(!allowed.has(profileId)||!album) throw Error('Catalog lookup outside approved profile/album scope.');
    if(!env.CLICKHOUSE_VERT_HOST||!env.CLICKHOUSE_USERNAME||!env.CLICKHOUSE_PASSWORD) throw Error('Catalog lookup configuration unavailable.');
    const key=`${profileId}:${album.id}`;
    if(cache.has(key)) return structuredClone(await cache.get(key));
    if(total>=maxTotal||(counts.get(profileId)??0)>=maxPerArtist) throw Error('Catalog album lookup limit reached.');
    const number=++total;
    counts.set(profileId,(counts.get(profileId)??0)+1);
    const task=serial.then(async()=>{
      const timeout=Math.min(15000,deadlineAt-Date.now());
      if(timeout<=0) throw Error('Catalog lookup deadline expired.');
      const sql=albumQuery(album.id);
      const endpoint=new URL(/^https:\/\//.test(env.CLICKHOUSE_VERT_HOST)
        ?env.CLICKHOUSE_VERT_HOST:`https://${env.CLICKHOUSE_VERT_HOST}`);
      if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash
        ||endpoint.pathname!=='/') throw Error('Invalid secure catalog endpoint.');
      endpoint.searchParams.set('readonly','1');
      endpoint.searchParams.set('max_execution_time','10');
      const file=`${responseDir}/catalog-album-${profileId}-${number}.jsonl`;
      const journal=await fs.open(file,'wx');
      // Each exclusive file contains a fsynced admission before its query.
      try {
        await journal.write(JSON.stringify({phase:'admitted',profileId,albumId:album.id,query:sql,
          source,at:new Date().toISOString()})+'\n');await journal.sync();
        try {
          const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',
            signal:AbortSignal.timeout(timeout),
            headers:{'X-ClickHouse-User':env.CLICKHOUSE_USERNAME,'X-ClickHouse-Key':env.CLICKHOUSE_PASSWORD},
            body:`${sql} FORMAT JSON`});
          if(!response.ok) throw Error(`Catalog lookup HTTP ${response.status}; no retry.`);
          const chunks=[];let bytes=0;
          if(response.body) for await(const chunk of response.body) {
            bytes+=chunk.length;
            if(bytes>1000000) throw Error('Catalog lookup evidence exceeds size limit.');
            chunks.push(chunk);
          }
          const rows=JSON.parse(Buffer.concat(chunks).toString('utf8')).data;
          if(!Array.isArray(rows)||rows.length!==1) throw Error('Incomplete catalog lookup response.');
          const result={...rows[0],checkedAt:new Date().toISOString()};
          await journal.write(JSON.stringify({phase:'returned',result})+'\n');await journal.sync();
          return result;
        }catch(error) {
          // Never persist provider exception bodies, URLs or credentials.
          await journal.write(JSON.stringify({phase:'failed_no_retry'})+'\n');await journal.sync();
          throw Error('Catalog lookup failed; identity remains unresolved and no retry was made.');
        }
      }finally{await journal.close();}
    });
    cache.set(key,task);
    serial=task.catch(()=>{});
    return structuredClone(await task);
  };
}
