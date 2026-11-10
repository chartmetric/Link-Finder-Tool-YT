import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {declaredInstagramLinks} from './instagram-reference-links.mjs';
import {catalogConnectionEvidence,hasCatalogCrossLink,assessInstagramCandidates} from './musician-instagram-matching.mjs';
import {fitArtistContext,jevRequest} from './instagram-pilot-live-transport.mjs';
import {contextSignals} from './instagram-context-signals.mjs';
import {artistContextFromPacket} from './instagram-artist-metadata-overlay.mjs';
import {musicPageUrl,parsePublicMusicPage,resolveMusicEvidence} from './public-music-links.mjs';
import {runFixturePilot} from './instagram-pilot-runner.mjs';

const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const instagram='https://www.instagram.com/example_official/';
const youtube='https://www.youtube.com/@example_official';
const player={profile_id:'1',cm_artist:'2',artist:'Example Artist',account_ids:['3','4','5','6'],
  accounts:[
    {profile_id:'1',account_id:'3',platform:'spotify',account_url:spotify},
    {profile_id:'1',account_id:'4',platform:'youtube',account_url:youtube},
    {profile_id:'1',account_id:'5',platform:'twitter',account_url:'https://twitter.com/example_music'},
    {profile_id:'1',account_id:'6',platform:'tiktok',account_url:'https://www.tiktok.com/@example_music'},
  ]};
const candidate={url:instagram,platform:'instagram',displayName:'Example Artist',bio:'Official musician',
  externalUrls:[youtube],directExternalUrls:[youtube]};
const reference={platform:'spotify',url:spotify,displayName:'Example Artist',externalUrls:[]};
function profile(c=candidate){
  const catalogConnections=catalogConnectionEvidence(c,player);
  return {url:c.url,identityComparison:{reference,candidate:c,status:catalogConnections.length?'likely':'uncertain',catalogConnections},
    jevVerification:{verdict:'verified',sameIdentityProbability:0.95}};
}
function assess(p,artist=player){
  return assessInstagramCandidates({methodsUsed:[{method:'serper',status:'used'}],profiles:[p]},artist);
}

test('platform-labeled handles normalize ligatures/fullwidth text without treating arbitrary mentions as links',()=>{
  assert.equal(declaredInstagramLinks('Official Instagram @example_oﬃcial')[0].url,instagram);
  assert.equal(declaredInstagramLinks('公式Instagram：＠ｅｘａｍｐｌｅ＿ｏｆｆｉｃｉａｌ')[0].url,instagram);
  assert.equal(declaredInstagramLinks('IG → @Example_Official')[0].url,instagram);
  assert.equal(declaredInstagramLinks('instagram.com/example_official/')[0].url,instagram);
  assert.deepEqual(declaredInstagramLinks('Thanks @example_official; Instagram: see website'),[]);
  for(const text of ['https://evilinstagram.com/example_official/',
    'https://evil.test/instagram.com/example_official/','https://instagram.com/p/not_a_profile',
    'https://instagram.com/example_official/nested','https://instagram.com.evil.test/example_official/']) {
    assert.deepEqual(declaredInstagramLinks(text),[],text);
  }
});

test('a source-bound live reference may explicitly declare its Instagram handle',()=>{
  const live={...reference,bio:'Our official Instagram @example_oﬃcial'};
  assert.equal(hasCatalogCrossLink(live,{...candidate,externalUrls:[]},instagram,{platform:'spotify',url:spotify}),true);
  assert.deepEqual(assess({...profile({...candidate,externalUrls:[],directExternalUrls:[]}),
    identityComparison:{reference:live,candidate:{...candidate,externalUrls:[]},status:'likely'}}).urls,[instagram]);
});

