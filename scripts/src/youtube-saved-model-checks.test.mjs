import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {savedModelPlan,approveSavedModels,savedModelInput,SAVED_MODEL_POLICY} from './youtube-saved-verification-execution.mjs';
import {executeSavedModels,checkModelQuote,verifySavedModelSource,liveSavedModelCatalog} from './run-youtube-saved-model-checks.mjs';
import {rejectSavedModelReplay,savedModelGate} from './youtube-saved-model-gate.mjs';
const pricing={endpoint:'https://openrouter.ai/api/v1/models?output_modalities=decisions',id:'typesafe/jev-1.13',
  observedAt:'2026-11-17T00:00:00Z',promptUsdPerToken:'0.000000042',completionUsdPerToken:'0',contextTokens:262144};
function fixture(n=2,legacy=false){
  const capturePackets={},selections=[],operations=[];
  for(let i=0;i<n;i++){
    const profileId=String(i+1),cmArtist=String(i+101),channelId='UC'+'a'.repeat(21)+'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i];
    const canonical='https://www.youtube.com/channel/'+channelId;
    const url=legacy?'https://www.youtube.com/c/testartist'+i:canonical;
    const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
    const capture=normalizeYoutubeChannel({at:'2026-11-16T00:00:00Z',status:200,kind:'metadata',request,
      operationKey:'metadata-'+i,inputSha256:digest(request),data:{success:true,credits_charged:1,channelId,
        channel:canonical,name:'Artist '+i,description:'Official music',links:[]}},url);
    assert.ok(capture);
    const artist={profileId,cmArtist,name:'Artist '+i,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
      accounts:[],releases:[],context:{fullEvidence:'Long evidence '.repeat(700)}};
    const input=youtubeVerificationInput(artist,{url,capture,title:artist.name});
    const prepared=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
      expectedModel:'typesafe/jev-1.13',maxRequestBytes:50000}});
    const key='model-'+profileId;
    operations.push({key,profileId,cmArtist,channelId,kind:'model',request:prepared.request,inputSha256:prepared.inputSha256,
      policyInputSha256:input.inputSha256,requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),
      requestBytes:prepared.bytes,proposedReservationCents:2});
    capturePackets[key]=capture;selections.push({profileId,cmArtist,artist:artist.name,tier:3});
  }
  const input={version:SAVED_MODEL_POLICY,id:'youtube-saved-model-checks-fixture',preparedAt:'2026-11-17T01:00:00Z',
    sourceProposalPath:'generated-artifacts/youtube-saved-batch-verification-fixture/plan.json',
    sourceProposalSha256:digest('source'),sourceProposalFileSha256:digest('source-file'),
    operations,capturePackets,selections,deferred:[],maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes)),
    maximumSpendCents:n*2,pricing,runtimeFiles:{'runtime/test.mjs':digest('runtime')}};
  const plan=savedModelPlan(input);
  const approval=approveSavedModels(plan,{planSha256:digest(plan),capCents:n*2,approvedAt:'2026-11-17T02:00:00Z'});
  return {input,plan,approval};
}
const good=()=>({model:'typesafe/jev-1.13-20260917',usage:{cost:0.0001},
  answers:{same_identity:{type:'noul',noul:.97},verdict:{type:'choice',choice:'likely'},
    channel_type:{type:'choice',choice:'artist_owned'}}});
