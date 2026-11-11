import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {evidenceDigest,youtubeVerificationInput,evaluateYoutubeOwnership} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {assembleYoutubeOwnershipEvidence,declaredYoutubeLinks,youtubeArtistFromCatalogPacket,bindSavedInstagramReference} from './youtube-ownership-evidence.mjs';
import {exportYoutubeCatalogEvidence} from './youtube-ownership-catalog-export.mjs';

// All fixtures below are synthetic, not archived ownership adjudications.
const url='https://www.youtube.com/user/SyntheticArtist',channelId='UCabcdefghijklmnopqrstuv';
const spotify='https://open.spotify.com/artist/1234567890123456789012';
const account={profile_id:'1',cm_artist:'2',account_id:'3',platform:'spotify',account_url:spotify,
  wasInFrozenBatch:true,source_updated_at:'2026-11-01'};
function packet(){
  return {profileId:'1',cmArtist:'2',artist:'Synthetic Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
    collectedAt:'2026-11-11T01:00:00Z',linkedAccounts:[structuredClone(account)],releases:[{spotify_artist_id:'1234567890123456789012',
      spotify_track_id:'track',spotify_album_id:'album',isrc:'SYNTHETIC',track_name:'Synthetic Release'}],
    catalogTracks:[{cm_artist:'2',cm_track:'10',isrc:'SYNTHETIC',track_name:'Synthetic Release'}],
    spotifyMetadata:[],profileMetadata:[],platformSnapshots:[],tags:[],
    accountSnapshots:[{account_id:'3',platform:'spotify',bio:'Our YouTube: '+url,source_updated_at:'2026-11-10'}]};
}
function receipt(){
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
  return {kind:'metadata',operationKey:'channel-1-'+evidenceDigest(url),status:200,at:'2026-11-11T01:00:00Z',
    request,inputSha256:evidenceDigest(request),data:{success:true,channelId,
      channel:'http://www.youtube.com/@syntheticartist',handle:'@syntheticartist',name:'Synthetic Artist',
      description:'Musician',links:[spotify],isVerified:true},parseFailed:false};
}
const candidate=()=>({url,title:'Official synthetic video release',snippet:'Our YouTube: '+url,
  sourceUrl:url,capture:normalizeYoutubeChannel(receipt(),url)});

test('Exact catalog declarations, music IDs and releases stay separate from snippets and unavailable fields',()=>{
  const p=packet(),a=youtubeArtistFromCatalogPacket(p),c=candidate();
  const e=assembleYoutubeOwnershipEvidence(a,p,c);
  assert.equal(e.declarations.length,1);
  assert.equal(e.declarations[0].sourceUrl,spotify);
  assert.equal(e.declarations[0].sourceRecordSha256,evidenceDigest(p.accountSnapshots[0]));
  assert.equal(e.musicIds[0].artistId,'1234567890123456789012');
  assert.equal(e.releases.length,2);
  assert.equal(e.releases[0].isrc,'SYNTHETIC');
  assert.deepEqual(e.channelAttributedVideos,[]);
  assert.equal(e.unavailable.officialArtistChannel,true);
  assert.equal(e.searchEvidence.kind,'saved_search_snippet_not_captured_video');
  const input=youtubeVerificationInput({...a,ownershipEvidence:e},c);
  assert.deepEqual(input.state.artist.ownershipEvidence,e);
  assert.equal(evaluateYoutubeOwnership({...a,ownershipEvidence:e},c).reviewSuggestion,false);
  assert.deepEqual(declaredYoutubeLinks('YouTube @syntheticartist, official artist name'),[]);
  assert.deepEqual(declaredYoutubeLinks('https://youtube.com.evil.invalid/@syntheticartist'),[]);
});

