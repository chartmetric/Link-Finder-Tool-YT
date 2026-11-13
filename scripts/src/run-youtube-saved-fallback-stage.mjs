// Fresh bounded uploader-only stage. Never resumes a prior run or identity check.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {buildSavedFallback} from './prepare-youtube-saved-fallback.mjs';
import {inspectFallback} from './prepare-youtube-fallback-preflight.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {SMALL_VIDEO_STAGE_POLICY,videoStagePlan,validateVideoStagePlan,
  approveVideoStage,assertVideoStageApproval,archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {videoStageGate} from './youtube-video-stage-gate.mjs';
import {executeVideoStage,durableStageFile} from './youtube-video-stage-execution.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

const sourceRoot='generated-artifacts/youtube-test-20-precision-2026-11-12';
const priorProposalRoot='generated-artifacts/youtube-saved-fallback-2026-11-12';
const read=async p=>JSON.parse(await fs.readFile(p));
export async function prepareSavedFallbackStage(id,{inspect=inspectFallback}={}){
  assert.match(id,/^youtube-video-review-[a-z0-9-]{4,80}$/);
  const root='generated-artifacts/'+id;
  const prior=await read(priorProposalRoot+'/proposal.json');
  const proposal=await buildSavedFallback(sourceRoot);
  assert.deepEqual(proposal.operations,prior.operations,'Saved eight-request scope changed');
  assert.equal(proposal.maximumUploaderRequests,8);assert.equal(proposal.artistsWithEligibleVideos,5);
  const preflight=await inspect({sourceRoot});
  assert.deepEqual(preflight.blockers,[],'Eligibility or paid-work state blocks preparation');
  assert.deepEqual(preflight.operations,proposal.operations);
  assert.equal(preflight.artists.length,5);
  await fs.mkdir(root); // Never replace an existing preparation or paid archive.
  for(const dir of ['evidence','inputs','receipts','results'])await fs.mkdir(root+'/'+dir);
  const evidenceFiles={};
  const save=async(name,value)=>{
    const text=JSON.stringify(value);await durableStageFile(root+'/'+name,text);evidenceFiles[name]=digest(text);
  };
  const sourcePlan=await read(sourceRoot+'/plan.json');
  assert.equal(digest(sourcePlan),proposal.sourcePlanSha256);
  const catalog=await read(sourceRoot+'/supplemental-catalog/packets.json');
  assert.equal(digest(catalog),sourcePlan.catalogEvidenceSha256);
  await save('evidence/source-plan.json',sourcePlan);
  await save('evidence/preflight.json',preflight);
  await save('evidence/fallback-proposal.json',proposal);
  for(const c of proposal.cases.filter(c=>c.resolutionQueue.length)){
    const sourceRecord=await read(sourceRoot+'/artists/'+c.profileId+'.json');
    assert.equal(sourceRecord.artist.profileId,c.profileId);
    assert.equal(sourceRecord.artist.cmArtist,c.cmArtist);
    const catalogPacket=catalog.find(p=>p.profileId===c.profileId&&p.cmArtist===c.cmArtist);
    assert.ok(catalogPacket);
    assert.deepEqual(youtubeArtistFromCatalogPacket(catalogPacket),sourceRecord.artist);
    const archivePath=sourceRoot+'/receipts/'+archivedSearchReceiptName(c.profileId);
    const searchBytes=await fs.readFile(archivePath),sourceSearchReceipt=JSON.parse(searchBytes);
    const videoPlan=planVideoDiscovery(sourceRecord.artist,sourceSearchReceipt.data.organic,
      {archivePath,receiptSha256:digest(searchBytes)});
    assert.deepEqual(videoPlan.resolutionQueue,c.resolutionQueue);
    await save('evidence/'+c.profileId+'.json',{artist:sourceRecord.artist,videoPlan,catalogPacket,
      sourceArtist:sourcePlan.artists.find(a=>a.profile_id===c.profileId),
      sourceSearchReceipt,sourceSearchReceiptBytesBase64:searchBytes.toString('base64')});
  }
  for(const [name,sha] of Object.entries(proposal.sourceFiles))
    assert.equal(digest(await fs.readFile(sourceRoot+'/'+name)),sha);
  const modules=await freezeLocalModules(fileURLToPath(import.meta.url),root+'/runtime');
  const runtimeFiles={};
  for(const file of modules){
    const relative='runtime/'+path.basename(file);
    runtimeFiles[relative]=digest(await fs.readFile(root+'/'+relative));
  }
  const plan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id,
    preparedAt:new Date().toISOString(),sourceRunId:proposal.sourceRunId,
    sourcePlanSha256:proposal.sourcePlanSha256,artists:preflight.artists,
    operations:proposal.operations,evidenceFiles,runtimeFiles});
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';};
  const rows=plan.operations.map(o=>{
    const artist=plan.artists.find(a=>a.profileId===o.profileId);
    const c=proposal.cases.find(c=>c.profileId===o.profileId);
    const clue=c.resolutionQueue.find(v=>v.videoId===o.videoId);
    return [artist.name,artist.tier,o.profileId,o.cmArtist,o.videoUrl,
      clue.sources[0].title,clue.sources[0].roleHint,2,'Discovery only — ownership unapproved'];
  });
  await durableStageFile(root+'/proposed-uploader-test.csv','\ufeff'+[
    ['artist','tier','profile_id','cm_artist','video_url','saved_title','role_hint','reservation_cents','status'],
    ...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  return {status:'prepared_not_approved',id,artists:plan.artists.length,requests:plan.maximumCalls,
    maximumUsd:plan.maximumSpendCents/100,planSha256:digest(plan),paidCalls:0};
}
export async function assertSavedFallbackFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use the sealed runner');
  validateVideoStagePlan(plan);assert.equal(plan.version,SMALL_VIDEO_STAGE_POLICY);
  assert.equal(plan.maximumCalls,8);assert.equal(plan.artists.length,5);
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(root+'/'+name)),sha,'Frozen plan evidence or runtime changed');
  assert.equal(digest(await read(root+'/evidence/source-plan.json')),plan.sourcePlanSha256);
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only bounded test');
  const args=process.argv.slice(2);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:prepare-only|authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--prepare-only','--authorize-prepared','--run-approved'].includes(a));
  assert.equal(modes.length,1);
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  const id=value('id');assert.match(id??'',/^youtube-video-review-[a-z0-9-]{4,80}$/);
  const root='generated-artifacts/'+id;
  if(modes[0]==='--prepare-only'){
    assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
    console.log(JSON.stringify(await prepareSavedFallbackStage(id)));return;
  }
  const plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertSavedFallbackFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveVideoStage(plan,{expectedPlanSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0,id}));return;
  }
  assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
  const approval=await read(root+'/approval.json');assertVideoStageApproval(plan,approval);
  const eligible=await currentEligible(plan.artists);
  assert.ok(plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Eligibility changed');
  const pool=await connectSavedBatchPool();
  try{
    const gate=videoStageGate({pool,plan,approval,owner:randomUUID()});
    await executeVideoStage({root,plan,approval,gate,credential:process.env.SCRAPECREATORS_API_KEY,
      assertFrozen:async()=>{
        await assertSavedFallbackFrozen(root,plan);
        assert.equal(digest(await read(root+'/approval.json')),digest(approval));
      }});
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
