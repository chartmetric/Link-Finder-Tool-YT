import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {parsePublicMusicPage,resolveMusicEvidence,spotifyContent,musicPageUrl} from './public-music-links.mjs';
import {safeMusicFetch,isPublicIPv4} from './safe-music-fetch.mjs';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {createLiveTransport} from './instagram-pilot-live-transport.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {runFixturePilot} from './instagram-pilot-runner.mjs';

const artistId='6rjRx8doaSSBvE6J4tvWL2', albumId='5HOITZP5g8fq6JtgrTGldD', trackId='1sC5Sp886joVK8lFVo2zlX';
const catalog={platform:'spotify',url:`https://open.spotify.com/artist/${artistId}`};
const hubUrl='https://onerpm.link/YahWehFrankellyBello';
const ig='https://www.instagram.com/frankellybello_/';
const embed=(type,id,fields={})=>`<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({
  props:{pageProps:{state:{data:{entity:{type,id,uri:`spotify:${type}:${id}`,...fields}},
    settings:{session:{accessToken:'fixture-do-not-retain'}}}}}})}</script>`;
const button=dest=>`<a service="spotify" href="https://api.ffm.to/sl/e/c/yahwehfrankellybello?cd=${
  Buffer.from(JSON.stringify({destUrl:dest,unrelated:'ignore'})).toString('base64')}">Play</a>`;
