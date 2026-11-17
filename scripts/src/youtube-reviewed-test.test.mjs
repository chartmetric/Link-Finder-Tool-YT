import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {reviewedInput,reviewedCohort,reviewedCaptureOperation,reviewedCapturePlan,
  approveReviewedCaptures,reviewedCaptureResult,reviewedCaptureGate,REVIEWED_TEST_POLICY} from './youtube-reviewed-test.mjs';
import {executeReviewedCaptures} from './run-youtube-reviewed-captures.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';

function fixture(){
  const inputs=[],grading=[];
  for(let i=0;i<16;i++){
    const profileId=String(i+1),cmArtist=String(i+101),channelId='UC'+'a'.repeat(21)+'ABCDEFGHIJKLMNOP'[i];
    const url='https://www.youtube.com/channel/'+channelId;
    const artist={profileId,cmArtist,name:'Artist '+i,catalogProfile:{profile_id:profileId,cm_artist:cmArtist},
      accounts:[],releases:[]};
    let capture=null;
    if(i<8){
      const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
      capture=normalizeYoutubeChannel({kind:'metadata',status:200,at:'2026-11-14T00:00:00Z',request,
        inputSha256:digest(request),data:{success:true,channelId,channel:url,name:artist.name+(i>=6?' - Topic':'')}},url);
    }
    const row=reviewedInput({artist,url,capture,sourceObservedAt:'2026-11-14T00:00:00Z',
      sourceRefs:['generated-artifacts/synthetic/source.json'],startingTier:2});
    inputs.push(row);grading.push({caseId:row.caseId,userFeedback:i<8?'looks_correct':'rejected',
      labelScope:'historical_user_feedback',ownershipAdjudication:null,catalogWritesAuthorized:false,
      sourceRefs:['generated-artifacts/synthetic/labels.json']});
  }
  const operations=inputs.filter(i=>!i.channelCaptureAvailable).map(reviewedCaptureOperation);
  const plan=reviewedCapturePlan({id:'youtube-reviewed-test-captures-synthetic',version:REVIEWED_TEST_POLICY,
    preparedAt:'2026-11-17T00:00:00Z',inputs,grading,operations,maximumSpendCents:16,
    selections:inputs.slice(8).map(i=>({profileId:i.profileId,cmArtist:i.cmArtist,artist:i.artist.name,tier:2})),
    coordinatorSchemaSha256:'a'.repeat(64),sourceFiles:{'generated-artifacts/synthetic.json':'b'.repeat(64)},
    runtimeFiles:{'runtime/synthetic.mjs':'c'.repeat(64)}});
  return {plan,approval:approveReviewedCaptures(plan,{planSha256:digest(plan),capCents:16,approvedAt:'2026-11-17T01:00:00Z'})};
}
const rawFor=op=>Buffer.from(JSON.stringify({success:true,credits_charged:1,channelId:op.channelId,
  channel:op.targetUrl,name:'Test channel'}));
const receipt=(plan,op,raw)=>({runId:plan.groups[0].id,parentId:plan.id,planSha256:digest(plan.groups[0]),
  operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,kind:'metadata',
  inputSha256:op.inputSha256,request:op.request,status:200,rawBodySha256:digest(raw),capturedAt:'2026-11-17T01:00:00Z'});
