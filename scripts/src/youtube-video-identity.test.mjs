import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage} from './youtube-video-stage.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {verifyIdentityUploaderSource} from './youtube-video-identity-source.mjs';
import {prepareVideoChannelCaptures,prepareVideoIdentityModels,approveVideoIdentityPlan,
  validateVideoIdentityPlan,reviewVideoIdentityAnswers,VIDEO_IDENTITY_MODEL} from './youtube-video-identity-plan.mjs';
import {videoIdentityOptions} from './prepare-youtube-video-identity.mjs';

const at='2026-11-12T06:00:00Z',runtimeFiles={'runtime/offline.mjs':digest('fixture')};
const cid=n=>'UC'+String(n).padStart(22,'0');
const b64=x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64');
const decode=x=>JSON.parse(Buffer.from(x,'base64').toString());
function fixture(){
  const files={},evidenceFiles={},artists=[],operations=[];
  const put=(name,value)=>{files[name]=b64(value);return digest(Buffer.from(files[name],'base64'));};
  const parent={id:'saved-parent',artists:Array.from({length:20},(_,i)=>({
    profile_id:String(i+1),cm_artist:String(i+101)}))};
  evidenceFiles['evidence/source-plan.json']=put('evidence/source-plan.json',parent);
  for(let i=1;i<=20;i++){
    const a={profileId:String(i),cmArtist:String(i+100),name:'Artist '+i,tier:2,snapshotAt:at};
    artists.push(a);
    const packet={profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,collectedAt:at,
      catalogProfile:{profile_id:a.profileId,cm_artist:a.cmArtist,name:a.name},
      linkedAccounts:i===6?[{profile_id:a.profileId,cm_artist:a.cmArtist,account_id:'catalog-6',
        platform:'spotify',account_url:'https://open.spotify.com/artist/'+''.padStart(22,'6'),
        wasInFrozenBatch:true}]:[],
      chartmetric:null,releases:[],catalogTracks:[],tags:[],spotifyMetadata:[],platformSnapshots:[],profileMetadata:[]};
    const artist=youtubeArtistFromCatalogPacket(packet);
    const organic=[0,1].map(j=>({link:'https://www.youtube.com/watch?v='+String(i*2+j).padStart(11,'0'),
      title:a.name+' — recording '+j,snippet:'Saved recording reference'}));
    const request={method:'POST',url:'https://google.serper.dev/search',body:{q:a.name}};
    const receipt={operationKey:'search-'+i+'-0',kind:'search',status:200,request,
      inputSha256:digest(request),data:{organic}};
    const searchBytes=JSON.stringify(receipt);
    const videoPlan=planVideoDiscovery(artist,organic,{receiptSha256:digest(searchBytes),
      archivePath:'generated-artifacts/saved-parent/receipts/search-'+i+'.json'});
    evidenceFiles['evidence/'+i+'.json']=put('evidence/'+i+'.json',{artist,catalogPacket:packet,
      sourceSearchReceipt:receipt,sourceSearchReceiptBytesBase64:b64(searchBytes),videoPlan});
    for(const v of videoPlan.resolutionQueue)operations.push({...v.operation,profileId:a.profileId,
      cmArtist:a.cmArtist,videoId:v.videoId,videoUrl:v.url});
  }
  const sourceRuntime={'runtime/source.mjs':put('runtime/source.mjs','// immutable source runtime')};
  const plan=videoStagePlan({id:'youtube-video-review-fixture-source',preparedAt:at,sourceRunId:parent.id,
    sourcePlanSha256:digest(parent),artists,operations,evidenceFiles,runtimeFiles:sourceRuntime});
  put('plan.json',plan);
  put('approval.json',approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:80,approvedAt:at}));
  put('summary.json',{id:plan.id,status:'completed',returnedCalls:40});
  for(const [index,op] of plan.operations.entries()){
    let channelId=cid(index+1);
    if(op.profileId==='1')channelId=cid(1); // Two videos, one channel.
    if(index===2||index===5)channelId=cid(900); // Selected artist 2, deferred artist 3.
    const raw={success:true,credits_charged:1,id:op.videoId,url:op.videoUrl,
      channel:{id:channelId,url:'https://www.youtube.com/channel/'+channelId,title:'Uploader '+index}};
    const rawPath='receipts/'+digest(op.key)+'.raw';put(rawPath,raw);
    put('receipts/'+digest(op.key)+'.json',{runId:plan.id,planSha256:digest(plan),
      profileId:op.profileId,cmArtist:op.cmArtist,videoId:op.videoId,operationKey:op.key,kind:op.kind,
      request:op.request,inputSha256:op.inputSha256,status:200,capturedAt:at,
      rawPath,rawBodySha256:digest(Buffer.from(files[rawPath],'base64'))});
  }
  return {files};
}
const captureInput=source=>({id:'youtube-video-identity-capture-fixture',preparedAt:at,runtimeFiles,source});
function returned(plan,dataFor){
  const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:digest(plan),
    capCents:plan.maximumSpendCents,approvedAt:at});
  return {approval,summary:{id:plan.id,planSha256:digest(plan),status:'completed',returnedCalls:plan.operations.length},
    receipts:plan.operations.map(op=>{
      const raw=JSON.stringify(dataFor(op));
      const r={runId:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
        operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
        kind:op.kind,inputSha256:op.inputSha256,request:op.request,status:200,capturedAt:at,
        rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)};
      return {receiptBytesBase64:b64(r),rawBodyBase64:b64(raw)};
    })};
}
function channelData(op){
  return {success:true,credits_charged:1,channelId:op.channelId,name:'Artist '+op.profileId,
    description:op.profileId==='4'?'We are an independent record label.':'Music.',
    ...(op.profileId==='6'?{name:'Artist 6 - Topic',isAutoGenerated:true,
      links:['https://open.spotify.com/artist/'+''.padStart(22,'6')]}:{})};
}
function modelInput(source=fixture()){
  const capturePlan=prepareVideoChannelCaptures(captureInput(source));
  return {id:'youtube-video-identity-model-fixture',preparedAt:at,runtimeFiles,capturePlan,
    captureReturns:returned(capturePlan,channelData)};
}
test('captures preserve every video, deduplicate per artist and disclose deterministic breadth loss',()=>{
  const source=fixture(),before=digest(source),plan=prepareVideoChannelCaptures(captureInput(source));
  assert.equal(digest(source),before);
  assert.equal(plan.maximumCalls,20);assert.equal(plan.maximumSpendCents,40);
  assert.equal(plan.allowedKinds.join(','),'metadata');assert.equal(plan.modelCalls,0);
  assert.equal(plan.selections.flatMap(s=>s.alternatives.flatMap(c=>c.observations)).length,40);
  assert.equal(plan.selections[0].alternatives.length,1);
  assert.equal(plan.selections[0].alternatives[0].observations.length,2);
  assert.equal(plan.selections[1].selectedChannelId,cid(900));
  assert.equal(plan.selections[2].alternatives[1].sharedChannelConflict,true);
  assert.equal(plan.selections[1].alternatives[0].sharedChannelClaims.length,2);
  assert.match(plan.breadthTradeoff,/previous two-channel/);
  assert.match(plan.selectionRule,/No name, role, ownership answer or Topic preference/);
  assert.match(plan.sharedChannelScope,/Outside-cohort.*not checked/);
  assert.ok(plan.operations.every(o=>o.inputSha256===digest(o.request)&&o.reservationCents===2));
  assert.equal(plan.executable,false);assert.equal(plan.ownershipAccuracy,null);
});
test('uploader source rejects incomplete, substituted, missing or changed receipts and evidence',()=>{
  for(const mutate of [
    s=>{const x=decode(s.files['summary.json']);x.status='stopped';s.files['summary.json']=b64(x);},
    s=>{delete s.files['summary.json'];},
    s=>{delete s.files[Object.keys(s.files).find(n=>n.endsWith('.raw'))];},
    s=>{s.files['runtime/source.mjs']=b64('edited');},
    s=>{s.files['evidence/1.json']=b64({});},
    s=>{s.files['approval.json']=b64({});},
    s=>{const key=Object.keys(s.files).find(n=>n.endsWith('.raw'));s.files[key]=b64('{}');},
    s=>{const key=Object.keys(s.files).find(n=>n.startsWith('receipts/')&&n.endsWith('.json'));
      const x=decode(s.files[key]);x.profileId='999';s.files[key]=b64(x);},
    s=>{const key=Object.keys(s.files).find(n=>n.startsWith('receipts/')&&n.endsWith('.json'));
      const x=decode(s.files[key]);x.planSha256=digest('wrong');s.files[key]=b64(x);},
  ]){
    const source=fixture();mutate(source);
    assert.throws(()=>verifyIdentityUploaderSource(source));
  }
});
test('fresh approvals bind stage, exact plan, evidence, allocations, runtime and cap, not prior approval',()=>{
  const plan=prepareVideoChannelCaptures(captureInput(fixture()));
  const options={expectedPlanSha256:digest(plan),capCents:40,approvedAt:at};
  const approval=approveVideoIdentityPlan(plan,options);
  assert.equal(approval.executionEnabled,false);assert.equal(approval.operationAllocationsSha256,digest(plan.operations));
  assert.throws(()=>approveVideoIdentityPlan(plan,{...options,capCents:80}));
  assert.throws(()=>approveVideoIdentityPlan(plan,{...options,expectedPlanSha256:digest(plan.source)}));
  for(const mutate of [
    p=>p.operations[0].channelId=cid(999),
    p=>p.operations[0].reservationCents=0,
    p=>p.operations[0].request.url+='&cache_max_age=30',
    p=>p.selections[1].selectedChannelId=cid(10),
    p=>p.maximumSpendCents=80,
    p=>p.modelCalls=20,
    p=>p.sourceBinding.summarySha256=digest('changed'),
    p=>p.runtimeFiles={'../outside':digest('changed')},
  ]){
    const changed=structuredClone(plan);mutate(changed);
    assert.throws(()=>approveVideoIdentityPlan(changed,{...options,expectedPlanSha256:digest(changed)}));
  }
});
test('models are frozen only after exact capture returns; Topic, conflicts and organizations stay separate',()=>{
  const input=modelInput(),before=digest(input);
  const plan=prepareVideoIdentityModels(input);
  assert.equal(digest(input),before);
  assert.equal(plan.allowedKinds.join(','),'model');assert.equal(plan.channelMetadataCalls,0);
  assert.equal(plan.maximumSpendCents,plan.operations.length*2);
  assert.ok(plan.operations.length>0,'Fixture must exercise real exact model requests');
  assert.equal(plan.assessments.find(a=>a.profileId==='2').decision.status,'ownership_conflict');
  assert.equal(plan.assessments.find(a=>a.profileId==='4').category,'unresolved');
  assert.equal(plan.assessments.find(a=>a.profileId==='6').category,'supported_topic');
  assert.equal(plan.assessments.find(a=>a.profileId==='6').channelTypeLabel,'Topic — auto-generated');
  assert.ok(!plan.operations.some(o=>['2','4','6'].includes(o.profileId)));
  assert.ok(plan.assessments.every(a=>!a.ownershipAccepted));
  for(const op of plan.operations){
    assert.equal(op.inputSha256,digest(op.request));
    assert.equal(op.request.body.state.artist.profileId,op.profileId);
    assert.equal(op.request.body.state.candidate.channelCapture.body.channelId,op.channelId);
    assert.equal(op.request.body.state.artist.ownershipEvidence.videoUploaderDiscovery.channelId,op.channelId);
    assert.ok(Buffer.byteLength(JSON.stringify(op.request.body))<=6000);
    assert.match(op.captureRawBodySha256,/^[a-f0-9]{64}$/);
  }
  validateVideoIdentityPlan(plan);
});
test('bad capture identity, unknown billing, duplicates, failures and wrong approvals stop model preparation',()=>{
  for(const mutate of [
    i=>i.captureReturns.receipts.pop(),
    i=>i.captureReturns.receipts[1]=i.captureReturns.receipts[0],
    i=>i.captureReturns.summary.status='stopped',
    i=>i.captureReturns.approval.capCents=80,
    i=>{const s=i.captureReturns.receipts[0],r=decode(s.receiptBytesBase64);r.cmArtist='999';s.receiptBytesBase64=b64(r);},
    i=>{const s=i.captureReturns.receipts[0],r=decode(s.receiptBytesBase64);r.status=404;s.receiptBytesBase64=b64(r);},
    i=>{i.captureReturns.receipts[0].rawBodyBase64=b64('{}');},
  ]){
    const input=modelInput();mutate(input);
    assert.throws(()=>prepareVideoIdentityModels(input));
  }
  for(const dataFor of [
    op=>({...channelData(op),channelId:cid(888)}),
    op=>({...channelData(op),credits_charged:undefined}),
    op=>({...channelData(op),credits_charged:2}),
    op=>({...channelData(op),channel:'https://evil.example/@artist'}),
  ]){
    const input=modelInput();input.captureReturns=returned(input.capturePlan,dataFor);
    assert.throws(()=>prepareVideoIdentityModels(input));
  }
});
test('oversized model evidence is held, never truncated or silently replaced',()=>{
  const input=modelInput();
  input.captureReturns=returned(input.capturePlan,op=>({...channelData(op),description:'x'.repeat(7000)}));
  const plan=prepareVideoIdentityModels(input);
  assert.equal(plan.operations.length,0);
  assert.ok(plan.assessments.some(a=>a.hold==='exact_model_body_exceeds_6000_bytes_no_silent_truncation'));
  assert.equal(plan.assessments[0].candidate.capture.body.description.length,7000);
});
test('captured aliases shared across distinct uploader IDs hold both artists without spending model slots',()=>{
  const input=modelInput();
  input.captureReturns=returned(input.capturePlan,op=>({...channelData(op),
    ...(['5','7'].includes(op.profileId)?{channel:'https://www.youtube.com/@samehandle'}:{})}));
  const plan=prepareVideoIdentityModels(input);
  for(const id of ['5','7']){
    assert.equal(plan.assessments.find(a=>a.profileId===id).decision.status,'ownership_conflict');
    assert.ok(!plan.operations.some(o=>o.profileId===id));
    const selected=plan.selections.find(s=>s.profileId===id).alternatives[0];
    assert.equal(selected.sharedChannelConflict,true);
    assert.equal(selected.capturedAliasConflicts[0].claims.length,2);
  }
});
test('answer review keeps artist-owned suggestions, supported Topic and unresolved distinct with no accuracy claim',()=>{
  const plan=prepareVideoIdentityModels(modelInput());
  const make=(op)=>({model:VIDEO_IDENTITY_MODEL.model.expectedModel,usage:{cost:.001},
    answers:{same_identity:{noul:.96},verdict:{choice:op.profileId==='3'?'uncertain':'likely'},
      channel_type:{choice:op.profileId==='3'?'unknown':'artist_owned'}}});
  const returns=returned(plan,make);
  const findings=reviewVideoIdentityAnswers(plan,returns);
  assert.equal(findings.find(a=>a.profileId==='5').category,'artist_owned_suggestion');
  assert.equal(findings.find(a=>a.profileId==='3').category,'unresolved');
  assert.equal(findings.find(a=>a.profileId==='6').category,'supported_topic');
  assert.equal(findings.find(a=>a.profileId==='2').decision.status,'ownership_conflict');
  assert.ok(findings.every(a=>!a.liveLinkAccepted&&!a.ownershipAccepted&&a.ownershipAccuracy===null));
  const bad=structuredClone(returns),r=decode(bad.receipts[0].receiptBytesBase64);
  r.request.body.state.artist.profileId='999';bad.receipts[0].receiptBytesBase64=b64(r);
  assert.throws(()=>reviewVideoIdentityAnswers(plan,bad));
});
test('CLI rejects execution, old IDs, duplicated flags and approval scope leakage',()=>{
  for(const args of [
    ['--run-approved','--id=youtube-video-identity-test'],
    ['--prepare-captures','--id=youtube-video-identity-test','--source-id=../outside'],
    ['--prepare-captures','--id=youtube-video-identity-test','--source-id=youtube-video-review-test','--approve-cents=40'],
    ['--authorize-prepared','--id=youtube-video-review-test','--approve-cents=40','--plan-sha256='+digest('x')],
    ['--prepare-captures','--prepare-models','--id=youtube-video-identity-test'],
  ])assert.throws(()=>videoIdentityOptions(args));
});
test('offline CLI seals files, exports all alternatives and refuses missing receipts without network or writes to source',async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'yt-identity-'));
  t.after(()=>fs.rm(tmp,{recursive:true,force:true}));
  const source=fixture(),id=decode(source.files['plan.json']).id,root=tmp+'/generated-artifacts/'+id;
  await fs.mkdir(root,{recursive:true});
  for(const [name,base64] of Object.entries(source.files)){
    await fs.mkdir(path.dirname(root+'/'+name),{recursive:true});
    await fs.writeFile(root+'/'+name,Buffer.from(base64,'base64'));
  }
  const fence=tmp+'/no-network.mjs';
  await fs.writeFile(fence,`import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
    const fail=()=>{throw Error('Offline preparation attempted network');};
    globalThis.fetch=fail;net.Socket.prototype.connect=fail;tls.connect=fail;
    http.request=fail;https.request=fail;http.get=fail;https.get=fail;`);
  const entry=path.resolve('scripts/src/prepare-youtube-video-identity.mjs');
  const env={PATH:process.env.PATH,HOME:tmp,NODE_OPTIONS:'--import='+fence};
  const run=(file,args)=>spawnSync(process.execPath,[file,...args],{cwd:tmp,env,encoding:'utf8',timeout:30000});
  const outId='youtube-video-identity-cli-fixture';
  const args=['--prepare-captures','--id='+outId,'--source-id='+id];
  let p=run(entry,args);assert.equal(p.status,0,p.stderr);
  const out=tmp+'/generated-artifacts/'+outId;
  const plan=JSON.parse(await fs.readFile(out+'/plan.json','utf8'));
  assert.equal((await fs.readFile(out+'/identity-alternatives.csv','utf8')).trim().split('\r\n').length,41);
  for(const [name,hash] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(out+'/'+name)),hash);
  const authorize=['--authorize-prepared','--id='+outId,'--plan-sha256='+digest(plan),'--approve-cents=40'];
  assert.notEqual(run(entry,authorize).status,0,'Unsealed authorizer must fail');
  const runtimeName=Object.keys(plan.runtimeFiles).find(n=>n.endsWith('youtube-video-identity-source.mjs'));
  const runtimeBytes=await fs.readFile(out+'/'+runtimeName);
  await fs.appendFile(out+'/'+runtimeName,'\n// changed runtime');
  assert.notEqual(run(out+'/runtime/prepare-youtube-video-identity.mjs',authorize).status,0);
  await fs.writeFile(out+'/'+runtimeName,runtimeBytes);
  p=run(out+'/runtime/prepare-youtube-video-identity.mjs',authorize);assert.equal(p.status,0,p.stderr);
  assert.equal(JSON.parse(await fs.readFile(out+'/approval.json','utf8')).executionEnabled,false);
  assert.notEqual(run(entry,args).status,0,'Must not overwrite prepared work');
  await fs.writeFile(out+'/returns.json',JSON.stringify(returned(plan,channelData)));
  const modelId='youtube-video-identity-cli-model-fixture';
  p=run(entry,['--prepare-models','--id='+modelId,'--source-id='+outId]);assert.equal(p.status,0,p.stderr);
  const modelRoot=tmp+'/generated-artifacts/'+modelId;
  const modelPlan=JSON.parse(await fs.readFile(modelRoot+'/plan.json','utf8'));
  assert.ok(modelPlan.operations.length>0);
  assert.equal(modelPlan.assessments.find(a=>a.profileId==='6').category,'supported_topic');
  const modelAuthorize=['--authorize-prepared','--id='+modelId,'--plan-sha256='+digest(modelPlan),
    '--approve-cents='+modelPlan.maximumSpendCents];
  p=run(modelRoot+'/runtime/prepare-youtube-video-identity.mjs',modelAuthorize);assert.equal(p.status,0,p.stderr);
  assert.equal(JSON.parse(await fs.readFile(modelRoot+'/approval.json','utf8')).executionEnabled,false);
  for(const [name,base64] of Object.entries(source.files))assert.equal((await fs.readFile(root+'/'+name)).toString('base64'),base64);
  await fs.unlink(root+'/summary.json');
  const missingId='youtube-video-identity-missing-fixture';
  assert.notEqual(run(entry,['--prepare-captures','--id='+missingId,'--source-id='+id]).status,0);
  await assert.rejects(fs.access(tmp+'/generated-artifacts/'+missingId));
});
