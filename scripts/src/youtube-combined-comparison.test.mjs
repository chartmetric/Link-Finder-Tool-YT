import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {clarifiedOwnershipRequest} from './youtube-ownership-clarity.mjs';
import {COMPARISON_POLICY} from './youtube-ownership-comparison.mjs';
import {combinedOwnershipRequest} from './youtube-combined-ownership.mjs';
import {combinedOperation,combinedComparisonPlan,approveCombinedComparison,combinedComparisonResult,
  rejectCombinedReplay,combinedReadiness,combinedComparisonGate,COMBINED_COMPARISON_POLICY} from './youtube-combined-comparison.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';
import {executeSavedModels} from './run-youtube-saved-model-checks.mjs';

function fixture(n=2){
  const operations=[],originalRows=[],priorRows=[],selections=[];
  for(let i=0;i<n;i++){
    const profileId=String(i+1),cmArtist=String(i+101),channelId='UC'+'a'.repeat(21)+'AB'[i];
    const url='https://www.youtube.com/channel/'+channelId,spotify='https://open.spotify.com/artist/'+'A'.repeat(22);
    const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
    const capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-16T00:00:00Z',
      request,inputSha256:digest(request),data:{success:true,channelId,channel:url,name:'Artist '+i,
        description:'A musician',links:[spotify]}},url);
    const artist={profileId,cmArtist,name:'Artist '+i,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
      accounts:[{profile_id:profileId,cm_artist:cmArtist,account_url:spotify}]};
    const input=youtubeVerificationInput(artist,{url,capture,title:artist.name});
    const model=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
      expectedModel:'typesafe/jev-1.13',maxRequestBytes:100000}});
    const original={key:'model-'+profileId,kind:'model',profileId,cmArtist,channelId,
      request:model.request,inputSha256:model.inputSha256,policyInputSha256:input.inputSha256,
      requestBodySha256:digest(Buffer.from(JSON.stringify(model.request.body))),requestBytes:model.bytes,proposedReservationCents:2};
    const old=clarifiedOwnershipRequest(original,capture);
    const originalAdmission={run_id:'identity-part-1',operation_key:original.key,profile_id:profileId,
      cm_artist:cmArtist,channel_id:channelId,kind:'model',input_sha256:original.inputSha256,
      reserved_cents:2,status:'returned',http_status:200,receipt_sha256:'a'.repeat(64),raw_sha256:'b'.repeat(64)};
    const comparisonAdmission={run_id:'previous-comparison-part-1',operation_key:'compare-'+profileId+'-'+channelId,
      profile_id:profileId,kind:'model',input_sha256:digest(old.request),reserved_cents:2,
      status:'returned',receipt_sha256:'c'.repeat(64),http_status:200};
    const previousResult={profileId,cmArtist,channelId,ownershipAccepted:false,importEligible:false,
      baseline:{profileId,cmArtist,channelId,modelAnswer:{requestSha256:original.inputSha256,inputSha256:original.policyInputSha256}},
      modelAnswer:{requestSha256:digest(old.request),
        inputSha256:digest({policy:COMPARISON_POLICY,state:old.request.body.state})}};
    operations.push(combinedOperation(combinedOwnershipRequest(original,capture),
      previousResult,originalAdmission,comparisonAdmission));
    originalRows.push(originalAdmission);priorRows.push(comparisonAdmission);
    selections.push({profileId,cmArtist,artist:artist.name,tier:2});
  }
  const plan=combinedComparisonPlan({version:COMBINED_COMPARISON_POLICY,
    id:'youtube-combined-comparison-synthetic',preparedAt:'2026-11-17T00:00:00Z',operations,selections,
    sourceFiles:{'generated-artifacts/synthetic-source.json':'a'.repeat(64)},
    runtimeFiles:{'runtime/synthetic.mjs':'b'.repeat(64)},
    pricing:{id:'typesafe/jev-1.13',promptUsdPerToken:'0.000000042',completionUsdPerToken:'0',contextTokens:262144},
    baselineLedgerSnapshot:{runs:[{id:'identity-part-1',status:'completed'}],admissions:originalRows},
    priorBoundedLedgerSnapshot:{runs:[{id:'previous-comparison-part-1',status:'completed',
      scope_sha256:'d'.repeat(64),cap_cents:n*2,reserved_cents:n*2}],admissions:priorRows},
    coordinatorSchemaSha256:'e'.repeat(64),failedLaunch:{id:'youtube-ownership-comparison-failed-part-1',
      status:'stopped',reservedCents:0,admissions:0,scopeSha256:'f'.repeat(64)},
    maximumSpendCents:n*2,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))});
  return {plan,approval:approveCombinedComparison(plan,{planSha256:digest(plan),capCents:n*2,
    approvedAt:'2026-11-17T01:00:00Z'})};
}
const answer=category=>({model:'typesafe/jev-1.13-20260917',usage:{cost:.0001},
  answers:{combined_assessment:{type:'choice',choice:category}}});
