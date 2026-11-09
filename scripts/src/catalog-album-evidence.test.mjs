import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {albumCreditEvidence,albumQuery,createCatalogAlbumLookup} from './catalog-album-evidence.mjs';
import {resolveMusicEvidence,parsePublicMusicPage} from './public-music-links.mjs';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {hasCatalogCrossLink,assessInstagramCandidates} from './musician-instagram-matching.mjs';
import {runFixturePilot} from './instagram-pilot-runner.mjs';

const album='5mBygSc9qIZ1oTAnazLwmL',artist='430ft5iRke01tvX74xVM8Z';
const url=`https://open.spotify.com/album/${album}`;
const catalog={platform:'spotify',url:`https://open.spotify.com/artist/${artist}`};
const candidate={platform:'instagram',url:'https://www.instagram.com/billylildove/',
  displayName:'Billylildove',externalUrls:[url],directExternalUrls:[url]};
const reference={...catalog,displayName:'Billylildove',externalUrls:[]};
const facts=()=>({album_rows:[[album,'album',1,'2026-10-03 23:36:35']],
  artist_rows:[[album,artist,0,'2026-10-03 23:36:36']],checkedAt:'2026-11-09T12:00:00Z'});

test('exact album credits retain catalog provenance separately from ownership and public-page evidence',async()=>{
  const r=await resolveMusicEvidence({candidate,catalog,maxPages:0,
    readPage:async()=>{throw Error('No public request expected');},lookupAlbum:async()=>facts()});
  assert.equal(r.status,'exact_catalog_music_identity');
  assert.equal(r.ownershipConfirmed,false);assert.equal(r.pages.length,0);
  assert.equal(r.catalogAlbums[0].source,'catalog.l_spotify_album_spotify_artist');
  assert.equal(r.catalogAlbums[0].albumUrl,url);
  const enriched={...candidate,externalLinkEvidence:r,externalUrls:[url,...r.externalUrls]};
  assert.equal(hasCatalogCrossLink(reference,enriched,candidate.url,catalog),true);
  const request=jevRequest({artist:'Billylildove',catalogReference:catalog,profiles:[{
    url:candidate.url,identityComparison:{reference,candidate:enriched,status:'likely'}}]});
  const sent=request.state.candidates[0].candidate;
  assert.deepEqual(sent.externalUrls,[url]);
  assert.equal(sent.musicLinkPath.pages.length,0);
  assert.equal(sent.musicLinkPath.catalogAlbumLinks[0].source,'catalog.l_spotify_album_spotify_artist');
  assert.equal(sent.musicLinkPath.ownershipAssessment,'unassessed');
});

test('compilation, inactive, foreign, missing, malformed and multi-artist records never establish a match',()=>{
  const variants=[
    {...facts(),album_rows:[]},
    {...facts(),album_rows:[...facts().album_rows,...facts().album_rows]},
    {...facts(),album_rows:[null]},
    {...facts(),album_rows:[[album,'compilation',1,'date']]},
    {...facts(),album_rows:[[album,'album',0,'date']]},
    {...facts(),artist_rows:[]},
    {...facts(),artist_rows:[[album,artist,1,'date']]},
    {...facts(),artist_rows:[[album,artist,0,'date'],[album,'0123456789ABCDEFGHIJKL',0,'date']]},
    {...facts(),artist_rows:[['0123456789ABCDEFGHIJKL',artist,0,'date']]},
    {...facts(),artist_rows:[[album,'bad-id',0,'date']]},
    {...facts(),artist_rows:[[album,artist,0,null]]},
  ];
  for(const data of variants) assert.equal(albumCreditEvidence(url,data,catalog).status,'unresolved');
  assert.equal(albumCreditEvidence(url,facts(),{...catalog,url:'https://open.spotify.com/artist/0123456789ABCDEFGHIJKL'}).status,'unresolved');
  assert.throws(()=>albumQuery("x'; DROP TABLE x"),/Invalid/);
  assert.ok(!albumQuery(album).includes(`spotify_artist_id='${artist}'`));
  assert.match(albumQuery(album),/FINAL/);
});

