import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest,planVideoDiscovery,videoMentionHold} from './youtube-video-discovery-offline.mjs';
import {buildSavedFallback,writeSavedFallback} from './prepare-youtube-saved-fallback.mjs';
const artist={profileId:'3933589',cmArtist:'16285537',name:'KAIVA'};
const provenance={receiptSha256:'a'.repeat(64),archivePath:'saved/search.json'};
const hit=(id,title,snippet='')=>({link:'https://www.youtube.com/watch?v='+id,title,snippet});
const topic=hit('ixf9LfSYeFo','Too Rich',
  'Provided to YouTube by Music For People Too Rich · KAIVA Too Rich ℗ 2026 MFP Released on: 2026-09-11 Main Artist: KAIVA Producer: Matteo ...');
test('explicit Main Artist credit rescues KAIVA distribution lead without matching other performers',()=>{
  assert.equal(videoMentionHold(artist,topic),null);
  for(const credit of ['KAIVA VE OAPA','NOT KAIVA','KAIVAX']){
    assert.equal(videoMentionHold(artist,{...topic,snippet:topic.snippet.replace('Main Artist: KAIVA','Main Artist: '+credit)}),
      'distribution_credits_do_not_match_catalog_name');
  }
  assert.equal(videoMentionHold(artist,hit('PyOJMV8i_w0','Iki Oa',
    'Provided to YouTube by Ditto Music Iki Oa · KAIVA VE OAPA Kevaro Eravo')),
    'distribution_credits_do_not_match_catalog_name');
});
test('collaboration credit and distribution lead share two slots; unrelated film hits stay held',()=>{
  const p=planVideoDiscovery(artist,[
    hit('B7sjyhQGIH4','Tom Right, KAIVA - LEFT 2 RIGHT (Official Video)'),
    hit('zuG8bSz1ItY','KAIVA - Too Rich'),topic,
    hit('zU17xoFebqg','Kaiva Audio Jukebox | Ajaneesh Loknath',
      'collection of songs from the film KAIVA')],provenance);
  assert.deepEqual(p.resolutionQueue.map(v=>v.videoId),['B7sjyhQGIH4','ixf9LfSYeFo']);
  assert.equal(p.deferredVideos[0].videoId,'zuG8bSz1ItY');
  assert.equal(p.videoClues.at(-1).eligible,false);
  assert.equal(p.executable,false);assert.equal(p.verifiedMatches,0);
  assert.ok(p.videoClues.every(v=>v.ownershipEvidence===false));
});
async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-fallback-'));
  await fs.mkdir(root+'/source');await fs.mkdir(root+'/source/artists');await fs.mkdir(root+'/source/receipts');
  const search={q:'"KAIVA" musician YouTube',num:10};
  const artists=[{profile_id:artist.profileId,cm_artist:artist.cmArtist,artist:artist.name,tier:2,ordinal:1}];
  const plan={id:'fixture-only',artists,scopeSha256:digest(artists)};
  const request={method:'POST',url:'https://google.serper.dev/search',body:search};
  const files={
    'plan.json':plan,'approval.json':{planSha256:digest(plan),explicitApproval:true},
    'summary.json':{id:plan.id,status:'completed'},
    ['artists/'+artist.profileId+'.json']:{artist,candidates:[],searchPlan:{
      profileId:artist.profileId,cmArtist:artist.cmArtist,request:search}},
    'receipts/search.json':{kind:'search',operationKey:'search-'+artist.profileId+'-0',
      status:200,parseFailed:false,request,inputSha256:digest(request),data:{organic:[topic]}}
  };
  for(const [name,value] of Object.entries(files))await fs.writeFile(root+'/source/'+name,JSON.stringify(value));
  return {root,files,source:root+'/source'};
}
test('offline preparation preserves source bytes, retains evidence, and cannot inherit paid approval',async()=>{
  const f=await fixture();
  try{
    const p=await writeSavedFallback(f.source,f.root+'/proposal');
    assert.equal(p.maximumUploaderRequests,1);
    assert.equal(p.proposedUploaderReservationCents,2);
    for(const key of ['explicitApproval','executable','inheritsPriorApproval'])assert.equal(p[key],false);
    for(const key of ['paidCalls','catalogWrites','acceptedLinks'])assert.equal(p[key],0);
    assert.equal(p.requiresCoordinatorNonReplayCheck,true);
    assert.equal(p.requiresEligibilityRecheck,true);
    assert.equal(p.requiresSeparateIdentityApproval,true);
    for(const [name,value] of Object.entries(f.files))
      assert.equal(await fs.readFile(f.source+'/'+name,'utf8'),JSON.stringify(value));
    assert.match(await fs.readFile(f.root+'/proposal/fallback-evidence.csv','utf8'),/Not checked/);
    await assert.rejects(writeSavedFallback(f.source,f.root+'/proposal'),{code:'EEXIST'});
    await assert.rejects(writeSavedFallback(f.source,f.source+'/nested'));
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('wrong artist binding, altered request or duplicate paid-search receipts block preparation',async()=>{
  for(const mutation of ['binding','request','duplicate']){
    const f=await fixture();
    try{
      if(mutation==='binding'){
        const file=f.source+'/artists/'+artist.profileId+'.json';
        const r=JSON.parse(await fs.readFile(file));r.artist.cmArtist='1';await fs.writeFile(file,JSON.stringify(r));
      }else if(mutation==='request'){
        const r=f.files['receipts/search.json'];r.request.body.q='different';
        await fs.writeFile(f.source+'/receipts/search.json',JSON.stringify(r));
      }else await fs.copyFile(f.source+'/receipts/search.json',f.source+'/receipts/duplicate.json');
      await assert.rejects(buildSavedFallback(f.source));
    }finally{await fs.rm(f.root,{recursive:true,force:true});}
  }
});
