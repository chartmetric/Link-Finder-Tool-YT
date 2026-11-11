import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {youtubeMetadataQueries,bindYoutubeCatalogAccounts} from './youtube-catalog-metadata.mjs';
import {youtubeArtistSearchQuery,youtubeSearchNames,rankYoutubeMusicCandidates} from './youtube-music-search.mjs';
import {createYoutubeChannelCache} from './youtube-channel-dedup.mjs';
import {youtubeMusicKey,evaluateYoutubeOwnership,evidenceDigest as hash} from './youtube-ownership-policy.mjs';
import {youtubeArtistFromCatalogPacket,assembleYoutubeOwnershipEvidence,spotifyId} from './youtube-ownership-evidence.mjs';
import {exportYoutubeCatalogEvidence} from './youtube-ownership-catalog-export.mjs';
import {evaluateCandidate,MODEL_PLAN} from './youtube-campaign-core.mjs';

globalThis.fetch=()=>{throw Error('Network is forbidden in this offline test');};
const id='UCabcdefghijklmnopqrstuv',handle='https://www.youtube.com/@artist';
const idUrl='https://www.youtube.com/channel/'+id,spotify='1234567890123456789012';
const artist={profileId:'1',cmArtist:'2',name:'Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
  accounts:[{platform:'spotify',url:'https://open.spotify.com/artist/'+spotify}]};
const scope={artists:[{profile_id:'1',cm_artist:'2',artist:'Artist',tier:2,accounts:[],account_ids:[]}]};
const account={profile_id:'1',cm_artist:'2',account_id:'10',platform:'instagram',
  account_url:'https://www.instagram.com/artist/',source_updated_at:'2026-11-11T12:00:00Z'};
