import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedVerificationFixture,syntheticReceipt} from './youtube-reviewed-verification-fixture.mjs';
import {reviewedVerificationPlan,approveReviewedVerification,reviewedVerificationResult,
  reviewedVerificationGate} from './youtube-reviewed-verification.mjs';
import {executeSavedModels} from './run-youtube-saved-model-checks.mjs';
import {boundedComparisonSchema} from './youtube-ownership-comparison-gate.mjs';

const modelBytes=(choice='identity_uncertain',extra={})=>Buffer.from(JSON.stringify({
  model:'typesafe/jev-1.13-20260917',usage:{cost:.0001},
  answers:{combined_assessment:{type:'choice',choice}},...extra}));
function result(plan,approval,op,choice){
  const raw=modelBytes(choice);return reviewedVerificationResult(plan,op,syntheticReceipt(plan,approval,op,raw),raw);
}
test('all 14 complete captures generate one fresh question each with no feedback or paid-baseline invention',()=>{
  const {plan}=reviewedVerificationFixture();
  assert.equal(plan.inputs.length,14);assert.equal(plan.operations.length,14);
  assert.equal(plan.grading.filter(g=>g.userFeedback==='rejected').length,7);
  assert.equal(plan.maximumSpendCents,28);assert.equal(plan.ownershipAccuracyScorable,false);
  assert.equal(plan.sourceLedgerSnapshot.admissions.length,7);
  assert.ok(plan.sourceLedgerSnapshot.admissions.every(r=>r.kind==='metadata'&&r.status==='returned'));
  for(const op of plan.operations){
    assert.deepEqual(Object.keys(op.request.body.questions),['combined_assessment']);
    assert.equal(op.templateRequestWasNeverSent,true);assert.equal(op.ownershipAccepted,false);
    assert.equal(op.request.body.state.artist.profileId,op.profileId);
    assert.equal(op.request.body.state.candidate.channelCapture.body.channelId,op.channelId);
    assert.doesNotMatch(JSON.stringify(op.request.body),/"(?:userFeedback|userReview|grading|expectedVerdict|labelScope)"\s*:/i);
  }
});
test('fresh approval binds exact source evidence, all pairs, hidden feedback, runtime, question and allowance',()=>{
  const {plan,approval}=reviewedVerificationFixture();
  assert.deepEqual(approveReviewedVerification(plan,approval),approval);
  for(const mutate of [
    p=>p.maximumSpendCents=26,p=>p.grading[0].userFeedback='rejected',
    p=>p.operations[0].request.body.state.userFeedback='looks_correct',
    p=>p.captureResponses[0].receipt.channelId='UC'+'z'.repeat(22),
    p=>p.sourceLedgerSnapshot.admissions[0].kind='model',
    p=>delete p.sourceFiles['generated-artifacts/synthetic/source.json'],
    p=>p.operations.pop(),p=>p.pricing.promptUsdPerToken='0.01',
  ]){
    const p=structuredClone(plan);mutate(p);assert.throws(()=>reviewedVerificationPlan(p));
  }
  assert.throws(()=>approveReviewedVerification(plan,{...approval,planSha256:'0'.repeat(64)}));
  assert.throws(()=>approveReviewedVerification(plan,{...approval,capCents:30}));
});
test('known review vetoes cannot hide raw model disagreements or create apparent correct rejections',()=>{
  const {plan,approval}=reviewedVerificationFixture();
  const bad=plan.operations.find(o=>o.profileId==='257398');
  const supported=result(plan,approval,bad,'artist_managed_supported');
  assert.equal(supported.decision.status,'experimental_safety_hold');
  assert.equal(supported.feedbackComparison.rawModelOutcome,'supports_link');
  assert.equal(supported.feedbackComparison.agreesWithHistoricalFeedback,false);
  assert.equal(supported.feedbackComparison.safetyVetoCountedAsAgreement,false);
  assert.equal(supported.ownershipAccepted,false);assert.equal(supported.importEligible,false);
  for(const category of ['identity_supported_control_uncertain','identity_uncertain',
    'topic_identity_uncertain','conflicting_evidence','insufficient_capture']){
    const r=result(plan,approval,bad,category);
    assert.equal(r.feedbackComparison.rawModelOutcome,'unresolved');
    assert.equal(r.feedbackComparison.agreesWithHistoricalFeedback,null);
  }
  assert.equal(result(plan,approval,bad,'third_party_channel').feedbackComparison.agreesWithHistoricalFeedback,true);
});
test('Topic labels stay visible for right and wrong pairings without claiming artist management',()=>{
  const {plan,approval}=reviewedVerificationFixture();
  for(const profileId of ['6','14']){
    const op=plan.operations.find(o=>o.profileId===profileId),r=result(plan,approval,op,'topic_identity_supported');
    assert.equal(r.channelTypeLabel,'Topic — auto-generated');assert.equal(r.modelAssessment.artistOwned,false);
    assert.equal(r.feedbackComparison.agreesWithHistoricalFeedback,profileId==='6');
    assert.equal(r.ownershipAccepted,false);
  }
});
test('wrong receipt bindings, malformed answers, unexpected models and excessive charges remain unusable',()=>{
  const {plan,approval}=reviewedVerificationFixture(),op=plan.operations[0];
  for(const raw of [modelBytes('nonexistent'),modelBytes('identity_uncertain',{model:'other'}),
    modelBytes('identity_uncertain',{usage:{cost:.03}}),modelBytes('identity_uncertain',{usage:{}}),
    modelBytes('identity_uncertain',{answers:{combined_assessment:{type:'choice',choice:'identity_uncertain'},score:.9}})]){
    assert.throws(()=>reviewedVerificationResult(plan,op,syntheticReceipt(plan,approval,op,raw),raw));
  }
  const raw=modelBytes(),packet=syntheticReceipt(plan,approval,op,raw);
  for(const edit of [r=>r.status=500,r=>r.kind='metadata',r=>r.profileId='999',r=>r.inputSha256='0'.repeat(64)]){
    const r=structuredClone(packet);edit(r);assert.throws(()=>reviewedVerificationResult(plan,op,r,raw));
  }
});
test('executor only posts the 14 approved model bodies, reserves first, saves receipts and cannot launch twice',async()=>{
  const {plan,approval}=reviewedVerificationFixture(),root=await fs.mkdtemp(os.tmpdir()+'/reviewed-models-');
  let calls=0,admitted=0,returned=0;
  const gate={start:async()=>{},admit:async()=>{admitted++;},returned:async()=>{returned++;},finish:async()=>{}};
  const run=()=>executeSavedModels({root,plan,approval,gate,credential:'synthetic-only',assertFrozen:async()=>{},
    checkPrice:async()=>{},validateApproval:approveReviewedVerification,parseResult:reviewedVerificationResult,
    fetchImpl:async(url,options)=>{
      assert.equal(admitted,calls+1);assert.equal(options.method,'POST');
      assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
      assert.deepEqual(JSON.parse(options.body),plan.operations[calls].request.body);
      calls++;return new Response(modelBytes(),{status:200});
    }});
  try{
    const summary=await run();assert.equal(calls,14);assert.equal(returned,14);
    assert.equal(summary.modelReservedCents,28);assert.equal(summary.metadataCalls,0);
    assert.equal(summary.ownershipAccepted,0);assert.equal(summary.catalogWrites,0);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,28);
    const results=JSON.parse(await fs.readFile(root+'/results.json'));
    assert.ok(results.every(r=>r.feedbackComparison.agreesWithHistoricalFeedback===null));
    await assert.rejects(run());assert.equal(calls,14);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('a bad paid answer is saved and stops the test without an acknowledgment or retry',async()=>{
  const {plan,approval}=reviewedVerificationFixture(),root=await fs.mkdtemp(os.tmpdir()+'/reviewed-models-fail-');
  let calls=0,acks=0,stopped=false;
  try{
    await assert.rejects(executeSavedModels({root,plan,approval,credential:'synthetic-only',
      assertFrozen:async()=>{},checkPrice:async()=>{},validateApproval:approveReviewedVerification,
      parseResult:reviewedVerificationResult,
      gate:{start:async()=>{},admit:async()=>{},returned:async()=>{acks++;},finish:async(g,s)=>{stopped=s==='stopped';}},
      fetchImpl:async()=>{calls++;return new Response(modelBytes('nonexistent'),{status:200});}}));
    assert.equal(calls,1);assert.equal(acks,0);assert.equal(stopped,true);
    assert.equal((await fs.readdir(root+'/part-1/receipts')).length,2);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

function modelCoordinator({runs=[],admissions=[],priorProfile=null}={}){
  let rs=structuredClone(runs),rows=structuredClone(admissions),before;const writes=[];
  const c={release(){},async query(sql,a=[]){
    sql=sql.replace(/\s+/g,' ').trim();
    if(sql==='BEGIN'){before=structuredClone({rs,rows});return {};}
    if(sql==='COMMIT')return {};
    if(sql==='ROLLBACK'){({rs,rows}=before);return {};}
    if(sql.includes('information_schema.columns'))return {rows:[{table_name:'youtube_discovery_test_runs'},{table_name:'youtube_bounded_test_admissions'}]};
    if(sql.includes('FROM pg_constraint'))return {rows:[]};
    if(sql.includes('FROM pg_indexes'))return {rows:[{tablename:'youtube_bounded_test_admissions',
      indexdef:'CREATE UNIQUE INDEX synthetic ON youtube_bounded_test_admissions (run_id, operation_key)'}]};
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('SELECT count')){
      let n=0;
      if(sql.includes('FROM youtube_discovery_test_runs'))n=rs.filter(r=>r.status==='running'&&r.id!==a[0]).length;
      else if(sql.includes('FROM youtube_bounded_test_admissions')){
        n=sql.includes("status='admitted'")?rows.filter(r=>r.status==='admitted'&&r.run_id!==a[0]).length:
          rows.filter(r=>r.kind==='model'&&(r.profile_id===a[0]||r.input_sha256===a[2])&&r.run_id!==a[1]).length;
        if(priorProfile&&a[0]===priorProfile&&sql.includes("kind='model'"))n++;
      }return {rows:[{n}]};
    }
    if(sql.includes('FROM youtube_discovery_test_runs WHERE id=ANY'))return {rows:rs.filter(r=>a[0].includes(r.id))};
    if(sql.startsWith('SELECT * FROM youtube_discovery_test_runs'))return {rows:rs.filter(r=>r.id===a[0])};
    if(sql.includes('FROM youtube_bounded_test_admissions WHERE run_id=ANY'))
      return {rows:rows.filter(r=>a[0].includes(r.run_id))};
    if(sql.includes('FROM youtube_bounded_test_admissions WHERE run_id=$1'))
      return {rows:rows.filter(r=>r.run_id===a[0]).sort((x,y)=>x.operation_key.localeCompare(y.operation_key))};
    writes.push(sql);
    if(sql.startsWith('INSERT INTO youtube_discovery_test_runs')){
      rs.push({id:a[0],owner:a[1],scope_sha256:a[2],cap_cents:a[3],reserved_cents:0,status:'running'});return {rowCount:1};}
    if(sql.includes('INSERT INTO youtube_bounded_test_admissions')){
      assert.ok(!rows.some(r=>r.run_id===a[0]&&r.operation_key===a[1]));
      rows.push({run_id:a[0],operation_key:a[1],profile_id:a[2],kind:a[4],input_sha256:a[3],
        reserved_cents:2,status:'admitted',receipt_sha256:null,http_status:null});return {rowCount:1};}
    if(sql.includes('SET reserved_cents=reserved_cents+2')){
      const r=rs.find(r=>r.id===a[0]);assert.ok(r.reserved_cents+2<=r.cap_cents);
      r.reserved_cents+=2;return {rowCount:1};}
    if(sql.includes("UPDATE youtube_bounded_test_admissions SET status='returned'")){
      const kind=sql.match(/AND kind='([^']+)'/)?.[1]??a[5];
      const r=rows.find(r=>r.run_id===a[0]&&r.operation_key===a[1]&&r.profile_id===a[2]&&
        r.input_sha256===a[3]&&r.kind===kind&&r.status==='admitted');
      if(!r)return {rowCount:0};Object.assign(r,{status:'returned',receipt_sha256:a[4],http_status:200});return {rowCount:1};}
    if(sql.startsWith('UPDATE youtube_discovery_test_runs SET status=$2')){
      rs.find(r=>r.id===a[0]).status=a[1];return {rowCount:1};}
    assert.fail('Unexpected SQL '+sql);
  }};
  return {c,pool:{connect:async()=>c},writes,state:()=>structuredClone({rs,rows})};
}
test('real gate keeps diagnostic model records separate from saved metadata and never registers ownership claims',async()=>{
  const schema=digest(await boundedComparisonSchema(modelCoordinator().c));
  const {plan,approval}=reviewedVerificationFixture(schema);
  const db=modelCoordinator(plan.sourceLedgerSnapshot),source=structuredClone(db.state());
  const gate=reviewedVerificationGate({pool:db.pool,plan,approval,owner:'synthetic',checkCatalog:async()=>{}});
  const group=plan.groups[0];await gate.start(group);
  for(const op of group.operations){
    await gate.admit(group,op);
    const raw=modelBytes();await gate.returned(group,op,syntheticReceipt(plan,approval,op,raw),raw);
  }
  await gate.finish(group,'completed');
  const after=db.state(),own=after.rs.find(r=>r.id===group.id);
  assert.equal(own.reserved_cents,28);assert.equal(own.status,'completed');
  assert.deepEqual(after.rows.filter(r=>r.kind==='metadata'),source.rows);
  assert.equal(after.rows.filter(r=>r.kind==='model'&&r.status==='returned').length,14);
  assert.ok(db.writes.every(q=>/^(INSERT INTO|UPDATE) youtube_(?:discovery_test_runs|bounded_test_admissions)/.test(q)));
  await assert.rejects(gate.start(group));
});
test('a prior model admission or a changed source transport blocks spending before registration',async()=>{
  const schema=digest(await boundedComparisonSchema(modelCoordinator().c));
  const {plan,approval}=reviewedVerificationFixture(schema);
  for(const changed of [false,true]){
    const initial=structuredClone(plan.sourceLedgerSnapshot);
    if(changed)initial.runs[0].cap_cents++;
    const db=modelCoordinator({...initial,priorProfile:changed?null:plan.operations[0].profileId});
    const gate=reviewedVerificationGate({pool:db.pool,plan,approval,owner:'synthetic',checkCatalog:async()=>{}});
    await assert.rejects(gate.start(plan.groups[0]));assert.equal(db.writes.length,0);
  }
});
