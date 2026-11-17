import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedVerificationFixture,syntheticReceipt} from './youtube-reviewed-verification-fixture.mjs';
import {reviewedVerificationResult} from './youtube-reviewed-verification.mjs';
import {CONTEXT_COMPARISON,contextComparisonOperation,contextComparisonPlan,approveContextComparison,
  contextComparisonResult,rejectContextReplay} from './youtube-context-comparison.mjs';
import {executeSavedModels} from './run-youtube-saved-model-checks.mjs';
const bytes=choice=>Buffer.from(JSON.stringify({model:'typesafe/jev-1.13-20260917',usage:{cost:.0001},
  answers:{combined_assessment:{type:'choice',choice}}}));
function fixture(){
  const {plan:baselinePlan,approval:baselineApproval}=reviewedVerificationFixture();
  const baselineRoot='generated-artifacts/'+baselinePlan.id,sourceFiles={...baselinePlan.sourceFiles};
  for(const [f,sha] of Object.entries(baselinePlan.runtimeFiles))sourceFiles[baselineRoot+'/'+f]=sha;
  const operations=[],baselineResponses=[],admissions=[];
  for(const old of baselinePlan.operations){
    const row=baselinePlan.inputs.find(r=>r.caseId===old.caseId),raw=bytes('identity_uncertain');
    const receipt=syntheticReceipt(baselinePlan,baselineApproval,old,raw);
    receipt.rawPath='receipts/'+digest(old.key)+'.raw';
    const result=reviewedVerificationResult(baselinePlan,old,receipt,raw);
    const a={run_id:baselinePlan.groups[0].id,operation_key:old.key,profile_id:old.profileId,
      kind:'model',input_sha256:old.inputSha256,reserved_cents:2,status:'returned',
      receipt_sha256:digest(receipt),http_status:200};
    admissions.push(a);baselineResponses.push({operationKey:old.key,receipt,rawBase64:raw.toString('base64')});
    const folder=baselineRoot+'/part-1/receipts/'+digest(old.key);
    sourceFiles[folder+'.json']=digest(Buffer.from(JSON.stringify(receipt)));sourceFiles[folder+'.raw']=digest(raw);
    operations.push(contextComparisonOperation(old,row,[],result,a));
  }
  const group=baselinePlan.groups[0];
  const plan=contextComparisonPlan({id:'youtube-context-comparison-synthetic',version:CONTEXT_COMPARISON,
    preparedAt:'2026-11-17T23:00:00Z',baselineRoot,baselinePlan,baselineApproval,baselineResponses,
    baselineLedgerSnapshot:{runs:[{id:group.id,status:'completed',
      scope_sha256:digest({group,approval:baselineApproval,runtimeFiles:baselinePlan.runtimeFiles}),
      cap_cents:28,reserved_cents:28}],admissions:admissions.sort((a,b)=>a.operation_key.localeCompare(b.operation_key))},
    videoPackets:[],operations,selections:baselinePlan.selections,sourceFiles,
    runtimeFiles:{'runtime/synthetic.mjs':'f'.repeat(64)},pricing:baselinePlan.pricing,
    coordinatorSchemaSha256:baselinePlan.coordinatorSchemaSha256,maximumSpendCents:28,
    maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))});
  const approval=approveContextComparison(plan,{planSha256:digest(plan),capCents:28,approvedAt:'2026-11-18T00:00:00Z'});
  return {plan,approval};
}
test('comparison permits only 14 changed, receipt-bound requests with fresh exact approval',()=>{
  const {plan,approval}=fixture();
  assert.deepEqual(approveContextComparison(plan,approval),approval);
  for(const edit of [p=>p.maximumSpendCents=26,p=>p.operations.pop(),
    p=>p.operations[0].request.body.state.userFeedback='rejected',
    p=>p.baselineResponses[0].rawBase64=Buffer.from('{}').toString('base64'),
    p=>p.baselineLedgerSnapshot.admissions[0].status='admitted',
    p=>p.baselineApproval.capCents=30]){
    const copy=structuredClone(plan);edit(copy);assert.throws(()=>contextComparisonPlan(copy));
  }
  assert.throws(()=>approveContextComparison(plan,{...approval,capCents:30}));
  assert.throws(()=>approveContextComparison(plan,{...approval,planSha256:'0'.repeat(64)}));
});
test('new answers bind to new evidence; raw disagreements and uncertainty stay separate from safety vetoes',()=>{
  const {plan}=fixture(),op=plan.operations.find(o=>o.profileId==='257398');
  for(const choice of ['artist_managed_supported','identity_uncertain','third_party_channel']){
    const raw=bytes(choice),receipt=syntheticReceipt(plan,{},op,raw);
    const r=contextComparisonResult(plan,op,receipt,raw);
    assert.equal(r.modelAnswer.requestSha256,op.inputSha256);
    assert.notEqual(r.modelAnswer.inputSha256,op.baselineResult.modelAnswer.inputSha256);
    assert.equal(r.feedbackComparison.agreesWithHistoricalFeedback,
      choice==='artist_managed_supported'?false:choice==='identity_uncertain'?null:true);
    assert.equal(r.ownershipAccepted,false);assert.equal(r.channelClaimWrites,0);
    if(choice==='artist_managed_supported')assert.equal(r.decision.status,'experimental_safety_hold');
    const bad={...receipt,inputSha256:op.baselineAdmission.input_sha256};
    assert.throws(()=>contextComparisonResult(plan,op,bad,raw));
  }
});
test('replay check accepts only the single returned baseline and blocks any other model admission',async()=>{
  const {plan}=fixture(),op=plan.operations[0];let other=[];
  const c={async query(sql){
    if(sql.includes('SELECT count(*)'))return {rows:[{n:0}]};
    return {rows:[op.baselineAdmission,...other]};
  }};
  await rejectContextReplay(c,[op]);
  other=[{...op.baselineAdmission,run_id:'another-comparison'}];
  await assert.rejects(rejectContextReplay(c,[op]));
  other=[{...op.baselineAdmission,status:'admitted'}];
  await assert.rejects(rejectContextReplay(c,[op]));
});
test('one-shot execution sends only changed approved requests and preserves no-retry behavior',async()=>{
  const {plan,approval}=fixture(),root=await fs.mkdtemp(os.tmpdir()+'/context-comparison-');
  let calls=0,admitted=0,returned=0;
  const gate={start:async()=>{},admit:async()=>{admitted++;},returned:async()=>{returned++;},finish:async()=>{}};
  const run=()=>executeSavedModels({root,plan,approval,gate,credential:'synthetic',
    assertFrozen:async()=>{},checkPrice:async()=>{},validateApproval:approveContextComparison,
    parseResult:contextComparisonResult,fetchImpl:async(url,options)=>{
      assert.equal(admitted,calls+1);assert.equal(options.method,'POST');
      assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
      assert.deepEqual(JSON.parse(options.body),plan.operations[calls].request.body);
      calls++;return new Response(bytes('identity_uncertain'),{status:200});
    }});
  try{
    const summary=await run();assert.equal(calls,14);assert.equal(returned,14);
    assert.equal(summary.modelReservedCents,28);assert.equal(summary.catalogWrites,0);
    await assert.rejects(run());assert.equal(calls,14);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