test('balanced historical feedback stays outside checker inputs and unknown ownership is not invented',()=>{
  const {plan}=fixture(),cohort=reviewedCohort(plan.inputs,plan.grading);
  assert.equal(cohort.summary.positiveFeedback,8);assert.equal(cohort.summary.explicitRejections,8);
  assert.equal(cohort.summary.positiveTopicExamples,2);assert.equal(cohort.summary.ownershipAccuracyScorable,false);
  assert.equal(cohort.summary.missingChannelCaptures,8);
  assert.ok(plan.inputs.slice(8).every(r=>r.inputPreview.readyForModel===false));
  assert.ok(plan.inputs.every(r=>!JSON.stringify(r.inputPreview).includes('userFeedback')));
  const leaked=structuredClone(plan.inputs[0]);leaked.artist.userReview='looks_correct';
  assert.throws(()=>reviewedInput(leaked));
  const changed=structuredClone(plan);changed.inputs[8].capture=plan.inputs[0].capture;
  assert.throws(()=>reviewedCapturePlan(changed));
  assert.throws(()=>reviewedCaptureOperation(plan.inputs[0]));
});
test('capture approval cannot cover models, changed pairs, altered labels or a larger allowance',()=>{
  const {plan,approval}=fixture();
  assert.equal(plan.modelStageApproved,false);assert.equal(plan.modelCalls,0);assert.equal(plan.channelClaimWrites,0);
  for(const mutate of [
    p=>p.operations[0].kind='model',p=>p.operations[0].targetUrl=p.operations[1].targetUrl,
    p=>p.grading[0].ownershipAdjudication=true,p=>p.maximumSpendCents=18,
  ]){const p=structuredClone(plan);mutate(p);assert.throws(()=>reviewedCapturePlan(p));}
  assert.throws(()=>approveReviewedCaptures(plan,{...approval,planSha256:'a'.repeat(64)}));
  assert.throws(()=>approveReviewedCaptures(plan,{...approval,capCents:32}));
});
test('deferring a case can shrink both sides without weakening eligibility or manufacturing labels',()=>{
  const {plan}=fixture();
  const inputs=plan.inputs.filter((r,i)=>i!==5&&i!==15);
  const ids=new Set(inputs.map(i=>i.caseId)),grading=plan.grading.filter(g=>ids.has(g.caseId));
  const cohort=reviewedCohort(inputs,grading);
  assert.equal(cohort.summary.examples,14);assert.equal(cohort.summary.positiveFeedback,7);
  assert.equal(cohort.summary.explicitRejections,7);assert.equal(cohort.summary.positiveTopicExamples,2);
  const operations=inputs.filter(i=>!i.channelCaptureAvailable).map(reviewedCaptureOperation);
  const p=reviewedCapturePlan({...plan,inputs,grading,operations,maximumSpendCents:14,
    selections:plan.selections.filter(s=>operations.some(o=>o.profileId===s.profileId))});
  assert.equal(p.maximumSpendCents,14);assert.equal(p.modelStageApproved,false);
});
test('raw channel responses bind to the exact request; bad status, billing or identity never becomes usable evidence',()=>{
  const {plan}=fixture(),op=plan.operations[0],raw=rawFor(op),r=receipt(plan,op,raw);
  const result=reviewedCaptureResult(plan,op,r,raw);
  assert.equal(result.transportOnly,true);assert.equal(result.channelClaimsWritten,false);
  assert.equal(result.ownershipAccepted,false);assert.equal(result.reviewLabelsChanged,false);
  for(const patch of [{credits_charged:2},{credits_charged:null},{success:false},{channelId:'UC'+'z'.repeat(22)}]){
    const bytes=Buffer.from(JSON.stringify({...JSON.parse(raw),...patch}));
    assert.throws(()=>reviewedCaptureResult(plan,op,receipt(plan,op,bytes),bytes));
  }
  assert.throws(()=>reviewedCaptureResult(plan,op,{...r,status:500},raw));
  assert.throws(()=>reviewedCaptureResult(plan,op,{...r,profileId:'999'},raw));
});
test('metadata uses GET, reserves first, saves raw evidence, never starts models and cannot rerun',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/reviewed-captures-fixture-');
  let calls=0,reserved=0,acks=0;
  const run=()=>executeReviewedCaptures({root,plan,approval,credential:'synthetic-only',assertFrozen:async()=>{},
    gate:{start:async()=>{},admit:async()=>{reserved+=2;},returned:async()=>{acks++;},finish:async()=>{}},
    fetchImpl:async(url,options)=>{const op=plan.operations[calls];calls++;
      assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(url,op.request.url);
      assert.equal(reserved,calls*2);return new Response(rawFor(op),{status:200});}});
  try{
    const summary=await run();assert.equal(calls,8);assert.equal(acks,8);
    assert.equal(summary.modelCalls,0);assert.equal(summary.channelClaimWrites,0);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,16);
    await assert.rejects(run());assert.equal(calls,8);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('failed capture preserves the charged response, stops and never retries',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/reviewed-captures-failure-');
  let calls=0,acks=0,stopped=false;
  try{
    await assert.rejects(executeReviewedCaptures({root,plan,approval,credential:'synthetic-only',assertFrozen:async()=>{},
      gate:{start:async()=>{},admit:async()=>{},returned:async()=>{acks++;},
        finish:async(g,status)=>{stopped=status==='stopped';}},
      fetchImpl:async()=>{calls++;return new Response('{"error":"failed"}',{status:500});}}));
    assert.equal(calls,1);assert.equal(acks,0);assert.equal(stopped,true);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
function metadataCoordinator(){
  let runs=[],rows=[],before;const writes=[];
  const c={release(){},async query(sql,a=[]){
    if(sql==='BEGIN'){before=structuredClone({runs,rows});return {};}
    if(sql==='COMMIT')return {};
    if(sql==='ROLLBACK'){({runs,rows}=before);return {};}
    if(sql.includes('information_schema.columns'))return {rows:[{table_name:'youtube_discovery_test_runs'},{table_name:'youtube_bounded_test_admissions'}]};
    if(sql.includes('FROM pg_constraint'))return {rows:[]};
    if(sql.includes('FROM pg_indexes'))return {rows:[{tablename:'youtube_bounded_test_admissions',
      indexdef:'CREATE UNIQUE INDEX synthetic ON youtube_bounded_test_admissions (run_id, operation_key)'}]};
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('SELECT count')){
      let n=0;
      if(sql.includes('FROM youtube_discovery_test_runs'))n=runs.filter(r=>r.status==='running'&&r.id!==a[0]).length;
      if(sql.includes('FROM youtube_bounded_test_admissions')){
        n=sql.includes("status='admitted'")?rows.filter(r=>r.status==='admitted'&&r.run_id!==a[0]).length:
          rows.filter(r=>r.kind==='metadata'&&(r.profile_id===a[0]||r.input_sha256===a[2])&&r.run_id!==a[1]).length;
      }
      return {rows:[{n}]};
    }
    if(sql.startsWith('SELECT * FROM youtube_discovery_test_runs'))return {rows:runs.filter(r=>r.id===a[0])};
    if(sql.includes('FROM youtube_bounded_test_admissions WHERE run_id=$1'))
      return {rows:rows.filter(r=>r.run_id===a[0]).sort((x,y)=>x.operation_key.localeCompare(y.operation_key))};
    writes.push(sql);
    if(sql.startsWith('INSERT INTO youtube_discovery_test_runs')){
      runs.push({id:a[0],owner:a[1],scope_sha256:a[2],cap_cents:a[3],reserved_cents:0,status:'running'});return {rowCount:1};}
    if(sql.includes('INSERT INTO youtube_bounded_test_admissions')){
      rows.push({run_id:a[0],operation_key:a[1],profile_id:a[2],input_sha256:a[3],kind:a[4],
        reserved_cents:2,status:'admitted',receipt_sha256:null,http_status:null});return {rowCount:1};}
    if(sql.includes('SET reserved_cents=reserved_cents+2')){
      const r=runs.find(r=>r.id===a[0]);assert.ok(r.reserved_cents+2<=r.cap_cents);r.reserved_cents+=2;return {rowCount:1};}
    if(sql.includes("UPDATE youtube_bounded_test_admissions SET status='returned'")){
      const r=rows.find(r=>r.run_id===a[0]&&r.operation_key===a[1]);assert.ok(r);
      Object.assign(r,{status:'returned',receipt_sha256:a[4],http_status:200});return {rowCount:1};}
    if(sql.includes('UPDATE youtube_discovery_test_runs SET status=$2')){
      runs.find(r=>r.id===a[0]).status=a[1];return {rowCount:1};}
    assert.fail('Unexpected SQL: '+sql);
  }};
  return {c,pool:{connect:async()=>c},writes,state:()=>structuredClone({runs,rows})};
}
test('real gate records metadata, blocks uncertain dispatch and never writes artist/channel claims',async()=>{
  const db=metadataCoordinator(),original=fixture().plan;
  const plan=reviewedCapturePlan({...original,coordinatorSchemaSha256:digest(await boundedComparisonSchema(db.c))});
  const approval=approveReviewedCaptures(plan,{planSha256:digest(plan),capCents:16,approvedAt:'2026-11-17T01:00:00Z'});
  const gate=reviewedCaptureGate({pool:db.pool,plan,approval,owner:'synthetic',checkCatalog:async()=>{}});
  const g=plan.groups[0];await gate.start(g);await gate.admit(g,g.operations[0]);
  assert.equal(db.state().rows[0].kind,'metadata');
  await assert.rejects(gate.admit(g,g.operations[1]),/Uncertain/);
  for(let i=0;i<g.operations.length;i++){
    const op=g.operations[i];if(i)await gate.admit(g,op);
    const raw=rawFor(op);await gate.returned(g,op,{...receipt(plan,op,raw),approvalSha256:digest(approval)},raw);
  }
  await gate.finish(g,'completed');await assert.rejects(gate.start(g));
  assert.equal(db.state().runs[0].reserved_cents,16);
  assert.ok(db.writes.every(sql=>!sql.includes('channel_claims')&&!sql.includes('youtube_video_identity')));
});
