import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {targetPlatformMetadataQueries,collectTargetPlatformMetadata} from './target-platform-catalog-metadata.mjs';
import {exportYoutubeCatalogEvidence} from './youtube-ownership-catalog-export.mjs';
import {youtubeArtistFromCatalogPacket,assembleYoutubeOwnershipEvidence} from './youtube-ownership-evidence.mjs';
import {youtubeVerificationInput,evaluateYoutubeOwnership,evidenceDigest} from './youtube-ownership-policy.mjs';
import {youtubeDecisionRequest,normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';

const at='2026-11-11T00:00:00Z';
const ig='https://www.instagram.com/syntheticartist/';
const youtube='https://www.youtube.com/@syntheticartist';
const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const row=(platform='instagram',account_id='3',account_url=ig)=>({
  profile_id:'1',cm_artist:'2',account_id,platform,account_url,
  is_active:1,disconnected_at:null,connected_at:at,source_updated_at:at,
});
const manifest={artists:[{profile_id:'1',cm_artist:'2',artist:'Synthetic Artist',tier:3,account_ids:[],accounts:[]}]};
const data=()=>({
  catalogProfiles:[{profile_id:'1',cm_artist:'2',name:'Synthetic Artist'}],
  accounts:[row(),row('spotify','4',spotify)],
  snapshots:[{profile_id:'1',platform:'instagram',latest:['YouTube: '+youtube,'Synthetic','','2026-11-10',at]}],
  chartmetric:[],tags:[],spotify:[],releases:[],cmTracks:[],profileMetadata:[],
});
function fixtureQuery(fixture,{targetPlatform='youtube',scope=manifest}={}){
  // A real account-first preparation also fills Spotify IDs before its release
  // query. Match exact SQL, not query order, so omissions cannot pass unnoticed.
  const enriched=structuredClone(scope);
  if(targetPlatform==='youtube')for(const a of enriched.artists)a.accounts=[row('spotify','4',spotify)];
  const queries=targetPlatformMetadataQueries(enriched,{targetPlatform});
  const seen=[];
  return {seen,query:async sql=>{
    assert.ok(sql.startsWith('SELECT'));
    const name=Object.keys(queries).find(k=>queries[k]===sql);
    assert.ok(name,'Unexpected SQL in offline fixture');
    assert.ok(!seen.includes(name),'Catalog query repeated');
    seen.push(name);
    // Emulate the target exclusion and active joins as well as checking SQL.
    const rows=structuredClone(fixture[name]);
    return ['accounts','snapshots'].includes(name)?rows.filter(r=>r.platform!==targetPlatform):rows;
  }};
}

test('YouTube SQL retains Instagram with active catalog joins; Instagram defaults are byte-identical',()=>{
  const original=metadataQueries(manifest);
  assert.deepEqual(targetPlatformMetadataQueries(manifest),original);
  assert.deepEqual(targetPlatformMetadataQueries(manifest,{targetPlatform:'instagram'}),original);
  const queries=targetPlatformMetadataQueries(manifest,{targetPlatform:'youtube'});
  for(const key of ['accounts','snapshots']){
    assert.match(queries[key],/platform!='youtube'/);
    assert.doesNotMatch(queries[key],/platform!='instagram'/);
  }
  assert.match(queries.accounts,/is_active=1/);
  assert.match(queries.accounts,/l\.disconnected_at IS NULL/);
  assert.match(queries.accounts,/cm_source='cm_artist'/);
  assert.throws(()=>targetPlatformMetadataQueries(manifest,{targetPlatform:"youtube' OR 1=1"}),/Unsupported/);
});

test('New YouTube preparation admits only active exact catalog references, never campaign likely candidates',async()=>{
  const d=data();
  d.accounts.push(
    {...row(),account_id:'10',is_active:0},
    {...row(),account_id:'11',disconnected_at:at},
    {...row(),account_id:'12',cm_artist:'999'},
    {...row(),account_id:'13',profile_id:'999'},
    {...row(),account_id:'14',is_active:undefined},
    {...row(),account_id:'15',disconnected_at:undefined},
    row('instagram','16','https://evil.invalid/syntheticartist/'),
    row('youtube','17',youtube),
  );
  const supplied=structuredClone(manifest);
  supplied.artists[0].accounts=[{...row('instagram','999','https://instagram.com/likelycandidate/'),
    wasInFrozenBatch:true,status:'likely'}];
  supplied.artists[0].account_ids=['999'];
  const before=JSON.stringify(supplied),f=fixtureQuery(d);
  const result=await collectTargetPlatformMetadata(supplied,{targetPlatform:'youtube',query:f.query,now:()=>at});
  assert.equal(JSON.stringify(supplied),before);
  assert.equal(f.seen.length,9);
  const p=result.packets[0];
  assert.deepEqual(p.linkedAccounts.map(a=>a.account_id),['3','4']);
  const a=p.linkedAccounts[0];
  assert.equal(a.wasInFrozenBatch,true);
  assert.equal(a.binding,'catalog_link_not_independently_verified');
  assert.deepEqual(a.catalogReferenceProvenance,{
    profileId:'1',cmArtist:'2',accountId:'3',platform:'instagram',source:a.source,
    observedAt:at,querySha256:createHash('sha256').update(p.catalogCollection.queries.accounts).digest('hex'),
    isActive:true,disconnectedAt:null,binding:'exact_active_catalog_link_not_independently_verified',
  });
  assert.equal(p.platformSnapshots[0].binding,'profile_and_platform_only_not_account_bound');
  assert.equal(p.safeForImport,false);
  const changed=data();changed.catalogProfiles[0].cm_artist='999';
  await assert.rejects(collectTargetPlatformMetadata(manifest,{
    targetPlatform:'youtube',query:fixtureQuery(changed).query,now:()=>at}),/identity changed/);
});

test('Instagram collection retains the old overlay exactly and never adds Instagram references',async()=>{
  const d=data(),scope=structuredClone(manifest);
  scope.artists[0].accounts=[row('spotify','4',spotify)];
  scope.artists[0].account_ids=['4'];
  const f=fixtureQuery(d,{targetPlatform:'instagram',scope});
  const actual=await collectTargetPlatformMetadata(scope,{query:f.query,now:()=>at});
  d.accounts=d.accounts.filter(a=>a.platform!=='instagram');
  d.snapshots=[];
  assert.deepEqual(actual,buildMetadataOverlay(scope,d,at));
  assert.equal(f.seen.length,9);
});

test('Instagram reference survives supplemental export and outgoing YouTube request without becoming independent proof',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-target-catalog-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const f=fixtureQuery(data());
  const p=(await collectTargetPlatformMetadata(manifest,{targetPlatform:'youtube',query:f.query,now:()=>at})).packets[0];
  const source=dir+'/source';
  await fs.mkdir(source+'/metadata',{recursive:true});
  const original=JSON.stringify(p);
  await fs.writeFile(source+'/metadata/1.json',original);
  const result=await exportYoutubeCatalogEvidence(source,dir+'/supplemental',{now:()=>at,query:async sql=>{
    assert.ok(sql.startsWith('SELECT'));
    if(sql.includes('FROM new_vertical.account_snapshots')){
      assert.match(sql,/account_id IN \(3,4\)/);
      return [
        {account_id:'3',platform:'instagram',latest:['Our YouTube: '+youtube,'2026-11-10',at]},
        {account_id:'999',platform:'instagram',latest:['Our YouTube: '+youtube,'2026-11-10',at]},
        {account_id:'3',platform:'spotify',latest:['Our YouTube: '+youtube,'2026-11-10',at]},
      ];
    }
    return [];
  }});
  assert.equal(result.providerRequests,0);
  const [packet]=JSON.parse(await fs.readFile(dir+'/supplemental/packets.json','utf8'));
  assert.equal(packet.accountSnapshots.length,1);
  assert.deepEqual(packet.linkedAccounts,p.linkedAccounts);
  assert.equal(packet.baselineCatalogPacketSha256,evidenceDigest(p));
  const artist=youtubeArtistFromCatalogPacket(packet),candidate={url:youtube,title:'Synthetic',snippet:'',
    capture:normalizeYoutubeChannel({status:200,at,data:{success:true,
      channelId:'UCabcdefghijklmnopqrstuv',channel:youtube,name:'Synthetic Artist',description:'Musician'}},youtube)};
  const evidence=assembleYoutubeOwnershipEvidence(artist,packet,candidate);
  assert.equal(evidence.declarations.length,1);
  assert.equal(evidence.declarations[0].kind,'catalog_account_declaration');
  assert.equal(evidence.declarations[0].binding,'exact_catalog_account_id_not_independently_verified');
  assert.equal(evidence.declarations[0].accountId,'3');
  assert.equal(evidence.declarations[0].sourceUrl,ig);
  assert.equal(evidence.unavailable.officialSourcePageCaptures,true);
  assert.equal(evidence.contextOnly[0].kind,'profile_platform_snapshot_not_account_bound');
  const enriched={...artist,ownershipEvidence:evidence};
  const input=youtubeVerificationInput(enriched,candidate);
  const outgoing=youtubeDecisionRequest(input,{model:{
    endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13',maxRequestBytes:64000,
  }});
  assert.equal(outgoing.ready,true);
  assert.match(JSON.stringify(outgoing.request),/catalogReferenceProvenance/);
  assert.match(JSON.stringify(outgoing.request),/www\.instagram\.com\/syntheticartist/);
  assert.equal(evaluateYoutubeOwnership(enriched,candidate).reviewSuggestion,false);
  // The profile-level bio cannot supply a declaration without an account snapshot.
  packet.accountSnapshots=[];
  assert.equal(assembleYoutubeOwnershipEvidence(artist,packet,candidate).declarations.length,0);
  assert.equal(await fs.readFile(source+'/metadata/1.json','utf8'),original);
  await assert.rejects(exportYoutubeCatalogEvidence(source,dir+'/supplemental',{query:()=>{
    throw Error('Must not query when output exists');
  }}),/EEXIST/);
});
