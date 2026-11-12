import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage,assertVideoStageAdmission,archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {executeVideoStage} from './youtube-video-stage-execution.mjs';

const sha=digest('fixture');
test('saved receipt lookup retains the original JSON-string hash convention',()=>{
  assert.equal(archivedSearchReceiptName('4152653'),'663436bc18291bb5f50a9e2401b900f1633e88010cd332fc6aa9bc672feb94ff.json');
});
function fixture(){
  const artists=Array.from({length:20},(_,i)=>({profileId:String(i+1),cmArtist:String(i+101),
    name:'Artist '+(i+1),tier:2,snapshotAt:'2026-11-12T01:30:00Z'}));
  const operations=artists.flatMap((a,i)=>[0,1].map(j=>{
    const videoId=String(i*2+j+1).padStart(11,'0'),videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {...a,kind:'video_uploader',key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,
      videoId,videoUrl,request:proposedUploaderRequest(videoUrl)};
  }));
  const plan=videoStagePlan({id:'youtube-video-review-fixture-20',sourceRunId:'saved-fixture',
    sourcePlanSha256:sha,preparedAt:'2026-11-12T06:00:00Z',artists,operations,
    evidenceFiles:{'evidence/source-plan.json':sha},runtimeFiles:{'runtime/test.mjs':sha}});
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:80,approvedAt:'2026-11-12T06:01:00Z'});
  const run={id:plan.id,owner:'fixture-owner',status:'running',plan_sha256:digest(plan),
    approval_sha256:digest(approval),cap_cents:80,reserved_cents:0};
  return {plan,approval,run};
}
const returned=op=>({operation_key:op.key,profile_id:op.profileId,cm_artist:op.cmArtist,
  video_id:op.videoId,input_sha256:op.inputSha256,status:'returned',http_status:200,
  receipt_sha256:sha,raw_sha256:sha});
