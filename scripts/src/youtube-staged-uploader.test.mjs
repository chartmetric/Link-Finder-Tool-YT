import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {stagedSearchPlan,approveStagedSearch} from './youtube-staged-search-plan.mjs';
import {buildSavedFallback} from './prepare-youtube-saved-fallback.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';
import {archivedSearchReceiptName,videoStagePlan,SMALL_VIDEO_STAGE_POLICY,
  approveVideoStage,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {catalogVideoPlan} from './run-youtube-staged-uploader.mjs';

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-staged-uploaders-'));
  for(const dir of ['artists','receipts','evidence','runtime'])await fs.mkdir(root+'/'+dir);
  const artists=Array.from({length:20},(_,i)=>({
    profile_id:String(i+1),cm_artist:String(i+101),artist:'Fixture Artist '+i,tier:2,
    ordinal:i,snapshot_at:'2026-11-13 01:30:18',
  }));
  const packets=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
    catalogProfile:{profile_id:a.profile_id,cm_artist:a.cm_artist},linkedAccounts:[],releases:[],catalogTracks:[]}));
  const catalog=JSON.stringify(packets),runtime='// Frozen fixture runtime, never executed';
  await fs.writeFile(root+'/evidence/catalog.json',catalog);
  await fs.writeFile(root+'/runtime/run.mjs',runtime);
  const plan=stagedSearchPlan({id:'youtube-test-uploader-fixture',preparedAt:'2026-11-13T19:00:00Z',
    artists,packets,evidenceFiles:{'evidence/catalog.json':digest(catalog)},
    runtimeFiles:{'runtime/run.mjs':digest(runtime)}});
  const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value));
  await save('plan.json',plan);
  await save('approval.json',approveStagedSearch(plan,{expectedPlanSha256:digest(plan),
    capCents:40,approvedAt:'2026-11-13T19:01:00Z'}));
  await save('summary.json',{id:plan.id,status:'completed',artistsSearched:20,reservedCents:40,
    searchOnly:true,catalogWrites:0});
  for(const [i,a] of artists.entries()){
    const artist=youtubeArtistFromCatalogPacket(packets[i]),searchPlan=youtubeSearchPlan(artist);
    const op=plan.operations[i],receipt={kind:'search',operationKey:op.key,status:200,parseFailed:false,
      request:op.request,inputSha256:op.inputSha256,data:{organic:i<2?[{
        link:'https://www.youtube.com/watch?v=v'+String(i).padStart(10,'0'),
        title:a.artist+' - Official Music',snippet:'Music by '+a.artist}]:[]}};
    const file='receipts/'+archivedSearchReceiptName(a.profile_id),raw=JSON.stringify(receipt);
    await fs.writeFile(root+'/'+file,raw);
    const videoPlan=planVideoDiscovery(artist,receipt.data.organic,{archivePath:root+'/'+file,receiptSha256:digest(raw)});
    await save('artists/'+a.profile_id+'.json',{artist,searchPlan,videoPlan,
      candidates:i<2?[{url:'https://www.youtube.com/@fixture'+i}]:[]});
  }
  return {root,save,plan};
}
test('staged uploader preparation preserves video alternatives even with direct channel leads',async()=>{
  const f=await fixture();
  try{
    const legacy=await buildSavedFallback(f.root);
    assert.equal(legacy.maximumUploaderRequests,0,'Legacy missing-direct-only behavior stays unchanged');
    const p=await buildSavedFallback(f.root,{includeDirectChannelCases:true});
    assert.equal(p.sourceArtists,20);assert.equal(p.artistsWithEligibleVideos,2);
    assert.equal(p.operations.length,2);assert.equal(p.proposedUploaderReservationCents,4);
    assert.equal(p.inheritsPriorApproval,false);assert.equal(p.explicitApproval,false);
    for(const c of p.cases){
      const saved=JSON.parse(await fs.readFile(f.root+'/artists/'+c.profileId+'.json'));
      assert.deepEqual(catalogVideoPlan(c),saved.videoPlan);
    }
    assert.equal(p.sourceFiles['runtime/run.mjs'],f.plan.runtimeFiles['runtime/run.mjs']);
    const stage=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id:'youtube-video-review-fixture-fresh',
      sourceRunId:p.sourceRunId,sourcePlanSha256:p.sourcePlanSha256,preparedAt:'2026-11-13T19:05:00Z',
      artists:p.cases.filter(c=>c.resolutionQueue.length).map(c=>({
        profileId:c.profileId,cmArtist:c.cmArtist,name:c.artist,tier:c.tier,snapshotAt:'2026-11-13T01:30:18Z'})),
      operations:p.operations,evidenceFiles:{'evidence/source.json':digest(p)},runtimeFiles:f.plan.runtimeFiles});
    assert.throws(()=>assertVideoStageApproval(stage,JSON.parse('{}')));
    const approved=approveVideoStage(stage,{expectedPlanSha256:digest(stage),capCents:4,approvedAt:'2026-11-13T19:06:00Z'});
    assertVideoStageApproval(stage,approved);
    assert.equal(approved.operationScope,'video_uploader_only_exact_saved_requests');
    assert.equal(stage.unknownDownstreamRequestsApproved,false);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('changed source identity, saved selection, request, approval or sealed runtime fail closed',async()=>{
  for(const kind of ['identity','selection','request','approval','runtime','incomplete']){
    const f=await fixture();
    try{
      if(kind==='runtime')await fs.writeFile(f.root+'/runtime/run.mjs','changed runtime');
      else if(kind==='incomplete')await f.save('summary.json',{id:f.plan.id,status:'stopped'});
      else if(kind==='approval'){
        const a=JSON.parse(await fs.readFile(f.root+'/approval.json'));a.userCapCents=200;
        await f.save('approval.json',a);
      }else if(kind==='request'){
        const name='receipts/'+archivedSearchReceiptName('1');
        const r=JSON.parse(await fs.readFile(f.root+'/'+name));r.request.body.q='another artist';
        r.inputSha256=digest(r.request);await f.save(name,r);
      }else{
        const name='artists/1.json',a=JSON.parse(await fs.readFile(f.root+'/'+name));
        if(kind==='identity')a.artist.name='Unbound name';
        else a.videoPlan.resolutionQueue=[];
        await f.save(name,a);
      }
      await assert.rejects(buildSavedFallback(f.root,{includeDirectChannelCases:true}));
    }finally{await fs.rm(f.root,{recursive:true,force:true});}
  }
});