test('Swapped artists, accounts, timestamps and platform-only bios never become exact declarations',()=>{
  const p=packet(),a=youtubeArtistFromCatalogPacket(p),c=candidate();
  assert.throws(()=>assembleYoutubeOwnershipEvidence({...a,cmArtist:'999'},p,c),/exact artist/);
  for(const mutate of [
    x=>{x.accountSnapshots[0].account_id='4';},
    x=>{x.accountSnapshots[0].platform='instagram';},
    x=>{x.linkedAccounts[0].wasInFrozenBatch=false;},
    x=>{x.linkedAccounts[0].cm_artist='9';},
    x=>{x.accountSnapshots[0].source_updated_at='unavailable';},
  ]){
    const wrong=packet();mutate(wrong);
    assert.equal(assembleYoutubeOwnershipEvidence(a,wrong,c).declarations.length,0);
  }
  const platforms=packet();platforms.accountSnapshots=[];
  platforms.platformSnapshots=[{platform:'spotify',bio:'YouTube: '+url}];
  assert.equal(assembleYoutubeOwnershipEvidence(a,platforms,c).declarations.length,0);
  const e=assembleYoutubeOwnershipEvidence(a,p,c);
  assert.throws(()=>youtubeVerificationInput({...a,profileId:'4',catalogProfile:{profile_id:'4',cm_artist:'2'},ownershipEvidence:e},c),/Unbound/);
  e.declarations[0].sourceRecord.bio='Substituted';
  assert.throws(()=>youtubeVerificationInput({...a,ownershipEvidence:e},c),/Unbound/);
});

test('Saved reference captures require matching artist, request, returned account and exact frozen catalog link',()=>{
  const p=packet();p.linkedAccounts.push({...account,platform:'instagram',account_id:'4',
    account_url:'https://www.instagram.com/syntheticartist/'});
  const a=youtubeArtistFromCatalogPacket(p);
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/instagram/profile?handle=syntheticartist'};
  const r={profileId:'1',kind:'metadata',status:200,at:'2026-11-10T00:00:00Z',request,inputSha256:evidenceDigest(request),
    data:{success:true,data:{user:{username:'syntheticartist',biography:'YouTube: '+url,bio_links:[]}}}};
  assert.equal(bindSavedInstagramReference(a,p,r).body.declaredLinks[0],url);
  for(const change of [
    x=>{x.profileId='9';},x=>{x.data.data.user.username='other';},
    x=>{x.inputSha256='0'.repeat(64);},
    x=>{x.request.url=x.request.url.replace('api.scrapecreators.com','evil.invalid');x.inputSha256=evidenceDigest(x.request);},
    x=>{x.status=404;},x=>{x.at='missing';},
  ]){
    const wrong=structuredClone(r);change(wrong);assert.equal(bindSavedInstagramReference(a,p,wrong),null);
  }
  p.savedOfficialAccountCaptures=[{sourceFile:'synthetic/receipt.json',receipt:r}];
  assert.equal(assembleYoutubeOwnershipEvidence(a,p,candidate()).declarations.length,2);
  p.linkedAccounts[1].wasInFrozenBatch=false;
  assert.equal(bindSavedInstagramReference(a,p,r),null);
});

test('Video attribution needs an exact channel ID, not matching release text or search snippets',()=>{
  const p=packet(),a=youtubeArtistFromCatalogPacket(p),c=candidate();
  const raw=receipt();
  raw.data.videos=[{videoId:'abcdefghijk',title:'Synthetic Release',channelId},
    {videoId:'lmnopqrstuv',title:'Synthetic Release',channelId:'UCABCDEFGHIJKLMNOPQRSTUV'},
    {videoId:'abcdefghijk',title:'Synthetic Release'}];
  c.capture=normalizeYoutubeChannel(raw,url);
  const e=assembleYoutubeOwnershipEvidence(a,p,c);
  assert.equal(e.channelAttributedVideos.length,1);
  assert.equal(e.channelAttributedVideos[0].channelId,channelId);
  c.capture.rawReceiptSha256='0'.repeat(64);
  assert.equal(assembleYoutubeOwnershipEvidence(a,p,c).channelAttributedVideos.length,0);
  c.capture=candidate().capture;
  c.capture.body.videos=raw.data.videos;
  c.capture.bodySha256=evidenceDigest(c.capture.body);
  assert.equal(assembleYoutubeOwnershipEvidence(a,p,c).channelAttributedVideos.length,0);
});

test('Unknown flags remain unknown; generic verification and saved declarations cannot blanket-accept held roles',()=>{
  const p=packet(),a=youtubeArtistFromCatalogPacket(p),c=candidate();
  assert.equal(c.capture.body.isOfficialArtistChannel,null);
  assert.equal(c.capture.body.isAutoGenerated,null);
  const e=assembleYoutubeOwnershipEvidence(a,p,c),enriched={...a,ownershipEvidence:e};
  const hash=youtubeVerificationInput(enriched,c).inputSha256;
  for(const type of ['unknown','topic','fan','organization']){
    const r=evaluateYoutubeOwnership(enriched,c,{answer:{inputSha256:hash,
      answer:{verdict:'likely',sameIdentityProbability:.99,channelType:type}}});
    assert.equal(r.reviewSuggestion,false);
  }
  assert.equal(evaluateYoutubeOwnership(enriched,c,{sharedChannel:true}).status,'ownership_conflict');
  c.capture.body.externalUrls=['https://open.spotify.com/artist/abcdefghijklmnopqrstuv'];
  c.capture.bodySha256=evidenceDigest(c.capture.body);
  assert.equal(evaluateYoutubeOwnership(enriched,c).status,'ownership_conflict');
});