test('exact saved-video scope has no inherited, dynamic, metadata or model spending approval',()=>{
  const {plan,approval}=fixture();
  assert.equal(plan.maximumCalls,40);assert.equal(plan.maximumSpendCents,80);
  assert.equal(plan.unknownDownstreamRequestsApproved,false);assert.deepEqual(plan.allowedKinds,['video_uploader']);
  assert.equal(plan.explicitApproval,false);
  assert.throws(()=>approveVideoStage(plan,{expectedPlanSha256:sha,capCents:80,approvedAt:approval.approvedAt}));
  assert.throws(()=>approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:200,approvedAt:approval.approvedAt}));
  for(const mutate of [
    p=>p.operations[0].request.url+='&cache_max_age=30',
    p=>p.operations[0].kind='metadata',
    p=>p.operations[0].videoId='aaaaaaaaaaa',
    p=>p.operations[0].cmArtist='999',
    p=>p.operations.push(p.operations[0]),
    p=>p.artists[0].tier=0,
    p=>p.artists[1].profileId=p.artists[0].profileId,
    p=>p.maximumSpendCents=100,
    p=>p.evidenceFiles={'../outside':sha},
  ]){
    const changed=structuredClone(plan);mutate(changed);
    assert.throws(()=>approveVideoStage(changed,{expectedPlanSha256:digest(changed),capCents:changed.maximumSpendCents,
      approvedAt:approval.approvedAt}));
  }
});
test('admission fences exact owner, approval, request, non-replay, receipts and all 40 reservations',()=>{
  const {plan,approval,run}=fixture(),history=[];
  for(const op of plan.operations){
    assertVideoStageAdmission(plan,approval,run,op,history,'fixture-owner');
    history.push(returned(op));run.reserved_cents+=2;
  }
  assert.equal(run.reserved_cents,80);
  assert.throws(()=>assertVideoStageAdmission(plan,approval,run,plan.operations[0],history,'fixture-owner'));
  const f=fixture(),op=f.plan.operations[0];
  for(const changed of [{...f.run,owner:'lost'},{...f.run,status:'stopped'},{...f.run,cap_cents:200},
    {...f.run,plan_sha256:sha},{...f.run,approval_sha256:sha},{...f.run,reserved_cents:2}])
    assert.throws(()=>assertVideoStageAdmission(f.plan,f.approval,changed,op,[],'fixture-owner'));
  const h=returned(op);
  for(const bad of [{...h,status:'admitted'},{...h,http_status:404},{...h,raw_sha256:'bad'},
    {...h,input_sha256:sha},{...h,profile_id:'999'}])
    assert.throws(()=>assertVideoStageAdmission(f.plan,f.approval,{...f.run,reserved_cents:2},
      f.plan.operations[1],[bad],'fixture-owner'));
  assert.throws(()=>assertVideoStageAdmission(f.plan,f.approval,f.run,{...op,kind:'search'},[],'fixture-owner'));
});
async function executionFixture(t){
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'yt-video-stage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['evidence','inputs','receipts','results'])await fs.mkdir(root+'/'+dir);
  for(const artist of f.plan.artists){
    const clues=f.plan.operations.filter(op=>op.profileId===artist.profileId).map(op=>({
      ...op,url:op.videoUrl,sources:[],operation:{kind:op.kind,key:op.key,request:op.request}}));
    await fs.writeFile(root+'/evidence/'+artist.profileId+'.json',JSON.stringify({artist,videoPlan:{resolutionQueue:clues}}));
  }
  const history=[],events=[];
  const gate={
    async start(){events.push('start');},
    async admit(op){
      assertVideoStageAdmission(f.plan,f.approval,f.run,op,history,'fixture-owner');
      history.push({...returned(op),status:'admitted',http_status:null});
      f.run.reserved_cents+=2;events.push('admit');
    },
    async returned(op,receiptSha,rawSha){
      const raw=await fs.readFile(root+'/receipts/'+digest(op.key)+'.raw');
      assert.equal(digest(raw),rawSha);
      const receipt=JSON.parse(await fs.readFile(root+'/receipts/'+digest(op.key)+'.json','utf8'));
      assert.equal(digest(receipt),receiptSha);
      await fs.access(root+'/results/'+digest(op.key)+'.json');
      Object.assign(history.find(h=>h.operation_key===op.key),returned(op),{raw_sha256:rawSha,receipt_sha256:receiptSha});
      events.push('returned');
    },
    async finish(status){f.run.status=status;events.push(status);},
  };
  const fetchImpl=async(url,options)=>{
    assert.equal(events.at(-1),'admit');assert.equal(options.redirect,'error');
    assert.equal(options.method,'GET');assert.ok(options.signal);
    assert.deepEqual(options.headers,{'x-api-key':'fixture-not-a-secret'});
    events.push('fetch');
    const op=f.plan.operations.find(p=>p.request.url===url);assert.ok(op);
    return Response.json({success:true,credits_charged:1,id:op.videoId,url:op.videoUrl,
      channel:{id:'UC'+op.profileId.padStart(22,'0'),url:'https://www.youtube.com/channel/UC'+op.profileId.padStart(22,'0'),
        title:f.plan.artists.find(a=>a.profileId===op.profileId).name}});
  };
  return {...f,root,history,events,gate,fetchImpl,assertFrozen:async()=>{},credential:'fixture-not-a-secret'};
}
test('40 fixture requests persist raw evidence before acknowledgment and never accept ownership',async t=>{
  const f=await executionFixture(t),results=await executeVideoStage(f);
  assert.equal(results.length,40);assert.equal(f.run.reserved_cents,80);assert.equal(f.run.status,'completed');
  assert.ok(f.history.every(h=>h.status==='returned'));
  assert.ok(results.every(r=>r.ownershipAccepted===false&&r.requiresIndependentOwnershipCheck===true));
  const summary=JSON.parse(await fs.readFile(f.root+'/summary.json','utf8'));
  assert.equal(summary.acceptedOwnershipLinks,0);assert.equal(summary.nextStageApprovalRequired,true);
  assert.equal(summary.channelMetadataCalls,0);assert.equal(summary.modelCalls,0);
  assert.equal(summary.artistsWithResolvedUploaders,20);
});
test('timeout, HTTP failure, conflicting provider identity and increased credit cost stop without replay',async t=>{
  for(const failure of ['timeout','http','identity','billing']){
    const f=await executionFixture(t);let calls=0;
    const real=f.fetchImpl;
    f.fetchImpl=async(...args)=>{
      calls++;
      if(failure==='timeout')throw Error('fixture timeout');
      const response=await real(...args),body=await response.json();
      if(failure==='identity')body.uploader={channelId:'UC'+''.padStart(22,'9')};
      if(failure==='billing')body.credits_charged=2;
      return Response.json(body,{status:failure==='http'?404:200});
    };
    await assert.rejects(()=>executeVideoStage(f));
    assert.equal(calls,1);assert.equal(f.history.length,1);assert.equal(f.history[0].status,'admitted');
    assert.equal(f.run.reserved_cents,2);assert.equal(f.run.status,'stopped');
    if(failure!=='timeout')await fs.access(f.root+'/receipts/'+digest(f.plan.operations[0].key)+'.raw');
  }
});
test('no approval or changed frozen inputs prevents all provider calls',async t=>{
  const f=await executionFixture(t);let calls=0;f.fetchImpl=async()=>{calls++;throw Error('must not dispatch');};
  await assert.rejects(()=>executeVideoStage({...f,approval:{...f.approval,explicitApproval:false}}));
  f.assertFrozen=async()=>{throw Error('runtime changed');};
  await assert.rejects(()=>executeVideoStage(f));assert.equal(calls,0);assert.equal(f.history.length,0);
});