test('catalog lookup is bound to a direct URL or preserved landing-page edge, not previously derived URLs',async()=>{
  let queried=0;
  const hub='https://theformat.lnk.to/boycottheaven';
  const r=await resolveMusicEvidence({candidate:{externalUrls:[hub]},catalog,maxPages:1,
    readPage:async u=>parsePublicMusicPage(u,`<a href="${url}">Spotify</a>`),
    lookupAlbum:async u=>{assert.equal(u,`https://open.spotify.com/embed/album/${album}`);queried++;return facts();}});
  assert.equal(queried,1);assert.equal(r.status,'exact_catalog_music_identity');
  assert.equal(r.catalogAlbums[0].linkedFrom,hub);
  const blocked=await resolveMusicEvidence({candidate:{externalUrls:[url],externalLinkEvidence:{}},catalog,
    readPage:async()=>{throw Error('Unexpected');},lookupAlbum:async()=>{throw Error('Unexpected');}});
  assert.equal(blocked.status,'unresolved');assert.equal(queried,1);
});

test('a conflicting lookup cannot fall through to a selected track; unavailable lookup is not account absence',async()=>{
  let pages=0;
  const r=await resolveMusicEvidence({candidate,catalog,
    readPage:async()=>{pages++;throw Error('Unexpected');},
    lookupAlbum:async()=>({...facts(),album_rows:[[album,'compilation',1,'date']]})});
  assert.equal(pages,0);assert.equal(r.status,'unresolved');
  const missing=await resolveMusicEvidence({candidate,catalog,maxPages:0,
    readPage:async()=>{throw Error('Unexpected');},lookupAlbum:async()=>{throw Error('Database unavailable');}});
  assert.equal(missing.status,'unresolved');assert.match(missing.catalogLookupErrors[0].reason,/no account-absence/);
});

test('technical album match still requires verified ownership at 0.90 and rejects related entities',()=>{
  const enriched={...candidate,externalUrls:[url,catalog.url]};
  const profile={url:candidate.url,title:'Billylildove',identityComparison:{reference,candidate:enriched,status:'likely'}};
  const player={artist:'Billylildove',profile_id:'1',account_ids:['2'],
    accounts:[{account_id:'2',profile_id:'1',platform:'spotify',account_url:catalog.url}]};
  const assess=(verdict,score,bio)=>assessInstagramCandidates({profiles:[{...profile,
    identityComparison:{...profile.identityComparison,candidate:{...enriched,bio}},
    jevVerification:{verdict,sameIdentityProbability:score}}],methodsUsed:[{method:'serper',status:'used'}]},player);
  assert.deepEqual(assess('likely',0.99).urls,[]);
  assert.deepEqual(assess('verified',0.89).urls,[]);
  assert.deepEqual(assess('verified',0.99,'Record label').urls,[]);
  assert.deepEqual(assess('verified',0.95).urls,[candidate.url]);
});

test('read-only adapter journals before HTTP, caches exact profile/album, and enforces scope/caps without secrets in files',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'album-catalog-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;
  const lookup=createCatalogAlbumLookup({profileIds:['1'],maxPerArtist:1,responseDir:dir,
    env:{CLICKHOUSE_VERT_HOST:'catalog.example.test',CLICKHOUSE_USERNAME:'test-user',CLICKHOUSE_PASSWORD:'test-secret'},
    fetchImpl:async(endpoint,options)=>{
      calls++;
      assert.equal(new URL(endpoint).searchParams.get('readonly'),'1');
      assert.match(options.body,/^SELECT/);
      assert.equal(options.redirect,'error');
      const saved=await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8');
      assert.equal(JSON.parse(saved.trim()).phase,'admitted');
      return Response.json({data:[facts()]});
    }});
  const [a,b]=await Promise.all([lookup({profileId:'1',url}),lookup({profileId:'1',url})]);
  assert.deepEqual(a,b);assert.equal(calls,1);
  await assert.rejects(lookup({profileId:'2',url}),/scope/);
  await assert.rejects(lookup({profileId:'1',url:'https://open.spotify.com/album/0123456789ABCDEFGHIJKL'}),/limit/);
  const saved=await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8');
  assert.ok(!saved.includes('test-secret')&&!saved.includes('test-user'));
  assert.deepEqual(saved.trim().split('\n').map(JSON.parse).map(r=>r.phase),['admitted','returned']);
});

