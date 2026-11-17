import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {youtubeDecisionRequest,normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {savedModelResult} from './youtube-saved-verification-execution.mjs';
import {comparisonOperation,comparisonPlan,approveComparison,rejectComparisonReplay,
  comparisonResult,COMPARISON_POLICY} from './youtube-ownership-comparison.mjs';
import {executeSavedModels} from './run-youtube-saved-model-checks.mjs';

function fixture(n=2){
  const operations=[],admissions=[],selections=[];
  for(let i=0;i<n;i++){
    const profileId=String(i+1),cmArtist=String(i+101),channelId='UC'+'a'.repeat(21)+'AB'[i];
    const url='https://www.youtube.com/channel/'+channelId,spotify='https://open.spotify.com/artist/'+'AB'[i].repeat(22);
    const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
    const capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-16T00:00:00Z',
      request,inputSha256:digest(request),data:{success:true,channelId,channel:url,name:'Synthetic Artist '+i,
        description:'Synthetic musician',links:[spotify]}},url);
    const artist={profileId,cmArtist,name:'Synthetic Artist '+i,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
      accounts:[{profile_id:profileId,cm_artist:cmArtist,account_url:spotify}],releases:[]};
    const input=youtubeVerificationInput(artist,{url,capture,title:artist.name});
    const q=youtubeDecisionRequest(input,{model:{expectedModel:'typesafe/jev-1.13',
      endpoint:'https://openrouter.ai/api/alpha/decisions',maxRequestBytes:50000}});
    const original={kind:'model',key:'model-'+profileId,profileId,cmArtist,channelId,request:q.request,
      inputSha256:q.inputSha256,policyInputSha256:input.inputSha256,requestBytes:q.bytes,
      requestBodySha256:digest(Buffer.from(JSON.stringify(q.request.body))),proposedReservationCents:2};
    const oldRaw=Buffer.from(JSON.stringify(answer({verdict:'uncertain',channelType:'unknown'})));
    const oldReceipt={request:q.request,inputSha256:q.inputSha256,capturedAt:'2026-11-17T01:00:00Z',status:200};
    const oldResult=savedModelResult({maximumRequestBytes:q.bytes,capturePackets:{[original.key]:capture}},
      original,oldReceipt,oldRaw);
    const row={run_id:'synthetic-baseline-part-1',operation_key:original.key,profile_id:profileId,cm_artist:cmArtist,
      channel_id:channelId,kind:'model',input_sha256:q.inputSha256,reserved_cents:2,status:'returned',
      http_status:200,receipt_sha256:digest(oldReceipt),raw_sha256:digest(oldRaw)};
    admissions.push(row);operations.push(comparisonOperation(original,capture,oldResult,row));
    selections.push({profileId,cmArtist,artist:artist.name,tier:2+i});
  }
  const plan=comparisonPlan({version:COMPARISON_POLICY,id:'youtube-ownership-comparison-synthetic',
    preparedAt:'2026-11-17T02:00:00Z',operations,selections,deferred:[],
    maximumSpendCents:n*2,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes)),
    baselineLedgerSnapshot:{runs:[{id:'synthetic-baseline-part-1',status:'completed'}],admissions},
    runtimeFiles:{'runtime/synthetic.mjs':digest('synthetic')},
    sourceFiles:{'generated-artifacts/synthetic/source.json':digest('source')},
    pricing:{id:'typesafe/jev-1.13',promptUsdPerToken:'0.000000042',completionUsdPerToken:'0',contextTokens:262144}});
  const approval=approveComparison(plan,{planSha256:digest(plan),capCents:n*2,approvedAt:'2026-11-17T03:00:00Z'});
  return {plan,approval};
}
function answer({verdict='likely',channelType='artist_owned',reason='combined_identity_and_control',cost=.00001}={}){
  return {model:'typesafe/jev-1.13-20260917',usage:{cost},answers:{
    same_identity:{type:'noul',noul:.71},verdict:{type:'choice',choice:verdict},
    channel_type:{type:'choice',choice:channelType},ownership_reason:{type:'choice',choice:reason}}};
}
function receipt(plan,op,raw){
  return {runId:plan.groups[0].id,parentId:plan.id,planSha256:digest(plan.groups[0]),kind:'model',
    operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
    request:op.request,inputSha256:op.inputSha256,status:200,rawBodySha256:digest(raw),
    capturedAt:'2026-11-17T03:10:00Z'};
}
test('a new exact approval permits changed questions, not replay of old questions or substitution',()=>{
  const {plan,approval}=fixture();
  assert.equal(plan.maximumSpendCents,4);assert.equal(approval.explicitApproval,true);
  assert.equal(plan.executionEnabled,false);assert.equal(plan.baselineIsGroundTruth,false);
  for(const op of plan.operations){
    assert.notEqual(op.inputSha256,op.baseline.operation.inputSha256);
    assert.deepEqual(op.request.body.state.artist,op.baseline.operation.request.body.state.artist);
    assert.deepEqual(op.request.body.state.candidate,op.baseline.operation.request.body.state.candidate);
  }
  for(const mutate of [
    p=>p.operations[0].request.body.state.artist.name='Another artist',
    p=>p.operations[0].request=p.operations[0].baseline.operation.request,
    p=>p.operations[0].baseline.admission.status='admitted',
    p=>p.operations[0].baseline.result.profileId='999',
    p=>p.operations[1].channelId=p.operations[0].channelId,
    p=>p.selections[0].tier=5,
  ]){
    const changed=structuredClone(plan);mutate(changed);assert.throws(()=>comparisonPlan(changed));
  }
  assert.throws(()=>approveComparison(plan,{...approval,capCents:6}));
  assert.throws(()=>approveComparison(plan,{...approval,planSha256:'a'.repeat(64)}));
});
test('only the exact returned baseline may pre-exist; additional, changed or uncertain allocations block',async()=>{
  const {plan}=fixture(1),op=plan.operations[0];
  const client=rows=>({query:async(sql)=>sql.includes('FROM youtube_video_identity_admissions')?
    {rows}:{rows:[{n:0}]}});
  await rejectComparisonReplay(client([op.baseline.admission]),[op]);
  for(const rows of [[],[op.baseline.admission,op.baseline.admission],
    [{...op.baseline.admission,status:'admitted'}],[{...op.baseline.admission,input_sha256:'a'.repeat(64)}],
    [{...op.baseline.admission,channel_id:'UC'+'b'.repeat(22)}]])
    await assert.rejects(rejectComparisonReplay(client(rows),[op]));
});
test('new explanations and scores stay bound to new requests; experimental support never accepts a link',()=>{
  const {plan}=fixture(1),op=plan.operations[0],raw=Buffer.from(JSON.stringify(answer()));
  const r=comparisonResult(plan,op,receipt(plan,op,raw),raw);
  assert.equal(r.decision.status,'experimental_support');
  assert.equal(r.modelAnswer.reasonCode,'combined_identity_and_control');
  assert.equal(r.modelAnswer.inputSha256,op.comparisonStateSha256);
  assert.notEqual(r.modelAnswer.inputSha256,op.baseline.operation.policyInputSha256);
  assert.deepEqual(r.baseline,op.baseline.result);
  assert.equal(r.ownershipAccepted,false);assert.equal(r.importEligible,false);assert.equal(r.catalogWritten,false);
  assert.equal(r.decision.reviewSuggestion,false);
  for(const patch of [
    {channelType:'unknown',reason:'identity_supported_control_uncertain'},
    {channelType:'artist_owned',verdict:'uncertain',reason:'insufficient_capture'},
    {channelType:'topic',reason:'topic_presence'},
    {channelType:'organization',reason:'third_party_channel'},
  ]){
    const bytes=Buffer.from(JSON.stringify(answer(patch)));
    const held=comparisonResult(plan,op,receipt(plan,op,bytes),bytes);
    assert.equal(held.decision.status,'experimental_hold');
    if(patch.channelType==='topic')assert.equal(held.channelTypeLabel,'Topic — auto-generated');
  }
  for(const patch of [{cost:.03},{reason:'invented_reason'}]){
    const bytes=Buffer.from(JSON.stringify(answer(patch)));
    assert.throws(()=>comparisonResult(plan,op,receipt(plan,op,bytes),bytes));
  }
  const bad=receipt(plan,op,raw);bad.inputSha256=op.baseline.operation.inputSha256;
  assert.throws(()=>comparisonResult(plan,op,bad,raw));
});
test('shared runner reserves before each new request, retains receipts and rejects a second launch',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/youtube-comparison-fixture-');
  let calls=0,reserved=0,acknowledged=0,finished=false;
  const gate={start:async()=>{},admit:async()=>{reserved+=2;},
    returned:async()=>{acknowledged++;},finish:async(g,status)=>{finished=status==='completed';}};
  const run=()=>executeSavedModels({root,plan,approval,gate,credential:'synthetic-only',assertFrozen:async()=>{},
    checkPrice:async()=>{},validateApproval:approveComparison,parseResult:comparisonResult,
    fetchImpl:async()=>{calls++;assert.equal(reserved,calls*2);return new Response(JSON.stringify(answer()),{status:200});}});
  try{
    const summary=await run();
    assert.equal(calls,2);assert.equal(acknowledged,2);assert.equal(finished,true);
    assert.equal(summary.ownershipAccepted,0);assert.equal(summary.statuses.experimental_support,2);
    await assert.rejects(run());assert.equal(calls,2);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,4);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('a malformed reason stops after saving the paid response without retrying',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/youtube-comparison-failure-');
  let calls=0,acknowledged=0,stopped=false;
  try{
    await assert.rejects(executeSavedModels({root,plan,approval,
      gate:{start:async()=>{},admit:async()=>{},returned:async()=>{acknowledged++;},
        finish:async(g,status)=>{stopped=status==='stopped';}},
      credential:'synthetic-only',assertFrozen:async()=>{},checkPrice:async()=>{},
      validateApproval:approveComparison,parseResult:comparisonResult,
      fetchImpl:async()=>{calls++;const data=answer();delete data.answers.ownership_reason;
        return new Response(JSON.stringify(data),{status:200});}}),/reason/);
    assert.equal(calls,1);assert.equal(acknowledged,0);assert.equal(stopped,true);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
