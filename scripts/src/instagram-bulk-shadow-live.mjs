// Explicitly approved bounded workflow pilot, NOT a full rerun or import entry point.
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runPilot,pilotPreflight} from './instagram-pilot-runner.mjs';
import {createLiveTransport} from './instagram-pilot-live-transport.mjs';
import {createCatalogAlbumLookup} from './catalog-album-evidence.mjs';
import {catalogReferences} from './musician-instagram-matching.mjs';

const output='generated-artifacts/instagram-bulk-shadow-2026-11-09-approved-50';
const lockPath='generated-artifacts/instagram-original-pilot-budget.lock';
const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(p,value)=>fs.writeFile(p,JSON.stringify(value,null,2),{flag:'wx'});
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));

export async function reconcileReservations(root='generated-artifacts',ignoreFile){
  const entries=[];
  async function walk(dir){
    for(const f of await fs.readdir(dir,{withFileTypes:true})){
      const p=`${dir}/${f.name}`;
      if(f.isDirectory())await walk(p);
      else if(f.name.includes('admission')&&f.name.endsWith('.jsonl')&&p!==ignoreFile){
        const text=await fs.readFile(p,'utf8');
        const lines=text.trim()?text.trim().split('\n'):[];
        const admitted=[];
        for(const line of lines){
          let row;try{row=JSON.parse(line);}catch{throw Error('Unreadable admission history; paid launch blocked.');}
          if(row.phase==='admitted'&&row.reserveCents>0){
            if(!Number.isInteger(row.reserveCents)||!row.key)throw Error('Invalid paid reservation history.');
            admitted.push(row);
          }
        }
        if(admitted.length){
          const ids=[];
          let historicalScope;
          for(const row of admitted){
            let id=row.profileId??/^(?:benchmark-)?(\d+)(?:-[12])?$/.exec(row.key)?.[1];
            if(id===undefined){
              historicalScope??=await read(`${dir}/approved-scope.json`);
              id=historicalScope.cases?.find(c=>c.key===row.key)?.profileId;
            }
            if(!/^\d+$/.test(String(id)))throw Error('Historical reservation has no recoverable profile identity.');
            ids.push(String(id));
          }
          entries.push({file:p,reservedCents:admitted.reduce((s,r)=>s+r.reserveCents,0),
            sha256:hash(JSON.stringify(admitted)),profileIds:[...new Set(ids)]});
        }
      }
    }
  }
  await walk(root);entries.sort((a,b)=>a.file.localeCompare(b.file));
  return {entries,reservedCents:entries.reduce((s,e)=>s+e.reservedCents,0),fingerprint:hash(JSON.stringify(entries))};
}
async function select(query){
  if(!query.trim().startsWith('SELECT'))throw Error('Read-only SELECT required.');
  const host=process.env.CLICKHOUSE_VERT_HOST;
  if(!host||!process.env.CLICKHOUSE_USERNAME||!process.env.CLICKHOUSE_PASSWORD)throw Error('ClickHouse configuration unavailable.');
  const url=new URL(/^https?:/.test(host)?host:`https://${host}`);
  if(url.protocol!=='https:')throw Error('HTTPS ClickHouse required.');
  url.searchParams.set('max_execution_time','45');url.searchParams.set('output_format_json_quote_64bit_integers','1');
  const r=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(55000),
    headers:{'X-ClickHouse-User':process.env.CLICKHOUSE_USERNAME,'X-ClickHouse-Key':process.env.CLICKHOUSE_PASSWORD},
    body:`${query} FORMAT JSON`});
  if(!r.ok)throw Error(`Read-only cohort query HTTP ${r.status}; no retry.`);
  return(await r.json()).data;
}