test('non-Spotify catalog paths bind exact accounts; unrelated, inactive and derived links do not qualify',()=>{
  const links=catalogConnectionEvidence({...candidate,directExternalUrls:[
    'https://www.youtube.com/@EXAMPLE_OFFICIAL','https://x.com/Example_Music',
    'https://www.tiktok.com/@example_music']},player);
  assert.equal(links.length,3);
  for(const change of [
    {account_ids:['3']},
    {accounts:player.accounts.map(a=>({...a,profile_id:'9'}))},
    {accounts:player.accounts.map(a=>({...a,disconnected_at:'2026-01-01'}))},
    {accounts:player.accounts.map(a=>({...a,is_active:0}))},
  ])assert.equal(catalogConnectionEvidence(candidate,{...player,...change}).length,0);
  assert.equal(catalogConnectionEvidence({...candidate,directExternalUrls:['https://youtube.com/@example_official_fake']},player).length,0);
  assert.equal(catalogConnectionEvidence({...candidate,directExternalUrls:undefined,
    externalLinkEvidence:{status:'unresolved'}},player).length,0);
});

test('the gate recomputes catalog binding and retains score, ownership and mismatch requirements',()=>{
  assert.deepEqual(assess(profile()).urls,[instagram]);
  for(const p of [
    {...profile(),jevVerification:{verdict:'verified',sameIdentityProbability:0.89}},
    {...profile(),jevVerification:{verdict:'likely',sameIdentityProbability:0.99}},
    {...profile(),jevVerification:{verdict:'mismatch',sameIdentityProbability:0.01}},
    profile({...candidate,bio:'Record label'}),
    profile({...candidate,url:'https://www.instagram.com/someone_else/',externalUrls:[],directExternalUrls:[]}),
  ])assert.deepEqual(assess(p).urls,[]);
  assert.deepEqual(assess(profile(),{...player,account_ids:['3']}).urls,[]);
  const forged=profile({...candidate,directExternalUrls:[],externalUrls:[]});
  forged.identityComparison.catalogConnections=profile().identityComparison.catalogConnections;
  forged.identityComparison.status='likely';
  assert.deepEqual(assess(forged).urls,[]);
});

test('long, old and platform-only bios are visible with provenance but cannot establish gate eligibility',()=>{
  const item={kind:'bio',platform:'youtube',source:'saved_snapshot',
    sourceUrl:youtube,binding:'profile_and_platform_only_not_account_bound',
    asOf:'2020-01-01',ageDays:2500,stale:true,
    text:'Introduction. '.repeat(100)+'Official Instagram @example_oﬃcial'};
  const signals=contextSignals({items:[item]},candidate,player.artist);
  assert.equal(signals.otherPlatformBioLinksToCandidate.result,'support');
  assert.equal(signals.otherPlatformBioLinksToCandidate.sources[0].stale,true);
  assert.equal(signals.otherPlatformBioLinksToCandidate.sources[0].binding,item.binding);
  const p=profile({...candidate,externalUrls:[],directExternalUrls:[]});
  assert.deepEqual(assess(p).urls,[]);
  const request=jevRequest({artist:player.artist,catalogReference:reference,profiles:[p],
    artistContext:{ownershipConfirmed:false,items:[item]}});
  assert.equal(request.state.artistContext.candidateSignals[0].otherPlatformBioLinksToCandidate.result,'support');
});

test('declarations survive item limits and size fitting; oversized critical evidence explicitly holds',()=>{
  const bio={platform:'youtube',source:'snapshot',snapshotDate:'2026-11-09',
    binding:'profile_and_platform_only_not_account_bound',usableAsContext:true,bio:'Instagram @example_oﬃcial'};
  const context=artistContextFromPacket({collectedAt:'2026-11-09',platformSnapshots:[bio],spotifyMetadata:[],
    tags:[],releases:Array.from({length:16},(_,i)=>({track_name:'Track '+i,source:'tracks',source_updated_at:'2026-11-08'}))});
  assert.equal(context.items[0].kind,'bio');
  const p=profile();
  const unrelated=profile({...candidate,url:'https://www.instagram.com/different/',externalUrls:[],directExternalUrls:[]});
  const payload={artist:player.artist,catalogReference:reference,profiles:[p,unrelated],artistContext:context};
  const fitted=fitArtistContext(payload,6000),request=jevRequest(fitted);
  assert.ok(Buffer.byteLength(JSON.stringify(request))<=6000);
  assert.equal(request.state.contextDelivery.protectedDeclarations,1);
  assert.equal(request.state.artistContext.candidateSignals[0].otherPlatformBioLinksToCandidate.result,'support');
  assert.equal(request.state.candidates[0].catalogConnections[0].targetUrl,youtube);
  // Deduplication uses verbatim rules; no ownership criterion is relaxed.
  if(fitted.compactEvidence)assert.match(request.state.evidenceRules.same_identity,/Require artist ownership/);
  const compact=jevRequest({...fitted,compactEvidence:true});
  assert.equal(compact.state.artistContext.declarations[0].url,instagram);
  assert.equal(compact.state.artistContext.candidateSignals[0].otherPlatformBioLinksToCandidate.sourceIndexes[0],0);
  assert.throws(()=>fitArtistContext(payload,500),/no dispatch or silent evidence loss/);
});

