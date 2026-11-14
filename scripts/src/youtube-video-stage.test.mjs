import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage,assertVideoStageAdmission,archivedSearchReceiptName,
  SMALL_VIDEO_STAGE_POLICY} from './youtube-video-stage.mjs';
import {executeVideoStage} from './youtube-video-stage-execution.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {validateVideoRecovery} from './youtube-video-stage-recovery.mjs';
import {CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE,uploaderConflictHandlingApproval}
  from './youtube-uploader-conflict-handling.mjs';
import {exportUploaderChannels} from './export-youtube-uploader-channels.mjs';

const sha=digest('fixture');
test('saved receipt lookup retains the original JSON-string hash convention',()=>{
  assert.equal(archivedSearchReceiptName('4152653'),'663436bc18291bb5f50a9e2401b900f1633e88010cd332fc6aa9bc672feb94ff.json');
});
function fixture(small=false){
  const artists=Array.from({length:small?5:20},(_,i)=>({profileId:String(i+1),cmArtist:String(i+101),
    name:'Artist '+(i+1),tier:2,snapshotAt:'2026-11-12T01:30:00Z'}));
  const operations=artists.flatMap((a,i)=>(small&&[1,4].includes(i)?[0]:[0,1]).map(j=>{
    const videoId=String(i*2+j+1).padStart(11,'0'),videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {...a,kind:'video_uploader',key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,
      videoId,videoUrl,request:proposedUploaderRequest(videoUrl)};
  }));
  const plan=videoStagePlan({...(small?{version:SMALL_VIDEO_STAGE_POLICY}:{}),
    id:'youtube-video-review-fixture-20',sourceRunId:'saved-fixture',
    sourcePlanSha256:sha,preparedAt:'2026-11-12T06:00:00Z',artists,operations,
    evidenceFiles:{'evidence/source-plan.json':sha},runtimeFiles:{'runtime/test.mjs':sha}});
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:small?16:80,approvedAt:'2026-11-12T06:01:00Z'});
  const run={id:plan.id,owner:'fixture-owner',status:'running',plan_sha256:digest(plan),
    approval_sha256:digest(approval),cap_cents:small?16:80,reserved_cents:0};
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
async function executionFixture(t,small=false){
  const f=fixture(small),root=await fs.mkdtemp(path.join(os.tmpdir(),'yt-video-stage-'));
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
test('small fresh policy freezes eight requests for five artists without weakening legacy scope',()=>{
  const {plan,approval}=fixture(true);
  assert.equal(plan.maximumCalls,8);assert.equal(plan.maximumSpendCents,16);
  assert.equal(approval.policy,SMALL_VIDEO_STAGE_POLICY);
  assert.equal(plan.unknownDownstreamRequestsApproved,false);
  const legacy={...plan};delete legacy.version;
  assert.throws(()=>videoStagePlan(legacy),/exactly 20/);
  assert.throws(()=>videoStagePlan({...plan,version:'unknown-policy'}));
  assert.throws(()=>videoStagePlan({...plan,recovery:{}}),/cannot inherit/);
  assert.throws(()=>videoStagePlan({...plan,operations:[]}));
  assert.throws(()=>videoStagePlan({...plan,operations:plan.operations.filter(o=>o.profileId!=='5')}));
  assert.throws(()=>approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:80,
    approvedAt:approval.approvedAt}));
});
test('eight-request small stage completes with bounded reservations and zero accepted ownership',async t=>{
  const f=await executionFixture(t,true);
  const results=await executeVideoStage(f);
  assert.equal(results.length,8);assert.equal(f.run.reserved_cents,16);
  assert.equal(f.run.status,'completed');
  const summary=JSON.parse(await fs.readFile(f.root+'/summary.json'));
  assert.equal(summary.artistsWithResolvedUploaders,5);assert.equal(summary.maximumCalls,8);
  assert.equal(summary.acceptedOwnershipLinks,0);assert.equal(summary.modelCalls,0);
  assert.equal(summary.channelMetadataCalls,0);assert.equal(summary.fullCampaignResumed,false);
  assert.ok(results.every(r=>r.ownershipAccepted===false));
});
async function enableConflictHandling(f){
  const updated=videoStagePlan({...f.plan,evidenceFiles:{...f.plan.evidenceFiles,
    [CONFLICT_HANDLING_FILE]:digest(JSON.stringify(CONFLICT_HANDLING_SCOPE))}});
  Object.assign(f.plan,updated);
  Object.assign(f.approval,approveVideoStage(f.plan,{expectedPlanSha256:digest(f.plan),
    capCents:f.plan.maximumSpendCents,approvedAt:f.approval.approvedAt}));
  Object.assign(f.run,{plan_sha256:digest(f.plan),approval_sha256:digest(f.approval)});
  await fs.writeFile(f.root+'/'+CONFLICT_HANDLING_FILE,JSON.stringify(CONFLICT_HANDLING_SCOPE));
  f.conflictHandlingApproval=uploaderConflictHandlingApproval(f.plan,f.approval);
}
function conflictingBody(body){
  body.uploader={channelId:'UC'+'z'.repeat(22),author:'Another Artist - Topic',
    url:'https://www.youtube.com/channel/UC'+'z'.repeat(22)};
  body.ownerByline={channelId:body.channel.id,name:body.channel.title};
  return body;
}
test('newly approved policy holds a conflicting response and continues without selecting or retrying',async t=>{
  const f=await executionFixture(t,true);await enableConflictHandling(f);
  const normal=f.fetchImpl;let calls=0;
  f.fetchImpl=async(url,options)=>{
    const response=await normal(url,options);calls++;
    return calls===1?Response.json(conflictingBody(await response.json())):response;
  };
  const results=await executeVideoStage(f);
  assert.equal(calls,8);assert.equal(results.length,7);
  assert.equal(f.run.reserved_cents,16);assert.equal(f.run.status,'completed');
  assert.ok(f.history.every(r=>r.status==='returned'));
  const summary=JSON.parse(await fs.readFile(f.root+'/summary.json'));
  assert.equal(summary.returnedCalls,8);assert.equal(summary.resolvedUploaderCalls,7);
  assert.equal(summary.heldConflictCalls,1);assert.equal(summary.acknowledgedReservationCents,16);
  assert.equal(summary.acceptedOwnershipLinks,0);
  const held=JSON.parse(await fs.readFile(f.root+'/results/'+digest(f.plan.operations[0].key)+'.json'));
  assert.equal(held.resultKind,'held_conflict');assert.equal(held.selectedChannel,null);
  assert.equal(held.importEligible,false);assert.equal(held.ownershipAccepted,false);
  assert.equal(held.url,undefined);
  const shortlist=await fs.readFile(f.root+'/video-uploader-findings.csv','utf8');
  assert.ok(!shortlist.includes(f.plan.operations[0].videoUrl));
  assert.equal(JSON.parse(await fs.readFile(f.root+'/held-uploader-conflicts.json')).heldConflicts.length,1);
  // A normal channel export must also keep ambiguous responses out of all
  // channel rows, while preserving the separate unresolved evidence.
  await fs.writeFile(f.root+'/plan.json',JSON.stringify(f.plan));
  await fs.writeFile(f.root+'/approval.json',JSON.stringify(f.approval));
  const output=f.root+'-export';t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const exported=await exportUploaderChannels(f.root,output);
  assert.equal(exported.heldSavedResponses,1);
  assert.ok(!(await fs.readFile(output+'/youtube-channels-all.csv','utf8')).includes(f.plan.operations[0].videoUrl));
});
test('legacy approval cannot silently enable hold-and-continue',async t=>{
  const f=await executionFixture(t,true);
  assert.throws(()=>uploaderConflictHandlingApproval(f.plan,f.approval));
  let calls=0;f.fetchImpl=async()=>{calls++;throw Error('must not fetch');};
  f.conflictHandlingApproval={holdConflicts:true};
  await assert.rejects(()=>executeVideoStage(f));
  assert.equal(calls,0);assert.equal(f.history.length,0);assert.equal(f.events.length,0);
});
test('conflict handling still stops on bad identity bindings, billing and HTTP failures',async t=>{
  for(const problem of ['wrong_video','missing_id','unknown_price','unsuccessful','http_error','malformed_json']){
    await t.test(problem,async t=>{
      const f=await executionFixture(t,true);await enableConflictHandling(f);
      const normal=f.fetchImpl;let calls=0;
      f.fetchImpl=async(url,options)=>{
        const response=await normal(url,options);calls++;
        const body=conflictingBody(await response.json());
        if(problem==='wrong_video')body.id='other-video';
        if(problem==='missing_id')delete body.uploader.channelId;
        if(problem==='unknown_price')body.credits_charged=2;
        if(problem==='unsuccessful')body.success=false;
        if(problem==='malformed_json')return new Response('{broken');
        return Response.json(body,{status:problem==='http_error'?503:200});
      };
      await assert.rejects(()=>executeVideoStage(f));
      assert.equal(calls,1);assert.equal(f.history.length,1);
      assert.equal(f.history[0].status,'admitted');
      assert.equal(f.run.reserved_cents,2);assert.equal(f.run.status,'stopped');
      const summary=JSON.parse(await fs.readFile(f.root+'/summary.json'));
      assert.equal(summary.returnedCalls,0);assert.equal(summary.heldConflictCalls,0);
    });
  }
});
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
function recoveryFixture(previousPlan,previousApproval,previousRecovery){
  const op=previousPlan.operations[0],artist=previousPlan.artists[0];
  const clue={profileId:op.profileId,cmArtist:op.cmArtist,videoId:op.videoId,url:op.videoUrl,sources:[],
    operation:{kind:op.kind,key:op.key,request:op.request}};
  // Observed schema regression: top-level video URL absent, exact ID still present.
  const channelId='UC'+''.padStart(22,previousRecovery?'2':'1');
  const rawBody=Buffer.from(JSON.stringify({success:true,credits_charged:1,id:op.videoId,
    channel:{id:channelId,url:'https://www.youtube.com/channel/'+channelId,
      ...(previousRecovery?{}:{title:artist.name})},
    ...(previousRecovery?{uploader:{channelId,author:artist.name+' - Topic'},
      ownerByline:{channelId,name:artist.name+' - Topic'}}:{})}));
  const receipt={runId:previousPlan.id,planSha256:digest(previousPlan),profileId:op.profileId,cmArtist:op.cmArtist,
    videoId:op.videoId,operationKey:op.key,kind:op.kind,request:op.request,inputSha256:op.inputSha256,
    status:200,capturedAt:previousPlan.preparedAt,rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(rawBody)};
  const artistEvidence={artist,videoPlan:{resolutionQueue:[clue]}};
  const mapped=mapSavedVideoUploader(artist,clue,{...receipt,rawBody},
    {runId:previousPlan.id,planSha256:digest(previousPlan)});
  const evidence={previousPlan,previousApproval,receipt,artistEvidence,mapped,rawBodyBase64:rawBody.toString('base64'),
    ...(previousRecovery?{previousRecovery}:{})};
  const plan=videoStagePlan({...previousPlan,id:previousPlan.id+'-recovery',
    operations:previousPlan.operations.slice(1),evidenceFiles:{'evidence/recovery.json':digest(JSON.stringify(evidence))},
    recovery:{previousRunId:previousPlan.id,previousPlanSha256:digest(previousPlan),
      previousApprovalSha256:digest(previousApproval),previousOwner:'fixture-owner',
      completedOperationKey:op.key,previousReservedCents:(previousPlan.recovery?.previousReservedCents??0)+2,originalMaximumCents:80,
      rawSha256:digest(rawBody),receiptSha256:digest(receipt),mappedSha256:digest(mapped)}});
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:plan.maximumSpendCents,approvedAt:previousApproval.approvedAt});
  return {plan,approval,evidence};
}
test('recovery binds the saved response, excludes its paid request and keeps combined reservations at 80 cents',()=>{
  const f=fixture(),r=recoveryFixture(f.plan,f.approval);
  assert.equal(r.plan.maximumCalls,39);assert.equal(r.approval.capCents,78);
  assert.equal(r.approval.savedResponseRecoveryApproved,true);
  assert.equal(r.approval.combinedMaximumSpendCents,80);
  assert.deepEqual(validateVideoRecovery(r.plan,r.evidence),f.plan.operations[0]);
  for(const change of [
    e=>e.receipt.profileId='999',
    e=>e.receipt.rawPath='../elsewhere',
    e=>e.rawBodyBase64=Buffer.from('{}').toString('base64'),
    e=>e.mapped.url='https://www.youtube.com/@wrong',
    e=>e.previousApproval.explicitApproval=false,
  ]){
    const copy=structuredClone(r.evidence);change(copy);
    assert.throws(()=>validateVideoRecovery(r.plan,copy));
  }
  assert.throws(()=>videoStagePlan({...r.plan,operations:f.plan.operations}));
  const changed=structuredClone(r.plan);changed.operations[0]=f.plan.operations[0];
  assert.throws(()=>validateVideoRecovery(changed,r.evidence));
});
test('recovery exports the saved uploader plus 39 new fixture returns without replaying the first URL',async t=>{
  const f=await executionFixture(t),r=recoveryFixture(f.plan,f.approval),history=[];
  await fs.writeFile(f.root+'/evidence/recovery.json',JSON.stringify(r.evidence));
  Object.assign(f.run,{id:r.plan.id,plan_sha256:digest(r.plan),approval_sha256:digest(r.approval),cap_cents:78});
  const gate={async start(){},async admit(op){
    assertVideoStageAdmission(r.plan,r.approval,f.run,op,history,'fixture-owner');
    history.push({...returned(op),status:'admitted'});f.run.reserved_cents+=2;
  },async returned(op){Object.assign(history.find(h=>h.operation_key===op.key),returned(op));},
  async finish(status){f.run.status=status;}};
  const originalFetch=f.fetchImpl,urls=[];
  const fetchImpl=async(url,options)=>{
    urls.push(url);
    // Original fixture transport checks admission ordering.
    f.events.push('admit');return originalFetch(url,options);
  };
  await executeVideoStage({...f,...r,gate,fetchImpl});
  assert.equal(urls.length,39);assert.ok(!urls.includes(r.evidence.previousPlan.operations[0].request.url));
  assert.equal(f.run.reserved_cents,78);
  const summary=JSON.parse(await fs.readFile(f.root+'/summary.json','utf8'));
  assert.equal(summary.returnedCalls,39);assert.equal(summary.recoveredSavedResponses,1);
  assert.equal(summary.combinedMaximumSpendCents,80);assert.equal(summary.acceptedOwnershipLinks,0);
  assert.equal((await fs.readdir(f.root+'/results')).length,40);
});
test('second recovery preserves both saved responses and 4 cents without replacing or repeating requests',async t=>{
  const f=await executionFixture(t),first=recoveryFixture(f.plan,f.approval);
  const second=recoveryFixture(first.plan,first.approval,first.evidence),history=[];
  assert.equal(second.plan.maximumCalls,38);assert.equal(second.approval.capCents,76);
  assert.equal(second.plan.recovery.previousReservedCents,4);
  assert.deepEqual(validateVideoRecovery(second.plan,second.evidence),f.plan.operations[1]);
  for(const mutation of [
    e=>e.previousRecovery.receipt.profileId='999',
    e=>e.previousRecovery.rawBodyBase64=Buffer.from('{}').toString('base64'),
    e=>delete e.previousRecovery,
    e=>e.previousApproval.savedResponseRecoveryApproved=false,
  ]){
    const bad=structuredClone(second.evidence);mutation(bad);
    assert.throws(()=>validateVideoRecovery(second.plan,bad));
  }
  assert.throws(()=>videoStagePlan({...second.plan,recovery:{...second.plan.recovery,previousReservedCents:2}}));
  await fs.writeFile(f.root+'/evidence/recovery.json',JSON.stringify(second.evidence));
  Object.assign(f.run,{id:second.plan.id,plan_sha256:digest(second.plan),approval_sha256:digest(second.approval),cap_cents:76});
  const gate={async start(){},async admit(op){
    assertVideoStageAdmission(second.plan,second.approval,f.run,op,history,'fixture-owner');
    history.push({...returned(op),status:'admitted'});f.run.reserved_cents+=2;
  },async returned(op){Object.assign(history.find(h=>h.operation_key===op.key),returned(op));},
  async finish(status){f.run.status=status;}};
  const urls=[],originalFetch=f.fetchImpl;
  await executeVideoStage({...f,...second,gate,fetchImpl:async(url,options)=>{
    urls.push(url);f.events.push('admit');return originalFetch(url,options);
  }});
  assert.equal(urls.length,38);
  assert.ok(f.plan.operations.slice(0,2).every(op=>!urls.includes(op.request.url)));
  const summary=JSON.parse(await fs.readFile(f.root+'/summary.json','utf8'));
  assert.equal(summary.returnedCalls,38);assert.equal(summary.recoveredSavedResponses,2);
  assert.equal(summary.priorReservedCents,4);assert.equal(summary.combinedMaximumSpendCents,80);
  assert.equal(summary.acceptedOwnershipLinks,0);
  assert.equal((await fs.readdir(f.root+'/results')).length,40);
  const csv=await fs.readFile(f.root+'/video-uploader-findings.csv','utf8');
  assert.ok(csv.includes('Artist 1 - Topic'));
});
