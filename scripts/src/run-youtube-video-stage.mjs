// A fresh exact-request saved-video stage, never a campaign resume or an open-ended model approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,validateVideoStagePlan,approveVideoStage,assertVideoStageApproval,VIDEO_PARENT,archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {videoStageGate} from './youtube-video-stage-gate.mjs';
import {executeVideoStage,durableStageFile} from './youtube-video-stage-execution.mjs';
import {reconcileSavedVideoResponse} from './youtube-video-stage-recovery.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {eligibilitySql} from './run-youtube-campaign.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const sourceRunId='youtube-test-100-usd10-2026-11-12-tier-order';
const sourceRoot='generated-artifacts/'+sourceRunId;
function options(args){
  assert.ok(args.length&&args.every(x=>/^--(?:prepare-only|authorize-prepared|run-approved)$|^--(?:id|plan-sha256|approve-cents)=[a-zA-Z0-9-]+$/.test(x)));
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  const value=name=>args.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
  const id=value('id');assert.match(id??'',/^youtube-video-review-[a-z0-9-]{4,80}$/);
  const modes=args.filter(x=>['--prepare-only','--authorize-prepared','--run-approved'].includes(x));assert.equal(modes.length,1);
  return {id,root:'generated-artifacts/'+id,mode:modes[0],value};
}
function snapshotTime(row){
  const raw=String(row.snapshot_at);
  return new Date(Date.parse(raw.includes('T')?raw:raw.replace(' ','T')+'Z')).toISOString();
}
export async function currentEligible(artists){
  const rows=await select(eligibilitySql(artists.map(a=>a.profileId))),byId=new Map(rows.map(r=>[String(r.profile_id),r]));
  return new Map(artists.flatMap(a=>{
    const r=byId.get(a.profileId);if(!r||String(r.cm_artist)!==a.cmArtist)return [];
    const at=snapshotTime(r),age=Date.now()-Date.parse(at);
    if(age<0||age>36*3600000||![1,2,3,4,5].includes(Number(r.tier)))return [];
    return [[a.profileId,{...a,tier:Number(r.tier),snapshotAt:at}]];
  }));
}
async function prepare(o){
  assert.equal(o.value('approve-cents'),undefined);assert.equal(o.value('plan-sha256'),undefined);
  const parent=await read(sourceRoot+'/plan.json'),catalog=await read(sourceRoot+'/supplemental-catalog/packets.json');
  assert.equal(parent.id,sourceRunId);assert.equal(digest(catalog),parent.catalogEvidenceSha256);
  assert.equal((await read(sourceRoot+'/approval.json')).planSha256,digest(parent));
  assert.equal((await read(sourceRoot+'/summary.json')).status,'completed');
  const candidates=[];
  for(const a of parent.artists){
    const r=await read(sourceRoot+'/artists/'+a.profile_id+'.json');
    assert.equal(r.artist.profileId,a.profile_id);assert.equal(r.artist.cmArtist,a.cm_artist);
    if(r.candidates.length)continue; // Recovery cohort, not cherry-picked known positives.
    const raw=await fs.readFile(sourceRoot+'/receipts/'+archivedSearchReceiptName(a.profile_id));
    const receipt=JSON.parse(raw);
    assert.equal(receipt.operationKey,'search-'+a.profile_id+'-0');assert.equal(receipt.kind,'search');
    assert.equal(receipt.status,200);assert.equal(receipt.inputSha256,digest(receipt.request));
    assert.ok(Array.isArray(receipt.data?.organic));
    const videoPlan=planVideoDiscovery(r.artist,receipt.data.organic,{
      receiptSha256:digest(raw),archivePath:sourceRoot+'/receipts/'+archivedSearchReceiptName(a.profile_id)});
    if(!videoPlan.resolutionQueue.length)continue;
    const packet=catalog.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist);assert.ok(packet);
    candidates.push({artist:r.artist,sourceArtist:a,sourceSearchReceipt:receipt,
      sourceSearchReceiptBytesBase64:raw.toString('base64'),catalogPacket:packet,videoPlan});
  }
  assert.ok(candidates.length>=20,'Not enough eligible saved-video cases');
  const eligible=await currentEligible(candidates.map(c=>({profileId:c.artist.profileId,
    cmArtist:c.artist.cmArtist,name:c.artist.name})));
  const chosen=candidates.filter(c=>eligible.has(c.artist.profileId)).sort((a,b)=>
    eligible.get(a.artist.profileId).tier-eligible.get(b.artist.profileId).tier
      ||a.sourceArtist.ordinal-b.sourceArtist.ordinal).slice(0,20);
  assert.equal(chosen.length,20,'Need 20 currently active Tier 1–5 artists missing catalog YouTube links');
  const pool=await connectSavedBatchPool();
  try{
    assert.equal((await pool.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[VIDEO_PARENT])).rows[0]?.status,'stopped');
    assert.equal((await pool.query("SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'")).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'")).rows[0].n,0);
    const saved=(await pool.query(`SELECT operation_key,profile_id,input_sha256,receipt_sha256,status,http_status
      FROM youtube_bounded_test_admissions WHERE run_id=$1 AND kind='search'`,[sourceRunId])).rows;
    for(const c of chosen){
      const receipt=c.sourceSearchReceipt,admission=saved.find(a=>a.operation_key===receipt.operationKey
        &&a.profile_id===c.artist.profileId);
      assert.ok(admission&&admission.status==='returned'&&admission.http_status===200
        &&admission.input_sha256===receipt.inputSha256&&admission.receipt_sha256===digest(receipt),
      'Saved search must match its acknowledged original paid receipt');
    }
  }finally{await pool.end();}
  await fs.mkdir(o.root);
  for(const d of ['evidence','receipts','results','inputs'])await fs.mkdir(o.root+'/'+d);
  const evidenceFiles={};
  const writeEvidence=async(name,value)=>{
    const bytes=JSON.stringify(value);await durableStageFile(o.root+'/'+name,bytes);evidenceFiles[name]=digest(bytes);
  };
  await writeEvidence('evidence/source-plan.json',parent);
  for(const c of chosen)await writeEvidence('evidence/'+c.artist.profileId+'.json',c);
  const modules=await freezeLocalModules(fileURLToPath(import.meta.url),o.root+'/runtime'),runtimeFiles={};
  for(const name of modules){const relative='runtime/'+path.basename(name);runtimeFiles[relative]=digest(await fs.readFile(o.root+'/'+relative));}
  const plan=videoStagePlan({id:o.id,preparedAt:new Date().toISOString(),sourceRunId,sourcePlanSha256:digest(parent),
    artists:chosen.map(c=>eligible.get(c.artist.profileId)),
    operations:chosen.flatMap(c=>c.videoPlan.resolutionQueue.map(v=>({
      ...v.operation,profileId:c.artist.profileId,cmArtist:c.artist.cmArtist,videoId:v.videoId,videoUrl:v.url}))),
    evidenceFiles,runtimeFiles});
  await durableStageFile(o.root+'/plan.json',JSON.stringify(plan,null,2));
  const columns=['artist','tier','profile_id','cm_artist','video_url','saved_video_title','role_hint','saved_search_result_index'];
  const rows=chosen.flatMap(c=>c.videoPlan.resolutionQueue.map(v=>[c.artist.name,eligible.get(c.artist.profileId).tier,
    c.artist.profileId,c.artist.cmArtist,v.url,v.sources[0].title,v.sources[0].roleHint,v.sources[0].resultIndex]));
  const cell=x=>{let s=String(x);if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  await durableStageFile(o.root+'/proposed-video-test-cohort.csv','\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  console.log(JSON.stringify({status:'prepared_not_approved',id:o.id,artists:plan.artists.length,
    videoRequests:plan.maximumCalls,maximumUsd:plan.maximumSpendCents/100,tiers:plan.artists.map(a=>a.tier),
    planSha256:digest(plan),paidCalls:0,nextStageApprovalRequired:true}));
}
async function frozen(o,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(o.root,'runtime'),'Use sealed runtime');
  validateVideoStagePlan(plan);assert.equal(plan.id,o.id);
  assert.equal(digest(await read(o.root+'/evidence/source-plan.json')),plan.sourcePlanSha256);
  for(const [name,hash] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(o.root+'/'+name)),hash,'Frozen evidence or runtime changed');
}
async function main(){
  const o=options(process.argv.slice(2));
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only test stage');
  if(o.mode==='--prepare-only')return prepare(o);
  const plan=await read(o.root+'/plan.json');await frozen(o,plan);
  if(o.mode==='--authorize-prepared'){
    const approval=approveVideoStage(plan,{expectedPlanSha256:o.value('plan-sha256'),
      capCents:Number(o.value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(o.root+'/approval.json',JSON.stringify(approval,null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0,id:o.id}));return;
  }
  assert.equal(o.value('approve-cents'),undefined);assert.equal(o.value('plan-sha256'),undefined);
  const approval=await read(o.root+'/approval.json');assertVideoStageApproval(plan,approval);
  const eligible=await currentEligible(plan.artists);
  assert.ok(plan.artists.every(a=>eligible.get(a.profileId)?.tier===a.tier),'Eligibility changed; prepare a fresh plan without spending');
  const pool=await connectSavedBatchPool(),owner=randomUUID();
  const gate=videoStageGate({pool,plan,approval,owner});
  try{
    if(plan.recovery){
      await frozen(o,plan);
      const recovery=await reconcileSavedVideoResponse({pool,plan,approval,root:o.root});
      console.log(JSON.stringify(recovery));
    }
    await executeVideoStage({plan,approval,root:o.root,gate,credential:process.env.SCRAPECREATORS_API_KEY,
      assertFrozen:async()=>{
        await frozen(o,plan);
        assert.equal(digest(await read(o.root+'/plan.json')),digest(plan));
        assert.equal(digest(await read(o.root+'/approval.json')),digest(approval));
      }});
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