test('TuneCore links use exact host/path/query validation and bounded source-linked parsing',async()=>{
  const url='https://social.tunecore.com/linkShare?linkid=abc_123-xyz';
  assert.equal(musicPageUrl(url),url);
  for(const bad of [url+'&url=https://evil.test',url+'&linkid=second',url.replace('social.tunecore.com','evil.tunecore.com'),
    url.replace('/linkShare','/other'),'http://social.tunecore.com/linkShare?linkid=x',
    'https://social.tunecore.com/linkShare?linkid=..%2Fadmin'])assert.equal(musicPageUrl(bad),null);
  const page=parsePublicMusicPage(url,`<a href="${spotify}">Spotify</a>`,{status:200});
  assert.ok(page.musicTargets.length>0);
  let reads=0;
  const result=await resolveMusicEvidence({candidate:{...candidate,externalUrls:[url],directExternalUrls:[url]},
    catalog:reference,maxPages:1,readPage:async source=>{
      reads++;return parsePublicMusicPage(source,`<a href="${spotify}">Spotify</a>`,{status:200});
    }});
  assert.equal(reads,1);
  assert.ok(result.externalUrls.includes(spotify));
});

test('fixture runner connects alternate accounts and delivers declarations end to end without extra provider kinds',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-path-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const context={ownershipConfirmed:false,items:[{kind:'bio',source:'snapshot',platform:'youtube',
    binding:'profile_and_platform_only_not_account_bound',asOf:'2026-11-09',text:'Instagram @example_oﬃcial'}]};
  const manifest={run_allowed:false,artists:[{...player,metadata_context:context,
    source_identity_matches:true,catalog_profile:{profile_id:'1',cm_artist:'2',cm_source:'cm_artist'},
    reference_preflight:{readiness:'reference_usable'}}],
    proposed_limits:{artist_workers:1,global_concurrent_provider_requests:1,eligible_artists_before_prerequisite_fixes:1,
      serper_requests_per_artist:1,instagram_candidate_metadata_per_artist:1,reference_metadata_per_artist:1,
      jev_requests_per_artist:1,serper_requests_total:1,scrapecreators_requests_total:1,jev_requests_total:1,
      paid_http_requests_total:3,public_spotify_oembed_requests_total:1,public_official_or_linkhub_page_requests_total:1,
      per_request_timeout_seconds:20,per_artist_wall_time_seconds:60,job_wall_time_minutes:1,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
  let request;
  const result=await runFixturePilot({manifest,journalPath:path.join(dir,'admissions.jsonl'),
    transport:{fixture:true,dispatch:async({kind,payload})=>{
      if(kind==='spotify_oembed')return reference;
      if(kind==='serper')return {methodsUsed:[{method:'serper',status:'used'}],profiles:[{url:instagram,title:player.artist}]};
      if(kind==='scrapecreators_candidate')return candidate;
      if(kind==='jev'){request=jevRequest(payload);return [{url:instagram,jevVerification:{verdict:'verified',sameIdentityProbability:0.95}}];}
      throw Error('Unexpected additional call');
    }}});
  assert.deepEqual(result.results[0].urls,[instagram]);
  assert.equal(result.results[0].approvedCatalogLinks,false);
  assert.equal(result.results[0].contextDelivery.protectedDeclarations,1);
  assert.equal(request.state.candidates[0].catalogConnections[0].targetUrl,youtube);
  assert.equal(request.state.artistContext.candidateSignals[0].otherPlatformBioLinksToCandidate.result,'support');
});
