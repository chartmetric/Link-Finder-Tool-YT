import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './youtube-video-discovery-offline.mjs';
import {projectServerError,errorPaidPrefix,serverErrorReceipt} from './youtube-channel-error-continuation.mjs';
import {acknowledgeServerError} from './run-youtube-channel-error-continuation.mjs';
function fixture(){
  const ops=[0,1,2].map(i=>({key:'op-'+i,profileId:String(i+1),cmArtist:String(i+11),
    allocationChannelKey:'channel-'+i,inputSha256:digest('input'+i),
    targetUrl:'https://www.youtube.com/@artist'+i,request:{url:'https://provider.invalid/'+i}}));
  const group={id:'source-1',groupIndex:0,operations:ops,maximumSpendCents:6,runtimeFiles:{'runtime/test.mjs':digest('runtime')}},
    approval={id:group.id,approvedAt:'2026-11-16T00:00:00Z'};
  const raw=Buffer.from(JSON.stringify({message:'Internal Server Error'})),op=ops[1];
  const receipt={runId:group.id,planSha256:digest(group),approvalSha256:digest(approval),operationKey:op.key,
    profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,
    inputSha256:op.inputSha256,status:500,rawPath:'receipts/'+digest(op.key)+'.raw',
    request:op.request,rawBodySha256:digest(raw)};
  const snapshot={runs:[{id:group.id,owner:'original-owner',status:'stopped',plan_sha256:digest(group),
    approval_sha256:digest(approval),execution_sha256:digest(group.runtimeFiles),cap_cents:6,reserved_cents:4}],
    admissions:ops.slice(0,2).map((o,i)=>({run_id:group.id,operation_key:o.key,profile_id:o.profileId,
      cm_artist:o.cmArtist,channel_id:o.allocationChannelKey,kind:'metadata',input_sha256:o.inputSha256,
      reserved_cents:2,status:i?'admitted':'returned',http_status:i?null:200,
      receipt_sha256:i?null:digest('receipt0'),raw_sha256:i?null:digest('raw0')}))};
  const recovery={snapshot:structuredClone(snapshot),runId:group.id,operationKey:op.key,
    receiptSha256:digest(receipt),receiptFileSha256:digest(JSON.stringify(receipt)),rawSha256:digest(raw),
    httpStatus:500,reservedCents:2,ownershipAccepted:false,importEligible:false,noRetry:true};
  return {group,approval,snapshot,recovery,raw,receipt};
}
test('saved server error is an incomplete paid attempt, never a successful capture or confirmed absence',()=>{
  const f=fixture(),before=structuredClone(f.snapshot);
  const disposition=serverErrorReceipt(f.receipt,f.raw,f.group,f.approval,f.group.operations[1]);
  assert.equal(disposition.incompleteEvidence,true);assert.equal(disposition.providerReportedCredits,null);
  assert.equal(disposition.noRetry,true);assert.equal(disposition.conservativeReservationCents,2);
  const projected=projectServerError(f.snapshot,f.recovery);
  assert.deepEqual(f.snapshot,before);assert.deepEqual(projected.runs,before.runs);
  assert.equal(projected.admissions[1].http_status,500);
  assert.deepEqual(errorPaidPrefix([f.group],[f.approval],projected,[],f.recovery),{paid:2,settled:2,failed:1});
});
test('receipt request, bytes and approval must match, and authentication or funding failures cannot be skipped',()=>{
  const f=fixture();
  for(const change of [
    r=>r.status=200,r=>r.approvalSha256=digest('different'),r=>r.inputSha256=digest('changed'),
    r=>r.request={url:'https://different.invalid'},r=>r.rawBodySha256=digest('wrong')]){
    const r=structuredClone(f.receipt);change(r);
    assert.throws(()=>serverErrorReceipt(r,f.raw,f.group,f.approval,f.group.operations[1]));
  }
  for(const message of ['Unauthorized: invalid api key','insufficient credits']){
    const raw=Buffer.from(JSON.stringify({message})),r={...f.receipt,rawBodySha256:digest(raw)};
    assert.throws(()=>serverErrorReceipt(r,raw,f.group,f.approval,f.group.operations[1]));
  }
});
test('uncertain receipts, wrong identities, changed budget and paid operations after the failure block continuation',()=>{
  const f=fixture();
  for(const mutate of [
    s=>s.admissions[0].http_status=500,s=>s.admissions[0].profile_id='999',
    s=>s.runs[0].reserved_cents=2,s=>s.runs[0].status='running',
    s=>s.admissions[1].raw_sha256=digest('changed'),s=>s.admissions[0].operation_key='op-2']){
    const s=projectServerError(f.snapshot,f.recovery);mutate(s);
    assert.throws(()=>errorPaidPrefix([f.group],[f.approval],s,[],f.recovery));
  }
  const changed=structuredClone(f.snapshot);changed.runs[0].owner='different';
  assert.throws(()=>projectServerError(changed,f.recovery));
});
test('acknowledgment records HTTP 500 only, preserves its reservation and stopped owner, and sends no request',async t=>{
  const f=fixture(),root=await fs.mkdtemp('generated-artifacts/channel-error-test-');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const plan={groups:[],recovery:f.recovery},events=[];
  const c={release(){},async query(sql,args=[]){
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)){events.push(sql);return {rows:[]};}
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.includes('count(*)::int n'))return {rows:[{n:0}]};
    if(sql.includes('FROM youtube_video_identity_runs WHERE id=ANY'))return {rows:[]};
    if(sql.includes('FROM youtube_video_identity_admissions')&&sql.includes('ORDER BY'))return {rows:[]};
    if(sql.startsWith('UPDATE youtube_video_identity_admissions')){
      assert.match(sql,/http_status=500/);assert.ok(!sql.includes('reserved_cents='));
      await fs.access(root+'/error-acknowledgment.json');
      assert.deepEqual(args,[f.recovery.runId,f.recovery.operationKey,f.recovery.receiptSha256,f.recovery.rawSha256]);
      events.push('received_failed_transport_only');return {rowCount:1};
    }
    throw Error('Unexpected SQL: '+sql);
  }};
  await acknowledgeServerError({pool:{connect:async()=>c},plan,root,assertFrozen:async()=>{},
    checkHistory:async()=>{},checkReceipts:async()=>({status:500,noRetry:true})});
  assert.deepEqual(events,['BEGIN','received_failed_transport_only','COMMIT']);
  assert.equal(f.snapshot.runs[0].reserved_cents,4);assert.equal(f.snapshot.runs[0].status,'stopped');
});
