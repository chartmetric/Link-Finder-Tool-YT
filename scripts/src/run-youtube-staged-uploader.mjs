// Fresh exact uploader stage for the completed twenty-artist staged search.
// Preparation is read-only; no search/capture/model authority is inherited.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {buildSavedFallback} from './prepare-youtube-saved-fallback.mjs';
import {inspectFallback} from './prepare-youtube-fallback-preflight.mjs';
import {SMALL_VIDEO_STAGE_POLICY,videoStagePlan,validateVideoStagePlan,
  approveVideoStage,assertVideoStageApproval,archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile,executeVideoStage} from './youtube-video-stage-execution.mjs';
import {videoStageGate} from './youtube-video-stage-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

const sourceRoot='generated-artifacts/youtube-test-20-staged-2026-11-13';
const stageId='youtube-video-review-staged-twenty-2026-11-13';
const read=async p=>JSON.parse(await fs.readFile(p));
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';};

export async function prepareStagedUploaders(id,{inspect=inspectFallback}={}){
  assert.equal(id,stageId);
  const proposal=await buildSavedFallback(sourceRoot,{includeDirectChannelCases:true});
  const preflight=await inspect({sourceRoot,includeDirectChannelCases:true});
  assert.deepEqual(preflight.blockers,[]);
  assert.deepEqual(preflight.operations,proposal.operations);
  assert.equal(preflight.artists.length,15);assert.equal(proposal.operations.length,26);
  const sourcePlan=await read(sourceRoot+'/plan.json');
  const root='generated-artifacts/'+id;
  await fs.mkdir(root);
  for(const dir of ['evidence','inputs','receipts','results'])await fs.mkdir(root+'/'+dir);
  const evidenceFiles={};
  const save=async(name,value)=>{
    const bytes=JSON.stringify(value);
    await durableStageFile(root+'/'+name,bytes);evidenceFiles[name]=digest(bytes);
  };
  await save('evidence/source-plan.json',sourcePlan);
  await save('evidence/preflight.json',preflight);
  await save('evidence/fallback-proposal.json',proposal);
  // Preserve all direct alternatives, including artists with no video request.
  await save('evidence/direct-search-leads.json',await Promise.all(sourcePlan.artists.map(async a=>{
    const record=await read(sourceRoot+'/artists/'+a.profile_id+'.json');
    return {profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
      candidates:record.candidates,topicCandidates:record.topicCandidates,
      ownershipAccepted:false};
  })));
  for(const c of proposal.cases.filter(c=>c.resolutionQueue.length)){
    const record=await read(sourceRoot+'/artists/'+c.profileId+'.json');
    const catalogPacket=sourcePlan.packets.find(p=>p.profileId===c.profileId&&p.cmArtist===c.cmArtist);
    const raw=await fs.readFile(sourceRoot+'/receipts/'+archivedSearchReceiptName(c.profileId));
    await save('evidence/'+c.profileId+'.json',{artist:record.artist,videoPlan:catalogVideoPlan(c),
      catalogPacket,sourceArtist:sourcePlan.artists.find(a=>a.profile_id===c.profileId),
      sourceSearchReceipt:JSON.parse(raw),sourceSearchReceiptBytesBase64:raw.toString('base64')});
  }
  for(const [name,sha] of Object.entries(proposal.sourceFiles))
    assert.equal(digest(await fs.readFile(sourceRoot+'/'+name)),sha);
  const modules=await freezeLocalModules(fileURLToPath(import.meta.url),root+'/runtime'),runtimeFiles={};
  for(const file of modules){
    const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));
  }
  const plan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id,preparedAt:new Date().toISOString(),
    sourceRunId:sourcePlan.id,sourcePlanSha256:digest(sourcePlan),artists:preflight.artists,
    operations:proposal.operations,evidenceFiles,runtimeFiles});
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const rows=plan.operations.map(o=>{
    const a=plan.artists.find(a=>a.profileId===o.profileId);
    const c=proposal.cases.find(c=>c.profileId===o.profileId);
    const v=c.resolutionQueue.find(v=>v.videoId===o.videoId);
    return [a.name,a.tier,o.profileId,o.cmArtist,o.videoUrl,v.sources[0].title,
      v.sources[0].roleHint,2,'Uploader discovery only — artist ownership not approved'];
  });
  await durableStageFile(root+'/proposed-uploader-test.csv','\ufeff'+[
    ['artist','tier','profile_id','cm_artist','video_url','saved_title','role_hint','reservation_cents','status'],
    ...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  return {status:'prepared_not_approved',id,artists:15,requests:26,maximumUsd:.52,
    planSha256:digest(plan),paidCalls:0,laterIdentityApprovalRequired:true};
}
// Strip proposal-only fields so the exact original video plan can be verified
// by the independent downstream identity source verifier.
export function catalogVideoPlan(c){
  const {artist,tier,sourceOrdinal,...plan}=c;
  return plan;
}
export async function assertStagedUploaderFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  validateVideoStagePlan(plan);assert.equal(plan.id,stageId);
  assert.equal(plan.version,SMALL_VIDEO_STAGE_POLICY);
  assert.equal(plan.artists.length,15);assert.equal(plan.maximumCalls,26);
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(root+'/'+name)),sha,'Frozen evidence/runtime changed');
  assert.equal(digest(await read(root+'/evidence/source-plan.json')),plan.sourcePlanSha256);
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:prepare-only|authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--prepare-only','--authorize-prepared','--run-approved'].includes(a));
  assert.equal(modes.length,1);
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  const id=value('id');assert.equal(id,stageId);
  if(modes[0]==='--prepare-only'){
    assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
    console.log(JSON.stringify(await prepareStagedUploaders(id)));return;
  }
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');
  await assertStagedUploaderFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveVideoStage(plan,{expectedPlanSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');assertVideoStageApproval(plan,approval);
  const eligible=await currentEligible(plan.artists);
  assert.ok(plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Eligibility changed');
  // Fresh read-only checks before the gate performs locked launch/admissions.
  const preflight=await inspectFallback({sourceRoot,includeDirectChannelCases:true});
  assert.deepEqual(preflight.blockers,[]);
  assert.deepEqual(preflight.operations.map(o=>({...o,inputSha256:digest(o.request)})),plan.operations);
  const pool=await connectSavedBatchPool();
  try{
    const gate=videoStageGate({pool,plan,approval,owner:randomUUID()});
    await executeVideoStage({root,plan,approval,gate,credential:process.env.SCRAPECREATORS_API_KEY,
      assertFrozen:async()=>{
        await assertStagedUploaderFrozen(root,plan);
        assert.equal(digest(await read(root+'/approval.json')),digest(approval));
      }});
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