test('exact full evidence over 6KB is preserved and bounded, with unchanged original requests',()=>{
  const {input,plan,approval}=fixture(21,true);
  assert.deepEqual(plan.operations,input.operations);assert.equal(plan.groups.length,2);
  assert.deepEqual(plan.groups.map(g=>g.maximumSpendCents),[40,2]);
  assert.ok(plan.operations.every(o=>o.requestBytes>6000));assert.ok(plan.maximumRequestBytes<pricing.contextTokens);
  assert.equal(approval.capCents,42);assert.equal(plan.executionEnabled,false);
  assert.equal(savedModelInput(plan.operations[0]).readyForModel,true);
  for(const change of [
    p=>p.operations[0].request.body.state.artist.name='Other',
    p=>p.maximumRequestBytes--,p=>p.maximumSpendCents=100,
    p=>p.selections[0].tier=5,
    p=>p.capturePackets[p.operations[0].key].body.displayName='Other',
    p=>p.operations[1].channelId=p.operations[0].channelId]){
    const p=structuredClone(input);change(p);assert.throws(()=>savedModelPlan(p));
  }
  assert.throws(()=>approveSavedModels(plan,{planSha256:digest(plan),capCents:44,approvedAt:'2026-11-17T02:00:00Z'}));
});
test('public pricing increases or lost capacity stop; no input or output price is silently widened',()=>{
  checkModelQuote(pricing,pricing);
  for(const change of [{promptUsdPerToken:'0.01'},{completionUsdPerToken:'0.1'},
    {contextTokens:1024},{id:'different'}])assert.throws(()=>checkModelQuote({...pricing,...change},pricing));
});
async function executeFixture(changeBody=()=>{},status=200,n=2){
  const {plan,approval}=fixture(n),root=await fs.mkdtemp('generated-artifacts/saved-model-execution-test-');
  const events=[],sent=[];
  const gate={async start(g){events.push('start-'+g.groupIndex);},
    async admit(g,op){events.push('admit-'+op.key);},
    async returned(g,op){events.push('returned-'+op.key);},
    async finish(g,status){events.push(status+'-'+g.groupIndex);}};
  const run=()=>executeSavedModels({root,plan,approval,gate,credential:'synthetic-test-only',
    assertFrozen:async()=>{},checkPrice:async()=>{},fetchImpl:async(url,init)=>{
      events.push('fetch');sent.push(JSON.parse(init.body));const body=good();changeBody(body);
      return new Response(JSON.stringify(body),{status});
    }});
  return {plan,approval,root,events,sent,run,gate};
}
test('groups run automatically under one approval, reserve before sending, preserve results without catalog writes',async()=>{
  const f=await executeFixture(()=>{},200,21);
  try{
    const summary=await f.run();
    assert.equal(summary.returnedCalls,21);assert.equal(summary.modelReservedCents,42);
    assert.equal(summary.ownershipAccepted,0);assert.equal(summary.catalogWrites,0);
    assert.deepEqual(f.sent,f.plan.operations.map(o=>o.request.body));
    assert.deepEqual(f.events.slice(0,4),['start-0','admit-model-1','fetch','returned-model-1']);
    const results=JSON.parse(await fs.readFile(f.root+'/results.json'));
    assert.ok(results.every(r=>r.decision.status==='likely_artist_owned'&&!r.importEligible&&!r.ownershipAccepted));
    await assert.rejects(f.run());assert.equal(f.sent.length,21,'A launched worker cannot replay');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('provider errors, unknown billing, wrong model and malformed decisions preserve receipts and stop without retry',async()=>{
  const cases=[
    {status:500,change:()=>{}},{change:b=>delete b.usage},{change:b=>b.usage.cost=.03},
    {change:b=>b.model='other/model'},{change:b=>delete b.answers.verdict},
    {change:b=>b.answers.same_identity.noul=NaN}];
  for(const {change,status=200} of cases){
    const f=await executeFixture(change,status);
    try{
      await assert.rejects(f.run());assert.equal(f.sent.length,1);
      assert.ok(f.events.includes('stopped-0'));assert.ok(!f.events.includes('returned-model-1'));
      const files=await fs.readdir(f.root+'/part-1/receipts');assert.equal(files.length,2);
    }finally{await fs.rm(f.root,{recursive:true,force:true});}
  }
});
test('lost acknowledgment stops after saving the paid response, without repeating a model call',async()=>{
  const f=await executeFixture();f.gate.returned=async()=>{throw Error('synthetic lost acknowledgment');};
  try{
    await assert.rejects(f.run());assert.equal(f.sent.length,1);assert.ok(f.events.includes('stopped-0'));
    assert.equal((await fs.readdir(f.root+'/part-1/receipts')).length,2);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('model allocation exclusions check profile, artist and channel independently across run IDs',async()=>{
  const {plan}=fixture();
  for(const field of ['profile','artist','channel']){
    let queried=false;
    await assert.rejects(rejectSavedModelReplay({async query(sql,args){
      if(sql.includes('youtube_video_identity_admissions')){
        assert.ok(sql.includes('profile_id=$2 OR cm_artist=$3 OR channel_id=$4'));
        assert.deepEqual(args.slice(1),[plan.operations[0].profileId,plan.operations[0].cmArtist,plan.operations[0].channelId]);
        queried=true;return {rows:[{n:1}]};
      }return {rows:[{n:0}]};
    }},[plan.operations[0]]));assert.ok(queried,field);
  }
});
test('current Tier 1–5 movement is allowed without weakening exact artist identity',async()=>{
  const {plan}=fixture();
  const query=async sql=>sql.includes('latest_snapshot')?[{profile_id:'1',cm_artist:'101',artist:'Artist 0',
    tier:5,snapshot_at:new Date().toISOString()}]:[];
  await liveSavedModelCatalog(plan,{query})(plan.operations[0]);
  await assert.rejects(liveSavedModelCatalog(plan,{query:async sql=>sql.includes('latest_snapshot')?
    [{profile_id:'1',cm_artist:'999',artist:'Artist 0',tier:5,snapshot_at:new Date().toISOString()}]:[]})(plan.operations[0]));
});
test('source proposal operations and immutable request bytes must be the approved originals',()=>{
  const {plan}=fixture();
  const source={executable:false,modelCallsExecuted:0,operations:plan.operations};
  verifySavedModelSource({...plan,sourceProposalSha256:digest(source)},source);
  assert.throws(()=>verifySavedModelSource(plan,source));
  const changed=structuredClone(plan.operations);changed[0].request.body.model='other';
  const altered={...source,operations:changed};
  assert.throws(()=>verifySavedModelSource({...plan,sourceProposalSha256:digest(altered)},altered));
});
function fakeCoordinator(){
  let state={runs:[],admissions:[]},backup;
  const events=[];
  const client={release(){},async query(sql,args=[]){
    events.push(sql);
    if(sql==='BEGIN'){backup=structuredClone(state);return {};}
    if(sql==='COMMIT'){backup=null;return {};}
    if(sql==='ROLLBACK'){state=backup;backup=null;return {};}
    if(sql.includes('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.includes('SELECT * FROM youtube_video_identity_runs'))return {rows:state.runs.filter(r=>r.id===args[0])};
    if(sql.includes('SELECT id,owner,status,plan_sha256'))return {rows:state.runs.filter(r=>args[0].includes(r.id))};
    if(sql.includes('SELECT run_id,operation_key,profile_id'))return {rows:state.admissions.filter(r=>args[0].includes(r.run_id))};
    if(sql.includes('SELECT count(*)')){
      if(sql.includes("status='admitted'"))return {rows:[{n:sql.includes('youtube_video_identity_admissions')?
        state.admissions.filter(r=>r.status==='admitted').length:0}]};
      if(sql.includes("status='running'"))return {rows:[{n:sql.includes('youtube_video_identity_runs')?
        state.runs.filter(r=>r.status==='running'&&r.id!==args[0]).length:0}]};
      if(sql.includes("kind='model'")&&sql.includes('youtube_video_identity_admissions'))
        return {rows:[{n:state.admissions.filter(r=>r.run_id!==args[0]&&
          (r.profile_id===args[1]||r.cm_artist===args[2]||r.channel_id===args[3])).length}]};
      return {rows:[{n:0}]};
    }
    if(sql.includes('INSERT INTO youtube_video_identity_runs')){
      assert.ok(!state.runs.some(r=>r.id===args[0]));
      state.runs.push({id:args[0],owner:args[1],plan_sha256:args[2],approval_sha256:args[3],
        execution_sha256:args[4],cap_cents:args[5],status:'running',reserved_cents:0});
      return {rowCount:1};
    }
    if(sql.includes('INSERT INTO youtube_video_identity_admissions')){
      state.admissions.push({run_id:args[0],operation_key:args[1],profile_id:args[2],cm_artist:args[3],
        channel_id:args[4],kind:'model',input_sha256:args[5],reserved_cents:2,status:'admitted',
        receipt_sha256:null,raw_sha256:null,http_status:null});return {rowCount:1};
    }
    if(sql.includes('SET reserved_cents=reserved_cents+2')){
      const r=state.runs.find(r=>r.id===args[0]);assert.ok(r.reserved_cents+2<=r.cap_cents);
      r.reserved_cents+=2;return {rowCount:1};
    }
    if(sql.includes("SET status='returned'")){
      const row=state.admissions.find(r=>r.run_id===args[0]&&r.operation_key===args[1]&&r.status==='admitted');
      assert.ok(row);Object.assign(row,{status:'returned',receipt_sha256:args[2],raw_sha256:args[3],http_status:200});
      return {rowCount:1};
    }
    if(sql.includes('UPDATE youtube_video_identity_runs SET status=$2')){
      const r=state.runs.find(r=>r.id===args[0]&&r.owner===args[2]);assert.ok(r);r.status=args[1];return {rowCount:1};
    }
    if(sql.startsWith('SELECT'))return {rows:[]};
    assert.fail('Unexpected synthetic coordinator statement: '+sql);
  }};
  return {pool:{connect:async()=>client},events,get state(){return structuredClone(state);}};
}
test('coordinator commits reservations before dispatch, fences incomplete work and completes exact groups only',async()=>{
  const {plan,approval}=fixture(),coordinator=fakeCoordinator(),g=plan.groups[0];
  const gate=savedModelGate({pool:coordinator.pool,plan,source:{sourceLedgerSnapshot:{runs:[],admissions:[]}},
    approval,owner:'synthetic-owner',checkCatalog:async()=>{}});
  await gate.start(g);assert.equal(coordinator.state.runs[0].reserved_cents,0);
  await gate.admit(g,g.operations[0]);assert.equal(coordinator.state.runs[0].reserved_cents,2);
  await assert.rejects(gate.admit(g,g.operations[1]),/Uncertain/);
  assert.equal(coordinator.state.admissions.length,1);
  await gate.returned(g,g.operations[0],{syntheticReceipt:1},Buffer.from('synthetic'));
  await assert.rejects(gate.finish(g,'completed'));
  assert.equal(coordinator.state.runs[0].status,'running');
  await gate.admit(g,g.operations[1]);
  await gate.returned(g,g.operations[1],{syntheticReceipt:2},Buffer.from('synthetic2'));
  await gate.finish(g,'completed');
  assert.equal(coordinator.state.runs[0].reserved_cents,4);
  assert.equal(coordinator.state.runs[0].status,'completed');
  await assert.rejects(gate.start(g));
  assert.ok(coordinator.events.some(sql=>sql.includes('FOR UPDATE')));
});