const receipt=(plan,op,raw)=>({runId:plan.groups[0].id,parentId:plan.id,planSha256:digest(plan.groups[0]),
  operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,kind:'model',
  inputSha256:op.inputSha256,request:op.request,status:200,rawBodySha256:digest(raw)});

test('fresh approval binds the single question, complete evidence, both baselines and exact allowance',()=>{
  const {plan,approval}=fixture();
  assert.equal(plan.executionEnabled,false);assert.equal(plan.baselineIsGroundTruth,false);
  assert.equal(approval.capCents,4);
  for(const mutate of [
    p=>p.operations[0].request.body.state.artist.name='Replacement',
    p=>p.operations[0].request=p.operations[0].draft.originalOperation.request,
    p=>p.operations[0].baseline.comparisonAdmission.status='admitted',
    p=>p.operations[0].baseline.previousResult.modelAnswer.inputSha256='a'.repeat(64),
    p=>p.priorBoundedLedgerSnapshot.runs[0].status='running',
    p=>p.operations[1].profileId=p.operations[0].profileId,
    p=>p.maximumSpendCents=6,
  ]){const changed=structuredClone(plan);mutate(changed);assert.throws(()=>combinedComparisonPlan(changed));}
  assert.throws(()=>approveCombinedComparison(plan,{...approval,capCents:6}));
  assert.throws(()=>approveCombinedComparison(plan,{...approval,planSha256:'a'.repeat(64)}));
});
test('only the two exact returned baselines are allowed; extras and uncertain or altered rows block spending',async()=>{
  const {plan}=fixture(1),op=plan.operations[0];
  const client=(identity,bounded)=>({query:async sql=>sql.includes('FROM youtube_video_identity_admissions')?
    {rows:identity}:sql.includes('FROM youtube_bounded_test_admissions')?{rows:bounded}:{rows:[{n:0}]}});
  const old=op.baseline.originalAdmission,prior=op.baseline.comparisonAdmission;
  await rejectCombinedReplay(client([old],[prior]),[op]);
  for(const rows of [[],[prior,prior],[{...prior,status:'admitted'}],
    [{...prior,receipt_sha256:'e'.repeat(64)}],[{...prior,input_sha256:op.inputSha256}]]){
    await assert.rejects(rejectCombinedReplay(client([old],rows),[op]));
  }
  await assert.rejects(rejectCombinedReplay(client([old,old],[prior]),[op]));
});
test('new answers remain experimental and bound to the new state, not either historical request',()=>{
  const {plan}=fixture(1),op=plan.operations[0];
  for(const category of ['artist_managed_supported','identity_supported_control_uncertain','topic_identity_supported']){
    const raw=Buffer.from(JSON.stringify(answer(category)));
    const result=combinedComparisonResult(plan,op,receipt(plan,op,raw),raw);
    assert.equal(result.modelAnswer.inputSha256,op.draft.stateSha256);
    assert.notEqual(result.modelAnswer.requestSha256,op.baseline.comparisonAdmission.input_sha256);
    assert.deepEqual(result.baseline,op.baseline.previousResult);
    assert.equal(result.ownershipAccepted,false);assert.equal(result.catalogWritten,false);
    if(category==='topic_identity_supported')assert.equal(result.channelTypeLabel,'Topic — auto-generated');
    const bad={...receipt(plan,op,raw),inputSha256:op.baseline.originalAdmission.input_sha256};
    assert.throws(()=>combinedComparisonResult(plan,op,bad,raw));
  }
});
test('runner reserves before dispatch, keeps receipts, refuses old approval and never launches twice',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/combined-comparison-fixture-');
  let calls=0,reserved=0,acks=0;
  const options={root,plan,approval,credential:'synthetic-only',assertFrozen:async()=>{},checkPrice:async()=>{},
    validateApproval:approveCombinedComparison,parseResult:combinedComparisonResult,
    gate:{start:async()=>{},admit:async()=>{reserved+=2;},returned:async()=>{acks++;},finish:async()=>{}},
    fetchImpl:async()=>{calls++;assert.equal(reserved,calls*2);
      return new Response(JSON.stringify(answer('identity_supported_control_uncertain')),{status:200});}};
  try{
    await assert.rejects(executeSavedModels({...options,approval:{...approval,policy:COMPARISON_POLICY}}));
    assert.equal(calls,0);
    const summary=await executeSavedModels(options);
    assert.equal(summary.returnedCalls,2);assert.equal(acks,2);assert.equal(summary.ownershipAccepted,0);
    assert.equal(summary.statuses.experimental_hold,2);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,4);
    await assert.rejects(executeSavedModels(options));assert.equal(calls,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('contradictory extra answers stop dispatch after saving the response, without retries or acknowledgment',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/combined-comparison-bad-answer-');
  let calls=0,acks=0,stopped=false;
  try{
    await assert.rejects(executeSavedModels({root,plan,approval,credential:'synthetic-only',
      assertFrozen:async()=>{},checkPrice:async()=>{},validateApproval:approveCombinedComparison,
      parseResult:combinedComparisonResult,
      gate:{start:async()=>{},admit:async()=>{},returned:async()=>{acks++;},
        finish:async(g,status)=>{stopped=status==='stopped';}},
      fetchImpl:async()=>{calls++;const data=answer('artist_managed_supported');
        data.answers.ownership_reason={type:'choice',choice:'identity_supported_control_uncertain'};
        return new Response(JSON.stringify(data),{status:200});}}),/Only one combined answer/);
    assert.equal(calls,1);assert.equal(acks,0);assert.equal(stopped,true);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

function coordinator(plan){
  let runs=[],admissions=[],before;const writes=[];
  let prior=structuredClone(plan.priorBoundedLedgerSnapshot);
  const c={release(){},async query(sql,args=[]){
    if(sql==='BEGIN'){before=structuredClone({runs,admissions});return {};}
    if(sql==='COMMIT')return {};
    if(sql==='ROLLBACK'){({runs,admissions}=before);return {};}
    if(sql.includes('information_schema.columns'))return {rows:[
      {table_name:'youtube_discovery_test_runs'},{table_name:'youtube_bounded_test_admissions'}]};
    if(sql.includes('FROM pg_constraint'))return {rows:[]};
    if(sql.includes('FROM pg_indexes'))return {rows:[{tablename:'youtube_bounded_test_admissions',
      indexdef:'CREATE UNIQUE INDEX synthetic ON youtube_bounded_test_admissions (run_id, operation_key)'}]};
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('SELECT id,status,reserved_cents,scope_sha256'))return {rows:[]};
    if(sql.startsWith('SELECT id,status,reserved_cents,plan_sha256'))return {rows:[{
      id:plan.failedLaunch.id,status:'stopped',reserved_cents:0,plan_sha256:plan.failedLaunch.scopeSha256}]};
    if(sql.startsWith('SELECT id,owner,status,plan_sha256'))return {rows:structuredClone(plan.baselineLedgerSnapshot.runs)};
    if(sql.includes('FROM youtube_video_identity_admissions')&&
      (sql.includes('WHERE run_id=ANY')||sql.includes("WHERE kind='model'"))){
      const a=plan.baselineLedgerSnapshot.admissions;
      return {rows:structuredClone(sql.includes('WHERE run_id=ANY')?a:a.filter(r=>
        r.profile_id===args[0]||r.cm_artist===args[1]||r.channel_id===args[2]))};
    }
    if(sql.includes('FROM youtube_discovery_test_runs WHERE id=ANY'))return {rows:structuredClone(prior.runs)};
    if(sql.includes('FROM youtube_bounded_test_admissions')&&sql.includes('WHERE run_id=ANY'))
      return {rows:structuredClone(prior.admissions)};
    if(sql.includes('FROM youtube_bounded_test_admissions')&&sql.includes("WHERE kind='model'"))
      return {rows:structuredClone([...prior.admissions,...admissions].filter(r=>r.profile_id===args[0]&&r.run_id!==args[1]))};
    if(sql.startsWith('SELECT count')){
      let n=0;
      if(sql.includes('FROM youtube_discovery_test_runs'))n=runs.filter(r=>r.status==='running'&&r.id!==args[0]).length;
      if(sql.includes('FROM youtube_bounded_test_admissions'))n=admissions.filter(r=>r.status==='admitted'&&r.run_id!==args[0]).length;
      return {rows:[{n}]};
    }
    if(sql.startsWith('SELECT * FROM youtube_discovery_test_runs'))return {rows:runs.filter(r=>r.id===args[0])};
    if(sql.includes('FROM youtube_bounded_test_admissions WHERE run_id=$1'))
      return {rows:admissions.filter(r=>r.run_id===args[0]).sort((a,b)=>a.operation_key.localeCompare(b.operation_key))};
    if(sql.startsWith('INSERT INTO youtube_discovery_test_runs')){
      assert.ok(!runs.some(r=>r.id===args[0]));writes.push(sql);
      runs.push({id:args[0],owner:args[1],scope_sha256:args[2],cap_cents:args[3],reserved_cents:0,status:'running'});
      return {rowCount:1};
    }
    if(sql.includes('INSERT INTO youtube_bounded_test_admissions')){
      assert.ok(!admissions.some(r=>r.run_id===args[0]&&r.operation_key===args[1]));writes.push(sql);
      admissions.push({run_id:args[0],operation_key:args[1],profile_id:args[2],kind:'model',input_sha256:args[3],
        reserved_cents:2,status:'admitted',receipt_sha256:null,http_status:null});return {rowCount:1};
    }
    if(sql.includes('SET reserved_cents=reserved_cents+2')){
      const r=runs.find(r=>r.id===args[0]);assert.ok(r.reserved_cents+2<=r.cap_cents);r.reserved_cents+=2;return {rowCount:1};
    }
    if(sql.includes("UPDATE youtube_bounded_test_admissions SET status='returned'")){
      const r=admissions.find(r=>r.run_id===args[0]&&r.operation_key===args[1]&&r.status==='admitted');assert.ok(r);
      Object.assign(r,{status:'returned',receipt_sha256:args[4],http_status:200});return {rowCount:1};
    }
    if(sql.includes('UPDATE youtube_discovery_test_runs SET status=$2')){
      const r=runs.find(r=>r.id===args[0]&&r.owner===args[2]);assert.ok(r);r.status=args[1];return {rowCount:1};
    }
    if(sql.startsWith('SELECT'))return {rows:[]}; // No synthetic historical ownership claims.
    assert.fail('Unexpected write: '+sql);
  }};
  return {client:c,pool:{connect:async()=>c},writes,state:()=>structuredClone({runs,admissions}),
    changePrior:()=>{prior.admissions[0].receipt_sha256='f'.repeat(64);}};
}
test('bounded coordinator pins both histories, reserves atomically and holds uncertain admissions',async()=>{
  const original=fixture().plan,db=coordinator(original);
  const plan=combinedComparisonPlan({...original,coordinatorSchemaSha256:digest(await boundedComparisonSchema(db.client))});
  const approval=approveCombinedComparison(plan,{planSha256:digest(plan),capCents:4,approvedAt:'2026-11-17T01:00:00Z'});
  const gate=combinedComparisonGate({pool:db.pool,plan,approval,owner:'synthetic-owner',checkCatalog:async()=>{}});
  const g=plan.groups[0];await gate.start(g);await gate.admit(g,g.operations[0]);
  await assert.rejects(gate.admit(g,g.operations[1]),/Uncertain/);
  assert.equal(db.state().runs[0].reserved_cents,2);
  const raw=Buffer.from(JSON.stringify(answer('artist_managed_supported')));
  const r=op=>({...receipt(plan,op,raw),approvalSha256:digest(approval)});
  await gate.returned(g,g.operations[0],r(g.operations[0]),raw);
  await assert.rejects(gate.finish(g,'completed'));
  await gate.admit(g,g.operations[1]);await gate.returned(g,g.operations[1],r(g.operations[1]),raw);
  await gate.finish(g,'completed');assert.equal(db.state().runs[0].reserved_cents,4);
  await assert.rejects(gate.start(g));
  assert.equal(db.writes.filter(s=>s.includes('INSERT INTO youtube_bounded_test_admissions')).length,2);
  assert.ok(db.writes.every(s=>!s.includes('youtube_video_identity')));
  db.changePrior();await assert.rejects(combinedReadiness(db.client,plan),/Prior paid comparison changed/);
});