test('Offline CLI reconstructs captures, preserves original bytes and cannot access any network',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-evidence-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const source=dir+'/source',output=dir+'/prepared';
  for(const d of ['artists','inputs','metadata','receipts'])await fs.mkdir(source+'/'+d,{recursive:true});
  const p=packet(),a=youtubeArtistFromCatalogPacket(p);
  const c={...candidate(),capture:null,decision:{status:'needs_channel_metadata',reviewSuggestion:false},
    arbitraryOriginalField:{preserve:['complete','original']}};
  const original=JSON.stringify({artist:a,searchStatus:'candidates_found',candidates:[c]},null,3);
  await fs.writeFile(source+'/artists/1.json',original);
  await fs.writeFile(source+'/inputs/1-original.json',JSON.stringify(c));
  await fs.writeFile(source+'/metadata/1.json',JSON.stringify(p));
  await fs.writeFile(source+'/receipts/receipt.json',JSON.stringify(receipt()));
  for(const f of ['approval.json','queue.json','stopped.json','user-pause.json','progress.json','admissions.jsonl'])
    await fs.writeFile(source+'/'+f,'{}\n');
  await fs.writeFile(source+'/approval.json',JSON.stringify({model:{
    endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13',maxRequestBytes:64000}}));
  const here=path.dirname(fileURLToPath(import.meta.url));
  const result=JSON.parse(execFileSync(process.execPath,['--import',here+'/youtube-ownership-offline-fence.mjs',
    here+'/prepare-youtube-ownership-evidence.mjs',source,output],{encoding:'utf8',
    env:{PATH:process.env.PATH,HOME:dir}}));
  assert.equal(result.recoveredCaptures,1);
  assert.equal(result.paidCalls,0);
  assert.equal(result.acceptancesChanged,0);
  assert.equal(result.existingRequestByteLimit,64000);
  assert.equal(await fs.readFile(output+'/originals/artists/1.json','utf8'),original);
  assert.equal(await fs.readFile(source+'/artists/1.json','utf8'),original);
  const row=JSON.parse(await fs.readFile(output+'/artists/1.json','utf8'));
  assert.deepEqual(row.originalRecord.candidates[0],c);
  assert.equal(row.candidates[0].proposedDecision,null);
  assert.equal(row.candidates[0].proposedInput.originalAnswerNotApplicable,true);
  const plan=JSON.parse(await fs.readFile(output+'/approval-plan.json','utf8'));
  assert.equal(plan.executable,false);assert.equal(plan.approved,false);
  assert.equal(plan.approvedBudgetUsd,null);
  assert.equal(plan.model.maxRequestBytes,64000);
  assert.throws(()=>execFileSync(process.execPath,['--import',here+'/youtube-ownership-offline-fence.mjs',
    '--input-type=module','-e',"import net from 'node:net'; net.connect(443,'example.com')"],
    {env:{PATH:process.env.PATH},stdio:'pipe'}),/Command failed/);
  assert.throws(()=>execFileSync(process.execPath,['--import',here+'/youtube-ownership-offline-fence.mjs',
    '--input-type=module','-e',"await fetch('https://example.com')"],
    {env:{PATH:process.env.PATH},stdio:'pipe'}),/Command failed/);
});

test('Catalog export uses SELECT only and retains exact source IDs without provider calls',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-catalog-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(dir+'/source/metadata',{recursive:true});
  await fs.writeFile(dir+'/source/metadata/1.json',JSON.stringify(packet()));
  const sql=[];
  const result=await exportYoutubeCatalogEvidence(dir+'/source',dir+'/export',{query:async q=>{
    sql.push(q);assert.ok(q.startsWith('SELECT'));assert.ok(!q.includes('INSERT'));
    return [];
  }});
  assert.equal(sql.length,3);assert.equal(result.providerRequests,0);
  const packets=JSON.parse(await fs.readFile(dir+'/export/packets.json','utf8'));
  assert.equal(packets[0].baselineCatalogPacketSha256,evidenceDigest(packet()));
});