const candidate=(url=handle)=>({url,title:'Artist',snippet:'Musician',sourceUrl:url});
function capture(url=handle,changes={}){
  const body={channelId:id,handle:'artist',url:handle,displayName:'Artist',description:'Musician',
    externalUrls:['https://open.spotify.com/artist/'+spotify],...changes};
  return {requestedUrl:url,status:200,capturedAt:'2026-11-11T12:00:00Z',body,bodySha256:hash(body)};
}
function data(accounts){
  return {catalogProfiles:[{profile_id:'1',cm_artist:'2',name:'Artist'}],accounts,
    snapshots:[{profile_id:'1',platform:'instagram',latest:['https://youtube.com/@artist','Artist','',
      '2026-11-11T12:00:00Z','2026-11-11T12:00:00Z']}],
    chartmetric:[],tags:[],spotify:[],releases:[],cmTracks:[],profileMetadata:[]};
}
test('YouTube queries include active Instagram catalog links without changing Instagram defaults',()=>{
  const before=metadataQueries(scope),youtube=youtubeMetadataQueries(scope);
  assert.match(before.accounts,/is_active=1 AND platform!='instagram'/);
  assert.match(youtube.accounts,/is_active=1 AND platform!='youtube'/);
  assert.match(youtube.accounts,/l\.disconnected_at IS NULL/);
  assert.match(youtube.snapshots,/platform!='youtube'/);
  assert.deepEqual(metadataQueries(scope),before);
  for(const name of Object.keys(before).filter(k=>!['accounts','snapshots'].includes(k)))
    assert.equal(youtube[name],before[name]);
});
test('new account references are frozen before constructing platform context',()=>{
  const frozen=bindYoutubeCatalogAccounts(scope,[account]);
  const packet=buildMetadataOverlay(frozen,data(frozen.artists[0].accounts),'2026-11-11T12:00:00Z').packets[0];
  assert.equal(packet.linkedAccounts[0].wasInFrozenBatch,true);
  assert.equal(packet.platformSnapshots[0].usableAsContext,true);
  assert.equal(packet.platformSnapshots[0].binding,'profile_and_platform_only_not_account_bound');
  assert.equal(scope.artists[0].account_ids.length,0);
});
test('inactive, disconnected, target-platform and unsafe URLs cannot become references',()=>{
  const rows=[{...account,is_active:0},{...account,disconnected_at:'2026-11-11'},
    {...account,platform:'youtube'},{...account,account_url:'https://user:secret@instagram.com/artist'}];
  assert.deepEqual(bindYoutubeCatalogAccounts(scope,rows).artists[0].accounts,[]);
  assert.throws(()=>bindYoutubeCatalogAccounts(scope,[{...account,cm_artist:'999'}]),/binding changed/);
  assert.throws(()=>bindYoutubeCatalogAccounts(scope,[{...account,source:'campaign_likely'}]),/not catalog/);
});
test('multiple Instagram accounts do not turn a platform-only snapshot into an account declaration',()=>{
  const frozen=bindYoutubeCatalogAccounts(scope,[account,{...account,account_id:'11',account_url:'https://instagram.com/other'}]);
  const packet=buildMetadataOverlay(frozen,data(frozen.artists[0].accounts),'2026-11-11T12:00:00Z').packets[0];
  assert.equal(packet.platformSnapshots[0].usableAsContext,false);
  assert.match(packet.platformSnapshots[0].holdReason,/multiple/);
});
test('exact Instagram account snapshots reach YouTube evidence without becoming independent captures',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-reference-'));
  try{
    await fs.mkdir(root+'/metadata');
    const frozen=bindYoutubeCatalogAccounts(scope,[account]);
    const packet=buildMetadataOverlay(frozen,data(frozen.artists[0].accounts),'2026-11-11T12:00:00Z').packets[0];
    await fs.writeFile(root+'/metadata/1.json',JSON.stringify(packet));
    let calls=0;
    await exportYoutubeCatalogEvidence(root,root+'/export',{query:async sql=>{
      calls++;
      return sql.includes('account_snapshots')?[{account_id:'10',platform:'instagram',
        latest:['https://www.youtube.com/@artist','2026-11-11T12:00:00Z','2026-11-11T12:00:00Z']}]:[];
    }});
    assert.equal(calls,3);
    const [enriched]=JSON.parse(await fs.readFile(root+'/export/packets.json','utf8'));
    const bound=youtubeArtistFromCatalogPacket(enriched),c={...candidate(),capture:capture()};
    bound.ownershipEvidence=assembleYoutubeOwnershipEvidence(bound,enriched,c);
    assert.equal(bound.ownershipEvidence.declarations.length,1);
    assert.equal(bound.ownershipEvidence.declarations[0].accountId,'10');
    assert.equal(bound.ownershipEvidence.declarations[0].kind,'catalog_account_declaration');
    assert.equal(evaluateYoutubeOwnership(bound,c).status,'needs_identity_check');
    const wrong={...enriched,accountSnapshots:enriched.accountSnapshots.map(r=>({...r,account_id:'99'}))};
    assert.equal(assembleYoutubeOwnershipEvidence(bound,wrong,c).declarations.length,0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('search quotes the exact artist name and remains music-specific',()=>{
  assert.equal(youtubeArtistSearchQuery({name:'ODF'}),'"ODF" musician music official YouTube channel');
  assert.ok(!youtubeArtistSearchQuery({name:'A"\\\nB'}).includes('\n'));
  assert.throws(()=>youtubeArtistSearchQuery({name:''}),/Missing exact/);
});
test('only exactly bound catalog names provide alternate search-name provenance',()=>{
  const a={...artist,context:{chartmetric:{cm_artist:'2',name:'Bound Alias'}}};
  assert.equal(youtubeSearchNames(a)[1].source,'exact_cm_artist_catalog_name');
  assert.equal(youtubeSearchNames(a)[1].profileId,'1');
  assert.equal(youtubeSearchNames(a)[1].sourceRecordSha256,hash(a.context.chartmetric));
  assert.equal(youtubeSearchNames({...a,context:{chartmetric:{cm_artist:'99',name:'Wrong'}}}).length,1);
  assert.equal(youtubeSearchNames({...a,catalogProfile:{profile_id:'999',cm_artist:'2'}}).length,1);
});
test('unresolved translations remain candidates and Topic search hits remain separate',()=>{
  const ranked=rankYoutubeMusicCandidates({name:'islandman'},[
    {...candidate(),title:'島の男',snippet:'Official channel'},
    {...candidate(idUrl),title:'islandman - Topic',snippet:'Music releases'}]);
  assert.equal(ranked.candidates.length,1);
  assert.equal(ranked.relatedTopicCandidates.length,1);
  assert.equal(ranked.candidates[0].discoveryRanking.reason,'discovery_clues_only_not_ownership');
});
test('visual instruction is not excluded when a bound artist identifies itself or supplies music context',()=>{
  for(const name of ['Artist','Alias']){
    const a={...artist,context:{chartmetric:{cm_artist:'2',name:'Alias'}}};
    assert.equal(rankYoutubeMusicCandidates(a,[{...candidate(),title:name,snippet:'Drawing tutorials'}]).candidates.length,1);
  }
  assert.equal(rankYoutubeMusicCandidates(artist,[{...candidate(),title:'Other',snippet:'Drawing lessons and original songs'}]).candidates.length,1);
});
test('offline replay of all 20 saved searches excludes the known visual-art mistakes without changing archives',async()=>{
  const root='generated-artifacts/youtube-test-20-usd5-2026-11-11/artists';
  let count=0;
  for(const file of (await fs.readdir(root)).filter(f=>f.endsWith('-captures.json'))){
    const r=JSON.parse(await fs.readFile(root+'/'+file,'utf8'));
    const candidates=r.allSearchCandidates.map(c=>({url:c.url,title:c.title,snippet:c.snippet,sourceUrl:c.sourceUrl,verified:false}));
    const ranked=rankYoutubeMusicCandidates(r.artist,candidates);count++;
    assert.equal(ranked.allCandidates.length,candidates.length);
    if(r.artist.name==='ODF'){assert.equal(ranked.excludedCandidates.length,1);assert.equal(ranked.candidates.length,0);}
    if(r.artist.name==='Pencing'){assert.equal(ranked.excludedCandidates.length,6);assert.equal(ranked.candidates.length,0);}
  }
  assert.equal(count,20);
});
test('localized Spotify artist IDs compare exactly on the allowed host',()=>{
  for(const prefix of ['','intl-pt/','intl-fr/']){
    const url='https://open.spotify.com/'+prefix+'artist/'+spotify+'?si=sample';
    assert.equal(youtubeMusicKey(url),'spotify:'+spotify);assert.equal(spotifyId(url),spotify);
  }
  for(const url of [
    'https://open.spotify.com.evil.test/intl-pt/artist/'+spotify,
    'https://www.open.spotify.com/artist/'+spotify,
    'https://user@open.spotify.com/artist/'+spotify,
    'https://open.spotify.com/intl-pt/track/'+spotify,
    'https://open.spotify.com/intl-pt/artist/'+spotify+'/extra',
    'http://open.spotify.com/artist/'+spotify,
  ])assert.equal(youtubeMusicKey(url),null);
});
test('matching localized music IDs do not auto-accept; conflicting IDs still hold',()=>{
  const c={...candidate(),capture:capture(handle,{externalUrls:['https://open.spotify.com/intl-pt/artist/'+spotify]})};
  assert.equal(evaluateYoutubeOwnership(artist,c).status,'needs_identity_check');
  c.capture=capture(handle,{externalUrls:['https://open.spotify.com/intl-pt/artist/abcdefghijklmnopqrstuv']});
  assert.equal(evaluateYoutubeOwnership(artist,c).status,'ownership_conflict');
});
test('saved channel observations reproduce one artist-bound duplicate without rerunning archived model answers',async()=>{
  const root='generated-artifacts/youtube-test-20-usd5-2026-11-11/artists';
  let observations=0,duplicates=0;const duplicateArtists=[];
  for(const file of (await fs.readdir(root)).filter(f=>f.endsWith('-captures.json'))){
    const r=JSON.parse(await fs.readFile(root+'/'+file,'utf8')),cache=createYoutubeChannelCache(r.artist);
    for(const c of r.candidates){
      observations++;
      if(cache.observe(r.artist,c)){duplicates++;duplicateArtists.push(r.artist.name);}
    }
  }
  assert.equal(observations,31);assert.equal(duplicates,1);assert.deepEqual(duplicateArtists,['DJ PANDA SC']);
});
function fakeRequests({differentAliasFacts=false,answerType='unknown'}={}){
  const calls=[];
  return {calls,request:async(profileId,kind,key,request)=>{
    calls.push({profileId,kind,key});
    if(kind==='metadata'){
      const url=new URL(request.url).searchParams.get('url');
      const second=calls.filter(c=>c.kind==='metadata').length===2;
      return {kind,request,inputSha256:hash(request),status:200,at:'2026-11-11T12:00:00Z',
        data:{success:true,channelId:id,channel:url.includes('/channel/')?handle:url,name:'Artist',
          description:second&&differentAliasFacts?'Fan channel for Artist':'Musician',
          links:['https://open.spotify.com/artist/'+spotify]}};
    }
    assert.equal(kind,'model');
    return {kind,request,inputSha256:hash(request),status:200,data:{model:MODEL_PLAN.model.expectedModel,
      usage:{cost:.001},answers:{same_identity:{noul:.5},verdict:{choice:'likely'},channel_type:{choice:answerType}}}};
  }};
}
test('a provider-bound handle and ID reuse one capture and one model check, retaining an unknown-role hold',async()=>{
  const cache=createYoutubeChannelCache(artist),fake=fakeRequests();
  const first=await evaluateCandidate({artist,candidate:candidate(),request:fake.request,channelConflict:async()=>false,channelCache:cache});
  const alias=await evaluateCandidate({artist,candidate:candidate(idUrl),request:fake.request,channelConflict:async()=>false,channelCache:cache});
  assert.equal(fake.calls.filter(c=>c.kind==='metadata').length,1);
  assert.equal(fake.calls.filter(c=>c.kind==='model').length,1);
  assert.equal(alias.aliasOf,handle);assert.equal(first.channelAliasObservations.length,1);
  assert.equal(first.decision.reviewSuggestion,false);
  assert.equal(first.decision.reason,'recorded_model_uncertain_or_unresolved_channel_type');
});
test('different requested handles bound to one channel retain both captures but run the model once',async()=>{
  const cache=createYoutubeChannelCache(artist),fake=fakeRequests();
  const first=await evaluateCandidate({artist,candidate:candidate(),request:fake.request,channelConflict:async()=>false,channelCache:cache});
  const other=await evaluateCandidate({artist,candidate:candidate('https://www.youtube.com/@other'),request:fake.request,
    channelConflict:async()=>false,channelCache:cache});
  assert.equal(fake.calls.filter(c=>c.kind==='metadata').length,2);
  assert.equal(fake.calls.filter(c=>c.kind==='model').length,1);
  assert.equal(other.aliasOf,handle);assert.ok(first.channelAliasObservations[0].capture);
});
test('conflicting alias captures hold the canonical decision without erasing its original answer',async()=>{
  const cache=createYoutubeChannelCache(artist),fake=fakeRequests({differentAliasFacts:true,answerType:'artist_owned'});
  const first=await evaluateCandidate({artist,candidate:candidate(),request:fake.request,channelConflict:async()=>false,channelCache:cache});
  assert.equal(first.decision.reviewSuggestion,true);
  await evaluateCandidate({artist,candidate:candidate('https://www.youtube.com/@other'),request:fake.request,
    channelConflict:async()=>false,channelCache:cache});
  assert.equal(first.decision.status,'ownership_conflict');
  assert.equal(first.recordedAnswer.answer.channelType,'artist_owned');
  assert.equal(fake.calls.filter(c=>c.kind==='model').length,1);
});
test('display-name equality and invalid captures cannot bind aliases or share another artist’s cache',()=>{
  const cache=createYoutubeChannelCache(artist),first={...candidate(),capture:capture()};
  assert.equal(cache.observe(artist,first),null);
  const invalid={...candidate('https://www.youtube.com/@unbound'),capture:capture('https://www.youtube.com/@unbound')};
  assert.equal(cache.observe(artist,invalid),null);assert.equal(invalid.aliasOf,undefined);
  assert.throws(()=>cache.reuse({...artist,profileId:'9'},candidate(idUrl)));
  assert.equal(createYoutubeChannelCache({...artist,profileId:'9'}).reuse({...artist,profileId:'9'},candidate(idUrl)),null);
});