test('uncertain database requests are not retried and unsafe album URLs never dispatch',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'album-catalog-failed-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;
  const lookup=createCatalogAlbumLookup({profileIds:['1'],responseDir:dir,
    env:{CLICKHOUSE_VERT_HOST:'catalog.example.test',CLICKHOUSE_USERNAME:'user',CLICKHOUSE_PASSWORD:'secret'},
    fetchImpl:async()=>{calls++;throw Error('Uncertain response with private provider text');}});
  await assert.rejects(lookup({profileId:'1',url:'https://evil.test/album/'+album}),/scope/);
  await assert.rejects(lookup({profileId:'1',url}),/no retry/);
  await assert.rejects(lookup({profileId:'1',url}),/no retry/);
  assert.equal(calls,1);
  const saved=await fs.readFile(path.join(dir,(await fs.readdir(dir))[0]),'utf8');
  assert.ok(!saved.includes('private provider text'));
  assert.match(saved,/failed_no_retry/);
});

test('pilot actually supplies catalog music evidence to the verifier without a public album read',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'album-pipeline-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let lookups=0,decisions=0;
  const manifest={run_allowed:false,artists:[{profile_id:'1',cm_artist:'3',artist:'Billylildove',
    bucket:'sample',source_identity_matches:true,catalog_profile:{profile_id:'1',cm_artist:'3',cm_source:'cm_artist'},
    reference_preflight:{readiness:'reference_usable'},account_ids:['2'],
    accounts:[{account_id:'2',platform:'spotify',account_url:catalog.url}]}],
    proposed_limits:{artist_workers:1,eligible_artists_before_prerequisite_fixes:1,
      serper_requests_total:1,serper_requests_per_artist:1,scrapecreators_requests_total:1,
      instagram_candidate_metadata_per_artist:1,reference_metadata_per_artist:0,
      jev_requests_total:1,jev_requests_per_artist:1,paid_http_requests_total:3,
      public_spotify_oembed_requests_total:1,public_official_or_linkhub_page_requests_total:1,
      public_http_requests_total:2,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      per_artist_wall_time_seconds:60,job_wall_time_minutes:1,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
  const result=await runFixturePilot({manifest,journalPath:path.join(dir,'paid-fixture.jsonl'),
    transport:{fixture:true,lookupAlbum:async input=>{
      lookups++;assert.equal(input.profileId,'1');assert.ok(input.deadlineAt>Date.now());return facts();
    },dispatch:async({kind,payload})=>{
      if(kind==='spotify_oembed')return reference;
      if(kind==='serper')return {profiles:[{url:candidate.url,title:'Billylildove'}],methodsUsed:[{method:'serper',status:'used'}]};
      if(kind==='scrapecreators_candidate')return structuredClone(candidate);
      if(kind==='jev') {
        decisions++;
        const p=payload.profiles[0];
        assert.equal(p.identityComparison.status,'likely');
        assert.equal(p.identityComparison.candidate.externalLinkEvidence.catalogAlbums[0].status,'exact_catalog_music_identity');
        return [{url:p.url,jevVerification:{verdict:'verified',sameIdentityProbability:0.95}}];
      }
      throw Error(`Unexpected network stage: ${kind}`);
    }}});
  // Assert outside transport: the runner intentionally catches provider errors.
  assert.equal(lookups,1);assert.equal(decisions,1);
  assert.deepEqual(result.results[0].urls,[candidate.url]);
  assert.equal(result.results[0].approvedCatalogLinks,false);
  assert.equal(result.claimsSubmitted,0);assert.equal(result.databaseWrites,0);
});