const pages={
  [hubUrl]:button(`https://open.spotify.com/album/${albumId}?si=discard-tracking`),
  [`https://open.spotify.com/embed/album/${albumId}`]:embed('album',albumId,{trackList:[{uri:`spotify:track:${trackId}`}]}),
  [`https://open.spotify.com/embed/track/${trackId}`]:embed('track',trackId,{artists:[{name:'Frankelly Bello',uri:`spotify:artist:${artistId}`}]}),
};
async function temp(t) {
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'music-evidence-'));
  t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;
}
function manifest() {
  return {run_allowed:false,artists:[{profile_id:'1',cm_artist:'2',artist:'Frankelly Bello',bucket:'regression',
    source_identity_matches:true,catalog_profile:{profile_id:'1',cm_artist:'2',cm_source:'cm_artist'},
    reference_preflight:{readiness:'reference_usable'},account_ids:['3'],
    accounts:[{account_id:'3',platform:'spotify',account_url:catalog.url}]}],
    proposed_limits:{artist_workers:1,global_concurrent_provider_requests:5,eligible_artists_before_prerequisite_fixes:1,
      serper_requests_per_artist:2,serper_requests_total:2,instagram_candidate_metadata_per_artist:3,
      reference_metadata_per_artist:1,scrapecreators_requests_total:3,jev_requests_per_artist:1,jev_requests_total:1,
      paid_http_requests_total:6,public_spotify_oembed_requests_total:1,
      public_official_or_linkhub_page_requests_total:4,public_music_page_requests_per_artist:4,
      public_http_requests_total:5,per_request_timeout_seconds:20,per_artist_wall_time_seconds:120,
      job_wall_time_minutes:30,jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
}

test('OneRPM Spotify button resolves single-track album to exact credited artist without click tracking or JS',async()=>{
  const visited=[];
  const result=await resolveMusicEvidence({candidate:{externalUrls:[hubUrl]},catalog,readPage:async url=>{
    visited.push(url);assert.ok(pages[url]);return parsePublicMusicPage(url,pages[url]);
  }});
  assert.equal(result.status,'exact_catalog_music_identity');
  assert.deepEqual(result.externalUrls,[catalog.url]);
  assert.equal(result.ownershipConfirmed,false);
  assert.equal(visited.length,3);
  assert.ok(visited.every(url=>!url.includes('api.ffm.to')));
  assert.ok(!JSON.stringify(result).includes('fixture-do-not-retain'));
});

test('Spotify credits bind exact content IDs; names, recommendations and foreign session data do not count',()=>{
  const url=`https://open.spotify.com/embed/track/${trackId}`;
  const fake=embed('track',albumId,{artists:[{uri:`spotify:artist:${artistId}`}]});
  assert.deepEqual(parsePublicMusicPage(url,fake).externalUrls,[]);
  const nameOnly=embed('track',trackId,{name:'Frankelly Bello',recommendations:[{uri:`spotify:artist:${artistId}`}]});
  assert.deepEqual(parsePublicMusicPage(url,nameOnly).externalUrls,[]);
  assert.equal(spotifyContent(`${catalog.url}x`),null);
  assert.equal(spotifyContent(`https://open.spotify.com.evil.test/artist/${artistId}`),null);
});

test('different artist, multi-artist credits, multi-track albums and page budgets remain unresolved',async()=>{
  const other='0123456789ABCDEFGHIJKL';
  for(const artists of [[{uri:`spotify:artist:${other}`}],[{uri:`spotify:artist:${artistId}`},{uri:`spotify:artist:${other}`}]]) {
    const data={...pages,[`https://open.spotify.com/embed/track/${trackId}`]:embed('track',trackId,{artists})};
    const r=await resolveMusicEvidence({candidate:{externalUrls:[hubUrl]},catalog,
      readPage:async u=>parsePublicMusicPage(u,data[u])});
    assert.equal(r.status,'unresolved');assert.deepEqual(r.externalUrls,[]);
  }
  const album=parsePublicMusicPage(`https://open.spotify.com/embed/album/${albumId}`,
    embed('album',albumId,{trackList:[{uri:`spotify:track:${trackId}`},{uri:`spotify:track:${trackId}`}]}));
  assert.deepEqual(album.musicTargets,[]);
  let reads=0;
  const limited=await resolveMusicEvidence({candidate:{externalUrls:[hubUrl]},catalog,maxPages:1,
    readPage:async u=>{reads++;return parsePublicMusicPage(u,pages[u]);}});
  assert.equal(reads,1);assert.match(limited.reason,/limit/);
  const failed=await resolveMusicEvidence({candidate:{externalUrls:[hubUrl]},catalog,
    readPage:async u=>{if(u!==hubUrl)throw new Error('Existing one-page budget reached');return parsePublicMusicPage(u,pages[u]);}});
  assert.equal(failed.pages.length,1);assert.match(failed.reason,/budget/);
});

test('unsafe URLs, wrappers and redirects are rejected without fetching arbitrary destinations',()=>{
  for(const url of ['http://onerpm.link/x','https://onerpm.link.evil.test/x','https://127.0.0.1/x',
    'https://user:pass@onerpm.link/x','https://onerpm.link/x?next=http://localhost','https://onerpm.link:444/x']) {
    assert.equal(musicPageUrl(url),null);
  }
  assert.deepEqual(parsePublicMusicPage(hubUrl,button('http://127.0.0.1/private')).musicTargets,[]);
  assert.throws(()=>parsePublicMusicPage(hubUrl,'',{status:302,location:'https://127.0.0.1/'}),/Unsafe/);
  assert.equal(parsePublicMusicPage(hubUrl,'',{status:302,location:`https://open.spotify.com/album/${albumId}`}).redirectUrl,
    `https://open.spotify.com/embed/album/${albumId}`);
});

test('public client denies private/metadata DNS addresses and pins resolved socket address',async()=>{
  for(const a of ['127.0.0.1','169.254.169.254','10.0.0.1','172.16.0.1','192.168.0.1','100.64.0.1',
    '0.0.0.0','224.1.1.1','198.18.0.1','::1','::ffff:127.0.0.1']) assert.equal(isPublicIPv4(a),false,a);
  let requests=0;
  await assert.rejects(safeMusicFetch(hubUrl,{lookup:async()=>[{address:'127.0.0.1',family:4}],
    request:()=>{requests++;}}),/public IPv4/);
  assert.equal(requests,0);
  const response=await safeMusicFetch(hubUrl,{lookup:async()=>[{address:'93.184.216.34',family:4}],
    request:(url,options,callback)=>{
      requests++;assert.equal(url.hostname,'onerpm.link');assert.equal(options.servername,'onerpm.link');
      assert.equal(options.agent,false);assert.equal(options.headers.Authorization,undefined);
      options.lookup(url.hostname,{all:true},(err,records)=>{
        assert.equal(err,null);assert.deepEqual(records,[{address:'93.184.216.34',family:4}]);
      });
      const request=new EventEmitter();
      request.end=()=>{const body=Readable.from(['<a>no redirect followed</a>']);
        body.statusCode=302;body.headers={location:'https://127.0.0.1/','set-cookie':['private']};callback(body);};
      return request;
    }});
  assert.equal(response.status,302);assert.equal(response.headers.has('set-cookie'),false);
  assert.equal(requests,1);
});

test('public transport admits only one fetch and persists selected evidence, not embedded sessions',async t=>{
  const dir=await temp(t);let paid=0,publicCalls=0;
  const transport=createLiveTransport({keys:{SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'},
    responseDir:dir,fetchImpl:async()=>{paid++;throw new Error('No paid requests');},
    publicFetchImpl:async(url,options)=>{publicCalls++;assert.equal(options.redirect,'manual');
      return new Response(pages[url],{status:200});}});
  const data=await transport.dispatch({profileId:'1',key:'public-one',kind:'public_page',
    payload:{url:`https://open.spotify.com/embed/track/${trackId}`}});
  assert.equal(paid,0);assert.equal(publicCalls,1);assert.deepEqual(data.externalUrls,[catalog.url]);
  const saved=await fs.readFile(path.join(dir,'public-one.json'),'utf8');
  assert.ok(!saved.includes('fixture-do-not-retain'));assert.ok(!saved.includes('accessToken'));
});

test('Shenge account is recovered independently from a saved post mention; fan/owner clues stay unverified',()=>{
  const hits=[
    {link:'https://www.instagram.com/p/DfLummhCCOj/',title:'Shenge performs tonight',
      snippet:'1 likes, 0 comments - musas_shisanyama on October 31, 2026: Shenge'},
    {link:'https://www.instagram.com/popular/shenge-wasehlalankosi-videos/',title:'Shenge videos'},
    {link:'https://www.instagram.com/p/DfPu-uNDSQC/',title:'@shenge_wasehlalankosi thank you for the visit, we really ...'},
  ];
  const result=instagramSearchCandidates(hits,'Shenge wasehlalankosi');
  assert.equal(result[0].url,'https://www.instagram.com/shenge_wasehlalankosi/');
  assert.equal(result[0].discoveryEvidence[0].kind,'post_mention');
  assert.equal(result[0].discoveryEvidence[0].ownershipConfirmed,false);
  assert.ok(result.some(r=>r.url==='https://www.instagram.com/musas_shisanyama/'));
  assert.ok(!result.some(r=>r.url.includes('/popular/')));
  assert.deepEqual(instagramSearchCandidates([{link:hits[0].link,title:'Shenge wasehlalankosi with no handle'}],'Shenge wasehlalankosi'),[]);
  assert.deepEqual(instagramSearchCandidates([{link:'https://evil.test/p/x/',title:'@shenge_wasehlalankosi'}],'Shenge'),[]);
});

test('fixture runner keeps clues from both searches and verifies music chain without weakening JEV',async t=>{
  const m=manifest();const observed=[];
  const clue={url:ig,title:'Unverified search clue',methods:['serper'],
    discoveryEvidence:[{kind:'post_mention',ownershipConfirmed:false}],discoveryPriority:100};
  const result=await runFixturePilot({manifest:m,journalPath:path.join(await temp(t),'journal.jsonl'),
    transport:{fixture:true,dispatch:async({kind,payload})=>{
      observed.push(kind);
      if(kind==='spotify_oembed')return {...catalog,displayName:'Frankelly Bello'};
      if(kind==='serper')return {profiles:payload.queryIndex===0 ? [clue,{...clue,url:'https://www.instagram.com/unreadable_fan/',discoveryPriority:0}] : [],
        methodsUsed:[{method:'serper',status:'used'}]};
      if(kind==='scrapecreators_candidate') {
        if(payload.url!==ig) throw new Error('Restricted neighbouring candidate');
        return {url:ig,displayName:'Frankelly Bello',externalUrls:[hubUrl]};
      }
      if(kind==='public_page')return parsePublicMusicPage(payload.url,pages[payload.url]);
      if(kind==='jev'){assert.equal(payload.profiles[0].identityComparison.status,'likely');
        return [{url:ig,jevVerification:{verdict:'verified',sameIdentityProbability:0.96}}];}
      throw new Error(`Unexpected stage ${kind}`);
    }},evaluateRegressions:async()=>true});
  assert.equal(observed.filter(k=>k==='serper').length,2);
  assert.equal(observed.filter(k=>k==='public_page').length,3);
  assert.deepEqual(result.results[0].urls,[ig]);
  assert.match(result.results[0].rawResult.profiles[1].metadataLookupError,/Restricted/);
  assert.equal(result.claimsSubmitted,0);
  assert.equal(result.results[0].approvedCatalogLinks,false);
  const weak=await runFixturePilot({manifest:manifest(),journalPath:path.join(await temp(t),'journal.jsonl'),
    transport:{fixture:true,dispatch:async({kind,payload})=>{
      if(kind==='spotify_oembed')return {...catalog};
      if(kind==='serper')return {profiles:[clue],methodsUsed:[{method:'serper',status:'used'}]};
      if(kind==='scrapecreators_candidate')return {url:ig,externalUrls:[hubUrl]};
      if(kind==='public_page')return parsePublicMusicPage(payload.url,pages[payload.url]);
      return [{url:ig,jevVerification:{verdict:'likely',sameIdentityProbability:0.23}}];
    }},evaluateRegressions:async()=>false});
  assert.deepEqual(weak.results[0].urls,[]);
});

test('old one-page and aggregate public caps cannot silently expand during resolution',async t=>{
  const m=manifest();delete m.proposed_limits.public_music_page_requests_per_artist;
  m.proposed_limits.public_http_requests_total=1;let reads=0;
  const budget=await createPilotBudget({manifest:m,mode:'fixture',journalPath:path.join(await temp(t),'budget.jsonl'),
    transport:{fixture:true,dispatch:async()=>{reads++;return {};}}});
  await budget.request({profileId:'1',kind:'public_page',key:'page-one'});
  await assert.rejects(budget.request({profileId:'1',kind:'public_page',key:'page-two'}),/cap/);
  await assert.rejects(budget.request({profileId:'1',kind:'spotify_oembed',key:'other-public'}),/cap/);
  assert.equal(reads,1);await budget.close();
});
