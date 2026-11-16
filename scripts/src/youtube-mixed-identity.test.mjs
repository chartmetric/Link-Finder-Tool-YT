import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mixedCapturePlan,approveMixedCaptures} from './youtube-mixed-channel-captures.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {verifyMixedIdentitySource} from './youtube-mixed-identity-source.mjs';
import {prepareMixedIdentityPlan,validateMixedIdentityPlan,mixedIdentityApprovalProposal} from './youtube-mixed-identity-plan.mjs';

const channel=n=>'UC'+String(n).padStart(22,'a');
const url=n=>'https://www.youtube.com/channel/'+channel(n);
const spotify=n=>'https://open.spotify.com/artist/'+String(n).padStart(22,'A');
const root='generated-artifacts/youtube-mixed-captures-synthetic-identity';
const searchRoot='generated-artifacts/youtube-test-synthetic-identity';
const at='2026-11-14T02:00:00.000Z';
function fixture(change=()=>{}){
  const packets=Array.from({length:5},(_,i)=>{
    const profileId=String(i+1),cmArtist=String(i+101),artist='Artist '+(i+1);
    return {profileId,cmArtist,artist,collectedAt:at,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
      linkedAccounts:[{profile_id:profileId,cm_artist:cmArtist,account_id:'spotify-'+profileId,
        platform:'spotify',account_url:spotify(i+1),wasInFrozenBatch:true}],
      chartmetric:{cm_artist:cmArtist,band:0},releases:[],catalogTracks:[],accountSnapshots:[],
      spotifyMetadata:[],tags:[],platformSnapshots:[],profileMetadata:[]};
  });
  const artists=packets.map(p=>({...youtubeArtistFromCatalogPacket(p),tier:2}));
  const input={id:root.split('/')[1],preparedAt:at,artists,
    directLeads:artists.map((a,i)=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
      candidates:[{url:url(i+1),title:a.name,snippet:'A collaborator and a popular song title mention this artist'}]})),
    uploaderResults:[],sourceSearchId:searchRoot.split('/')[1],
    sourceUploaderIds:['youtube-video-review-synthetic-stopped'],
    sourceFiles:{},runtimeFiles:{'runtime/capture.mjs':digest('frozen capture runtime')}};
  const bodies=artists.map((a,i)=>({success:true,credits_charged:1,channelId:channel(i+1),
    channel:url(i+1),name:a.name,description:'Music channel',links:[]}));
  // A supported Topic, an unsupported same-name Topic, an explicit label and
  // an individual whose channel explicitly identifies itself as a group.
  bodies[1].name+=' - Topic';bodies[1].links=[spotify(2)];
  bodies[2].name+=' - Topic';
  bodies[3].description='We are an independent record label';
  bodies[4].name='Another Band';bodies[4].description='Artist 5 is a member of Another Band';
  change({input,packets,bodies});
  const source={id:input.id,files:{}};
  const put=(name,v)=>{source.files[name]=(Buffer.isBuffer(v)?v:Buffer.from(JSON.stringify(v))).toString('base64');};
  put(searchRoot+'/plan.json',{id:input.sourceSearchId,packets,catalogEvidenceSha256:digest(packets)});
  // Preserve a genuinely stopped historical stage without claiming completion.
  const stopped='generated-artifacts/'+input.sourceUploaderIds[0]+'/summary.json';
  put(stopped,{status:'stopped',reservedCents:4});
  input.sourceFiles=Object.fromEntries(Object.entries(source.files).map(([n,b])=>[n,digest(Buffer.from(b,'base64'))]));
  const plan=mixedCapturePlan(input);
  const approval=approveMixedCaptures(plan,{planSha256:digest(plan),capCents:plan.maximumSpendCents,approvedAt:at});
  put(root+'/plan.json',plan);put(root+'/approval.json',approval);
  put(root+'/summary.json',{id:plan.id,planSha256:digest(plan),status:'prepared_not_approved'});
  source.files[root+'/runtime/capture.mjs']=Buffer.from('frozen capture runtime').toString('base64');
  const returns=plan.operations.map(op=>{
    const body=bodies[Number(op.profileId)-1],raw=Buffer.from(JSON.stringify(body));
    const receipt={runId:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
      operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',
      targetUrl:op.targetUrl,inputSha256:op.inputSha256,request:op.request,capturedAt:at,status:200,
      rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)};
    const capture=normalizeYoutubeChannel({at,status:200,kind:'metadata',operationKey:op.key,
      request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
    put(root+'/'+receipt.rawPath,raw);put(root+'/receipts/'+digest(op.key)+'.json',receipt);
    return {receipt,capture,ownershipAccepted:false,importEligible:false};
  });
  put(root+'/returns.json',{planSha256:digest(plan),returns});
  return {id:'youtube-mixed-identity-synthetic-test',preparedAt:at,source,
    runtimeFiles:{'runtime/prepare.mjs':digest('synthetic offline runtime')}};
}
function mutateFile(input,name,fn){
  const files=input.source.files,v=JSON.parse(Buffer.from(files[name],'base64'));
  fn(v);files[name]=Buffer.from(JSON.stringify(v)).toString('base64');
}
test('mixed contract preserves original packets and stopped stages without inventing uploaders',()=>{
  const f=fixture(),p=prepareMixedIdentityPlan(f);
  validateMixedIdentityPlan(p);
  assert.equal(p.assessments.length,5);assert.equal(p.maximumCalls,1);
  assert.equal(p.proposedMaximumSpendCents,2);
  assert.equal(p.sourceBinding.summaryStatus,'prepared_not_approved');
  assert.equal(p.sourceBinding.localReturnsComplete,true);assert.equal(p.sourceBinding.liveCoordinatorReconciled,false);
  assert.deepEqual(p.source,f.source);
  assert.equal(p.sourceBinding.filesSha256['generated-artifacts/youtube-video-review-synthetic-stopped/summary.json'],
    digest(Buffer.from(f.source.files['generated-artifacts/youtube-video-review-synthetic-stopped/summary.json'],'base64')));
  for(const a of p.assessments){
    assert.equal(a.artist.ownershipEvidence.videoUploaderDiscovery,undefined);
    assert.equal(a.artist.ownershipEvidence.channelAttributedVideos.length,0);
    assert.ok(a.discovery.observations.every(o=>o.source==='saved_direct_search'));
    assert.equal(a.ownershipAccepted,false);assert.equal(a.importEligible,false);
  }
  assert.ok(p.operations.every(o=>o.kind==='model'));
  assert.deepEqual(p.operations[0].nonReplayKeys,{profileId:'1',cmArtist:'101',channelId:channel(1)});
  assert.equal(p.preservedCaptureAllocations.length,5);
  assert.equal(p.operations[0].preservedMetadataAllocation.key,p.preservedCaptureAllocations[0].key);
  assert.equal(p.budget.priorAllocationsReset,false);assert.equal(p.executable,false);
});
test('Topic music associations are distinct, while name-only Topics, labels and groups remain unapproved',()=>{
  const p=prepareMixedIdentityPlan(fixture()),a=p.assessments;
  assert.equal(a[0].decision.status,'needs_identity_check');
  assert.equal(a[0].category,'unresolved'); // names/song mentions cannot prove ownership
  assert.equal(a[1].category,'supported_topic');assert.equal(a[1].artistOwned,false);
  assert.equal(a[1].channelTypeLabel,'Topic — auto-generated');
  assert.equal(a[2].topicAssociationStatus,'unverified');assert.equal(a[2].category,'unresolved');
  assert.equal(a[3].decision.status,'not_artist_owned');assert.equal(a[3].prepared,null);
  assert.equal(a[4].decision.status,'ownership_conflict');assert.equal(a[4].prepared,null);
});
test('unknown handles resolve only from captures, and new aliases conflict with deferred artist claims',()=>{
  const resolved=prepareMixedIdentityPlan(fixture(({input,bodies})=>{
    input.directLeads[0].candidates[0].url='https://www.youtube.com/@realartist';
    bodies[0].channel='https://www.youtube.com/@realartist';
  }));
  assert.equal(resolved.assessments[0].channelId,channel(1));
  assert.equal(resolved.operations[0].preservedMetadataAllocation.channelKey,
    'unresolved-url:https://www.youtube.com/@realartist');
  const f=fixture(({input,bodies})=>{
    bodies[0].channel='https://www.youtube.com/@realartist';
    input.directLeads[1].candidates.push({url:'https://www.youtube.com/@realartist',title:'Another lead'});
  });
  const p=prepareMixedIdentityPlan(f),a=p.assessments[0];
  assert.equal(a.channelId,channel(1));assert.ok(a.aliases.includes('https://www.youtube.com/@realartist'));
  assert.equal(a.decision.status,'ownership_conflict');assert.equal(a.prepared,null);
  assert.ok(p.deferredAndHeldAlternatives.length);
});
test('exact full-body proposal measures UTF-8, changes no legacy limit and cannot grant execution',()=>{
  const p=prepareMixedIdentityPlan(fixture(({bodies})=>{bodies[0].description='音楽'.repeat(5000);}));
  const op=p.operations[0],proposal=mixedIdentityApprovalProposal(p);
  assert.equal(op.requestBytes,Buffer.byteLength(JSON.stringify(op.request.body)));
  assert.equal(op.requestBodySha256,digest(Buffer.from(JSON.stringify(op.request.body))));
  assert.ok(op.requestBytes>6000);assert.equal(p.model.proposedMaximumRequestBytes,op.requestBytes);
  assert.ok(op.request.body.state.candidate.channelCapture.body.description.endsWith('音楽'));
  assert.equal(proposal.executionEnabled,false);assert.equal(proposal.explicitApproval,false);
  assert.equal(proposal.inheritsCaptureApproval,false);assert.equal(proposal.pricingConfirmed,false);
  assert.equal(proposal.planSha256,digest(p));
  assert.match(op.request.body.state.evidenceRules,/group or band and its individual members are separate identities/);
  for(const change of [q=>q.operations[0].request.body.model='another-model',
    q=>q.operations[0].reservationCents=0,q=>q.operations[0].nonReplayKeys.channelId=channel(9),
    q=>q.assessments[0].ownershipAccepted=true,q=>q.executable=true]){
    const q=structuredClone(p);change(q);assert.throws(()=>validateMixedIdentityPlan(q));
  }
});
for(const fault of ['missing','duplicate','extra','raw','receipt','capture','packet','approval','runtime','billing','wrong_id']){
  test('immutable mixed source rejects '+fault,()=>{
    const f=fixture(),p=JSON.parse(Buffer.from(f.source.files[root+'/plan.json'],'base64'));
    const op=p.operations[0],receiptName=root+'/receipts/'+digest(op.key)+'.json';
    const rawName=root+'/receipts/'+digest(op.key)+'.raw';
    if(fault==='missing')mutateFile(f,root+'/returns.json',v=>v.returns.pop());
    if(fault==='duplicate')mutateFile(f,root+'/returns.json',v=>v.returns[1]=v.returns[0]);
    if(fault==='extra')f.source.files[root+'/unexpected.json']=Buffer.from('{}').toString('base64');
    if(fault==='raw')f.source.files[rawName]=Buffer.from('{}').toString('base64');
    if(fault==='receipt')mutateFile(f,receiptName,v=>v.cmArtist='999');
    if(fault==='capture')mutateFile(f,root+'/returns.json',v=>v.returns[0].capture.body.description='invented owner');
    if(fault==='packet')mutateFile(f,searchRoot+'/plan.json',v=>v.packets[0].cmArtist='999');
    if(fault==='approval')mutateFile(f,root+'/approval.json',v=>v.capCents=999);
    if(fault==='runtime')f.source.files[root+'/runtime/capture.mjs']=Buffer.from('changed').toString('base64');
    if(['billing','wrong_id'].includes(fault)){
      const body=JSON.parse(Buffer.from(f.source.files[rawName],'base64'));
      if(fault==='billing')body.credits_charged=2;else body.channelId=channel(9);
      const raw=Buffer.from(JSON.stringify(body));f.source.files[rawName]=raw.toString('base64');
      mutateFile(f,receiptName,r=>r.rawBodySha256=digest(raw));
      mutateFile(f,root+'/returns.json',v=>v.returns[0].receipt.rawBodySha256=digest(raw));
    }
    assert.throws(()=>verifyMixedIdentitySource(f.source));
  });
}
test('CLI freezes a new proposal offline, rejects execution modes and leaves every source byte intact',async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'mixed-identity-'));
  t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const f=fixture();
  for(const [name,b] of Object.entries(f.source.files)){
    await fs.mkdir(path.dirname(path.join(cwd,name)),{recursive:true});
    await fs.writeFile(path.join(cwd,name),Buffer.from(b,'base64'));
  }
  const cli=path.resolve('scripts/src/prepare-youtube-mixed-identity.mjs');
  const fence=path.resolve('scripts/src/youtube-ownership-offline-fence.mjs');
  const args=['--prepare-only','--id='+f.id,'--source-id='+f.source.id];
  const run=options=>spawnSync(process.execPath,['--import',fence,cli,...options],{
    cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:cwd},timeout:60000,maxBuffer:1024*1024});
  const result=run(args);assert.equal(result.status,0,result.stderr);
  const out=path.join(cwd,'generated-artifacts',f.id);
  const plan=JSON.parse(await fs.readFile(out+'/plan.json'));
  validateMixedIdentityPlan(plan);assert.equal(plan.executable,false);
  const summary=JSON.parse(await fs.readFile(out+'/summary.json'));
  assert.equal(summary.paidCalls,0);assert.equal(summary.ledgerWrites,0);assert.equal(summary.catalogWrites,0);
  assert.equal(summary.planSha256,digest(plan));
  assert.equal((await fs.readdir(out)).includes('approval.json'),false);
  assert.notEqual(run(args).status,0,'Existing proposals must not be overwritten');
  assert.notEqual(run(['--run-approved',...args.slice(1)]).status,0);
  const csv=await fs.readFile(out+'/identity-review.csv','utf8');
  assert.match(csv,/Topic — auto-generated/);
  for(const [name,b] of Object.entries(f.source.files))
    assert.equal((await fs.readFile(path.join(cwd,name))).toString('base64'),b);
  const copied=await fs.readFile(out+'/runtime/prepare-youtube-mixed-identity.mjs');
  assert.equal(digest(copied),plan.runtimeFiles['runtime/prepare-youtube-mixed-identity.mjs']);
});