export function buildShadowManifest(rows,accounts,snapshotAt,audit){
  if(!rows.length||rows.length>50||audit.reservedCents+500>1000)throw Error('Empty/oversized cohort or insufficient original budget.');
  const excluded=new Set(audit.entries.flatMap(e=>e.profileIds));
  const artists=rows.map(row=>{
    const a=accounts.filter(a=>String(a.profile_id)===String(row.profile_id));
    const artist={...row,profile_id:String(row.profile_id),cm_artist:String(row.cm_artist),tier:Number(row.tier),
      account_ids:[...new Set(a.map(a=>String(a.account_id)))],accounts:a,
      source_identity_matches:true,catalog_profile:{profile_id:String(row.profile_id),cm_artist:String(row.cm_artist),cm_source:'cm_artist'},
      reference_preflight:{readiness:'reference_usable'},bucket:'automatic_shadow_cohort'};
    if(excluded.has(artist.profile_id)||!artist.artist?.trim()||![1,2,3,4,5].includes(artist.tier)
      ||!catalogReferences(artist).some(r=>r.platform==='spotify')
      ||a.some(a=>a.platform==='instagram'))throw Error('Cohort identity/reference/history changed; no paid launch.');
    return artist;
  });
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:500,
    purpose:'One up-to-50-artist research-only workflow pilot, five workers; no imports or experimental acceptance.',
    priorReservedCents:audit.reservedCents,originalPilotCapCents:1000,snapshotAt,
    historicalReservationsFingerprint:audit.fingerprint},
    artists,proposed_limits:{artist_workers:5,eligible_artists_before_prerequisite_fixes:artists.length,
      serper_requests_total:artists.length*2,serper_requests_per_artist:2,
      scrapecreators_requests_total:artists.length*2,instagram_candidate_metadata_per_artist:2,reference_metadata_per_artist:0,
      jev_requests_total:artists.length,jev_requests_per_artist:1,paid_http_requests_total:artists.length*5,
      public_spotify_oembed_requests_total:artists.length,public_official_or_linkhub_page_requests_total:artists.length*2,
      public_music_page_requests_per_artist:2,public_http_requests_total:artists.length*3,
      global_concurrent_provider_requests:5,per_request_timeout_seconds:25,per_artist_wall_time_seconds:180,
      job_wall_time_minutes:15,jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000},
    selection:{method:'Current global tiers; deterministic profile hash; up to ten per tier; linked Spotify, no catalog Instagram, no uncertain saved discovery or prior pilot admission.',
      experimentalAcceptanceEnabled:false,claimsAllowed:false,fullTierRerun:false}};
  pilotPreflight(manifest);return manifest;
}

