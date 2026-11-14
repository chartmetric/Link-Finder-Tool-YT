import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mixedCapturePlan,approveMixedCaptures,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {prepareDirectRecoveryContract} from './youtube-direct-capture-recovery-plan.mjs';
import {accountSavedDirectReceipt,directRecoveryApproval} from './run-youtube-direct-receipt-recovery.mjs';
const at='2026-11-14T01:40:00Z',channel=n=>'UC'+String(n).padStart(22,'a');
const url=n=>'https://www.youtube.com/channel/'+channel(n);
function fixture(){
  const artists=[1,2,3].map(n=>({profileId:String(n),cmArtist:String(n+100),name:'Artist '+n,tier:2,
    catalogProfile:{profile_id:String(n),cm_artist:String(n+100)}}));
  const plan=mixedCapturePlan({version:DIRECT_CAPTURE_POLICY,id:'youtube-mixed-captures-recovery-synthetic',
    preparedAt:at,artists,directLeads:artists.map(a=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
      candidates:[{url:url(a.profileId),title:a.name}]})),uploaderResults:[],sourceUploaderIds:[],
    cohortClaims:[],sourceSearchId:'youtube-test-synthetic-source',
    sourceFiles:{'generated-artifacts/source/plan.json':digest('source')},
    runtimeFiles:{'runtime/run.mjs':digest('runtime')}});
  const childApproval=approveMixedCaptures(plan,{planSha256:digest(plan),capCents:6,approvedAt:at});
  const bundle=channelCheckBundle({id:'youtube-batch-channel-checks-recovery-synthetic',preparedAt:at,
    sourceBundleId:'youtube-batch-100-synthetic',sourceBundleSha256:digest('search'),
    children:[{id:plan.id,plan}],runtimeFiles:{'runtime/run.mjs':digest('bundle')}});
  const approval=approveChannelCheckBundle(bundle,{planSha256:digest(bundle),capCents:6,approvedAt:at});
  const savedResponses=plan.operations.slice(0,2).map((op,i)=>{
    const raw=Buffer.from(JSON.stringify({success:true,credits_charged:1,channelId:op.expectedChannelId,
      channel:op.targetUrl,name:'Artist '+(i+1),description:'Musician'}));
    return {runId:plan.id,rawBodyBase64:raw.toString('base64'),receipt:{runId:plan.id,
      planSha256:digest(plan),approvalSha256:digest(childApproval),operationKey:op.key,
      profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,
      inputSha256:op.inputSha256,request:op.request,capturedAt:at,status:200,
      rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)}};
  });
  const admissions=plan.operations.slice(0,2).map((op,i)=>({run_id:plan.id,operation_key:op.key,
    profile_id:op.profileId,cm_artist:op.cmArtist,channel_id:op.allocationChannelKey,kind:'metadata',
    input_sha256:op.inputSha256,reserved_cents:2,status:i?'admitted':'returned',
    receipt_sha256:i?null:digest(savedResponses[i].receipt),
    raw_sha256:i?null:savedResponses[i].receipt.rawBodySha256,http_status:i?null:200}));
  return {bundle,approval,children:[{plan,approval:childApproval}],admissions,savedResponses,
    runs:[{id:plan.id,owner:'original-owner',status:'stopped',plan_sha256:digest(plan),
      approval_sha256:digest(childApproval),execution_sha256:digest(plan.runtimeFiles),cap_cents:6,reserved_cents:4}],
    catalogClaims:[{profile_id:'999',cm_artist:'1999',account_url:url(2)}],
    sourceFiles:{'generated-artifacts/source/plan.json':digest('source')}};
}
test('preparation preserves paid prefix, holds conflict and proposes only exact untouched requests',()=>{
  const f=fixture(),before=structuredClone(f),p=prepareDirectRecoveryContract(f);
  assert.deepEqual(f,before);assert.equal(p.executable,false);assert.equal(p.explicitApproval,false);
  assert.equal(p.accounting.previousAcknowledged,1);assert.equal(p.accounting.savedHeld,1);
  assert.equal(p.accounting.priorReservedCents,4);assert.equal(p.accounting.combinedMaximumCents,6);
  assert.deepEqual(p.continuation.pending.map(x=>x.operation),f.children[0].plan.operations.slice(2));
  assert.equal(p.continuation.maximumAdditionalCents,2);
  assert.equal(p.recovery.createOwnershipClaims,false);assert.equal(p.recovery.keepSourceRunStopped,true);
  assert.equal(p.recovery.heldResponse.importEligible,false);
  assert.equal(p.paidCallsDuringPreparation,0);assert.equal(p.coordinatorWritesDuringPreparation,0);
});
test('changed scope, owner proof, receipts, raw bytes and reservations cannot be silently recovered',()=>{
  for(const mutate of [
    f=>f.approval.capCents++,
    f=>f.runs[0].owner='',
    f=>f.runs[0].execution_sha256=digest('changed'),
    f=>f.runs[0].reserved_cents=2,
    f=>f.admissions[0].input_sha256=digest('different'),
    f=>f.admissions[0].receipt_sha256=digest('different'),
    f=>f.savedResponses[1].receipt.approvalSha256=digest('different'),
    f=>f.savedResponses[1].receipt.request={url:'https://example.com'},
    f=>f.savedResponses[1].rawBodyBase64=Buffer.from('{}').toString('base64'),
    f=>f.catalogClaims=[],
    f=>f.admissions.push({...f.admissions[1]}),
    f=>f.runs[0].status='running',
    f=>f.admissions.reverse().forEach((a,i)=>a.operation_key=f.children[0].plan.operations[i+1].key),
  ]){
    const f=fixture();mutate(f);assert.throws(()=>prepareDirectRecoveryContract(f));
  }
});
test('a saved unknown-price response remains blocked rather than retried or acknowledged',()=>{
  const f=fixture(),s=f.savedResponses[1],body=JSON.parse(Buffer.from(s.rawBodyBase64,'base64'));
  body.credits_charged=2;const raw=Buffer.from(JSON.stringify(body));
  s.rawBodyBase64=raw.toString('base64');s.receipt.rawBodySha256=digest(raw);
  assert.throws(()=>prepareDirectRecoveryContract(f));
});
function executionFixture(){
  const evidence=fixture(),contract=prepareDirectRecoveryContract(evidence);
  const plan={version:'exact-saved-direct-channel-receipt-recovery-v1',id:'youtube-direct-receipt-recovery-synthetic',
    preparedAt:at,maximumAdditionalCents:0,providerRequests:0,createOwnershipClaims:false,catalogWrites:0,
    evidenceSha256:digest(evidence),contractSha256:digest(contract)};
  const approval=directRecoveryApproval(plan,{planSha256:digest(plan),capCents:0,approvedAt:at});
  const state=structuredClone({runs:evidence.runs,admissions:evidence.admissions});let updates=0,rollbacks=0;
  const client={release(){},query:async(sql,args)=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rows:[]};
    if(sql==='ROLLBACK'){rollbacks++;return {rows:[]};}
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.includes('count(*)::int n'))return {rows:[{n:0}]};
    if(sql.startsWith('SELECT * FROM youtube_video_identity_runs'))return {rows:state.runs};
    if(sql.startsWith('SELECT * FROM youtube_video_identity_admissions'))return {rows:state.admissions};
    if(sql.startsWith('SELECT run_id,operation_key'))return {rows:state.admissions.filter(a=>a.status==='admitted')
      .map(a=>({run_id:a.run_id,operation_key:a.operation_key}))};
    if(sql.startsWith('UPDATE youtube_video_identity_admissions SET status=')){
      assert.equal(args[0],state.runs[0].id);
      const row=state.admissions.find(a=>a.operation_key===args[1]);
      assert.equal(row.status,'admitted');Object.assign(row,{status:'returned',receipt_sha256:args[2],raw_sha256:args[3],http_status:200});
      updates++;return {rowCount:1};
    }
    throw new Error('Unexpected SQL (no other writes permitted): '+sql);
  }};
  return {evidence,contract,plan,approval,pool:{connect:async()=>client},state,
    counts:()=>({updates,rollbacks})};
}
test('separately approved recovery accounts once, remains held and is idempotent without dispatch',async()=>{
  const f=executionFixture(),reserved=f.state.runs[0].reserved_cents;
  const first=await accountSavedDirectReceipt(f),second=await accountSavedDirectReceipt(f);
  assert.deepEqual(second,first);assert.equal(f.counts().updates,1);
  assert.equal(f.state.runs[0].status,'stopped');assert.equal(f.state.runs[0].reserved_cents,reserved);
  assert.equal(first.providerRequests,0);assert.equal(first.createdOwnershipClaims,0);
  assert.equal(first.importEligible,false);assert.equal(first.ownershipAccepted,false);
});
test('recovery fails closed if live owner, ledger or approval differs',async()=>{
  for(const change of [
    f=>f.state.runs[0].owner='new-owner',
    f=>f.state.runs[0].reserved_cents++,
    f=>f.state.admissions[0].raw_sha256=digest('changed'),
    f=>f.state.admissions.push({...f.state.admissions[0],operation_key:'extra'}),
    f=>f.approval.planSha256=digest('wrong-approval'),
  ]){
    const f=executionFixture();change(f);await assert.rejects(()=>accountSavedDirectReceipt(f));
    assert.equal(f.counts().updates,0);
  }
});