async function prepare(){
  const audit=await reconcileReservations();
  if(audit.reservedCents+500>1000)throw Error('Original pilot budget cannot accommodate the approved cap.');
  const excluded=[...new Set(audit.entries.flatMap(e=>e.profileIds))];
  if(excluded.some(id=>!/^\d+$/.test(id)))throw Error('Invalid historical profile identity.');
  const [snapshot]=await select(`SELECT toString(max(computed_at)) snapshot_at,
    dateDiff('second',max(computed_at),now()) age_seconds FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type='musician' AND grain='global'`);
  if(!snapshot||Number(snapshot.age_seconds)<0||Number(snapshot.age_seconds)>36*3600
    ||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(snapshot.snapshot_at))throw Error('Missing or stale global tier snapshot.');
  const query=`SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,p.name artist,t.tier,t.tier_rank
    FROM (SELECT profile,tier,min(tier_rank) tier_rank FROM new_vertical.l_profile_tier FINAL
      WHERE profile_type='musician' AND grain='global' AND tier BETWEEN 1 AND 5
      AND computed_at=toDateTime('${snapshot.snapshot_at}','UTC') GROUP BY profile,tier) t
    INNER JOIN (SELECT id,cm_source_id,name FROM new_vertical.profile FINAL
      WHERE cm_source='cm_artist' AND cm_source_id IS NOT NULL AND name!='') p ON p.id=t.profile
    WHERE p.id IN (SELECT l.profile_id FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id FROM new_vertical.account FINAL WHERE platform='spotify' AND is_active=1
        AND account_url LIKE 'https://open.spotify.com/artist/%') a ON a.id=l.account_id WHERE l.disconnected_at IS NULL)
    AND p.id NOT IN (SELECT l.profile_id FROM new_vertical.l_profile_account AS l FINAL
      INNER JOIN (SELECT id FROM new_vertical.account FINAL WHERE platform='instagram') a ON a.id=l.account_id)
    AND p.id NOT IN (SELECT profile_id FROM poc_new_verticals.musician_instagram_discovery_events
      GROUP BY profile_id HAVING argMax(status,updated_at) NOT IN ('candidates_found','no_candidates'))
    ${excluded.length?`AND p.id NOT IN (${excluded.join(',')})`:''}
    ORDER BY tier,cityHash64(toString(p.id)) LIMIT 10 BY tier`;
  const rows=await select(query);
  if(!rows.length||rows.some(r=>!/^\d+$/.test(String(r.profile_id))))throw Error('No valid eligible cohort.');
  const accounts=await select(`SELECT toString(l.profile_id) profile_id,toString(l.account_id) account_id,
    a.platform,a.account_url FROM new_vertical.l_profile_account AS l FINAL
    INNER JOIN (SELECT id,platform,account_url FROM new_vertical.account FINAL WHERE is_active=1) a ON a.id=l.account_id
    WHERE l.disconnected_at IS NULL AND l.profile_id IN (${rows.map(r=>r.profile_id).join(',')})`);
  const manifest=buildShadowManifest(rows,accounts,snapshot.snapshot_at,audit);
  await fs.mkdir(output,{recursive:false});
  await save(`${output}/reservation-reconciliation.json`,audit);
  await save(`${output}/approved-manifest.json`,manifest);
  await save(`${output}/manifest-receipt.json`,{sha256:hash(JSON.stringify(manifest))});
  await save(`${output}/preflight.json`,pilotPreflight(manifest));
  console.log(JSON.stringify({prepared:true,artists:rows.length,
    tiers:Object.fromEntries([1,2,3,4,5].map(t=>[t,rows.filter(r=>Number(r.tier)===t).length])),
    priorReservedUsd:audit.reservedCents/100,approvedCapUsd:5,remainingOriginalAfterMaxAllocationUsd:(500-audit.reservedCents)/100,
    output,paidCalls:0}));
}
async function run(){
  const manifest=await read(`${output}/approved-manifest.json`),audit=await read(`${output}/reservation-reconciliation.json`);
  // Older prepared packets remain unchanged; the receipt is mandatory for dispatch.
  const receipt=await read(`${output}/manifest-receipt.json`);
  if(hash(JSON.stringify(manifest))!==receipt.sha256)throw Error('Frozen manifest changed; no paid launch.');
  if((await reconcileReservations()).fingerprint!==audit.fingerprint)throw Error('Reservation history changed; no paid launch.');
  if(manifest.authorization?.maxSpendCents!==500||manifest.artists.length>50
    ||manifest.artists.some(a=>a.bucket!=='automatic_shadow_cohort'))throw Error('Unexpected approved scope.');
  const keys=Object.fromEntries(['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'].map(k=>{
    if(!process.env[k])throw Error(`Missing secret: ${k}`);return[k,process.env[k]];
  }));
  const lock=await fs.open(lockPath,'wx');
  let journal;
  try{
    await lock.writeFile(JSON.stringify({output,priorReservedCents:audit.reservedCents,maxAdditionalCents:500,
      originalCapCents:1000,at:new Date().toISOString()}));await lock.sync();
    await fs.mkdir(`${output}/responses`);
    journal=await fs.open(`${output}/results.jsonl`,'wx');
    const base=createLiveTransport({keys,responseDir:`${output}/responses`,
      catalogAlbumLookup:createCatalogAlbumLookup({profileIds:manifest.artists.map(a=>a.profile_id),responseDir:`${output}/responses`})});
    const transport={...base,dispatch:async request=>{
      const current=await reconcileReservations('generated-artifacts',`${output}/admissions.jsonl`);
      if(current.fingerprint!==audit.fingerprint)throw Object.assign(Error('Other paid experiment changed the shared reservation history; batch fenced.'),{fatalProvider:true});
      return base.dispatch(request);
    }};
    const summary=await runPilot({manifest,mode:'live',journalPath:`${output}/admissions.jsonl`,transport,
      onResult:async r=>{await journal.write(JSON.stringify(r)+'\n');await journal.sync();
        console.log(JSON.stringify({profileId:r.profileId,status:r.status,supportedUrls:r.urls?.length??0,reason:r.reason??null}));}});
    await save(`${output}/summary.json`,{...summary,finishedAt:new Date().toISOString(),
      purpose:'bounded_workflow_shadow_pilot',fullTierRerunStarted:false,experimentalAcceptanceEnabled:false,
      productionApproved:false,safeForImport:false,claimsSubmitted:0,databaseWrites:0,
      priorReservedCents:audit.reservedCents,cumulativeReservedUsd:(audit.reservedCents+summary.budget.reservedSpendCents)/100});
    console.log(JSON.stringify({finished:true,completed:summary.results.length,reservedUsd:summary.budget.reservedSpendCents/100,
      stopped:summary.budget.stopped,output}));
  }finally{if(journal)await journal.close();await lock.close();await fs.unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--prepare')await prepare();
  else if(process.argv[2]==='--run-approved')await run();
  else throw Error('Use --prepare once, then --run-approved once. Never resume paid admissions.');
}
