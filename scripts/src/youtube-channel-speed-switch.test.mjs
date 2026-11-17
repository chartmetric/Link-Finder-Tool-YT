import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {exactSettledPrefix,assertPreparationRetained} from './youtube-channel-speed-switch.mjs';
import fs from 'node:fs/promises';
import {switchAtBoundary} from './run-youtube-channel-speed-switch.mjs';
function fixture(){
  const operations=Array.from({length:4},(_,i)=>({key:'op-'+i,profileId:String(i+1),cmArtist:String(i+11),
    allocationChannelKey:'channel-'+i,inputSha256:digest('request'+i)}));
  const group={id:'source-part-1',groupIndex:0,operations,maximumSpendCents:8,
    runtimeFiles:{'runtime/worker.mjs':digest('worker')}},approval={scope:'exact-requests'};
  const snapshot={runs:[{id:group.id,owner:'original-owner',status:'stopped',plan_sha256:digest(group),
    approval_sha256:digest(approval),execution_sha256:digest(group.runtimeFiles),cap_cents:8,reserved_cents:4}],
    admissions:operations.slice(0,2).map(o=>({run_id:group.id,operation_key:o.key,profile_id:o.profileId,
      cm_artist:o.cmArtist,channel_id:o.allocationChannelKey,kind:'metadata',input_sha256:o.inputSha256,
      reserved_cents:2,status:'returned',http_status:200,receipt_sha256:digest('receipt'+o.key),raw_sha256:digest('raw'+o.key)}))};
  return {group,approval,snapshot,holds:[]};
}
test('switch subtracts only exact settled requests, preserving paid reservations',()=>{
  const f=fixture();
  assert.deepEqual(exactSettledPrefix([f.group],[f.approval],f.snapshot,f.holds),
    {settled:2,paid:2,unspentHolds:0});
  assert.equal(f.snapshot.runs[0].status,'stopped');
});
test('an unspent held conflict is excluded from the suffix but does not count as a paid check',()=>{
  const f=fixture();
  const removed=f.snapshot.admissions.shift();f.snapshot.runs[0].reserved_cents=2;
  f.holds=[{runId:f.group.id,operationKey:removed.operation_key,paid:false,
    ownershipAccepted:false,importEligible:false,conflicts:[{profileId:'other'}]}];
  assert.deepEqual(exactSettledPrefix([f.group],[f.approval],f.snapshot,f.holds),
    {settled:2,paid:1,unspentHolds:1});
});
test('the switch cannot lose or alter any paid request already observed during preparation',()=>{
  const f=fixture(),plan={preparationSnapshot:structuredClone(f.snapshot),preparationHolds:[],
    minimumSettled:2,minimumPaid:2};
  assert.doesNotThrow(()=>assertPreparationRetained(plan,f.snapshot,[],{settled:2,paid:2}));
  for(const change of [
    s=>s.admissions.pop(),s=>s.admissions[0].receipt_sha256=digest('different'),
    s=>s.runs[0].owner='different',s=>s.runs[0].reserved_cents=2]){
    const snapshot=structuredClone(f.snapshot);change(snapshot);
    assert.throws(()=>assertPreparationRetained(plan,snapshot,[],{settled:2,paid:2}));
  }
  assert.throws(()=>assertPreparationRetained(plan,f.snapshot,[],{settled:1,paid:1}));
});
test('in-flight calls, missing prefix, different requests and mismatched caps block switching',()=>{
  for(const change of [
    f=>f.snapshot.admissions[0].status='admitted',f=>f.snapshot.admissions[0].raw_sha256=null,
    f=>f.snapshot.admissions[0].operation_key='op-3',f=>f.snapshot.admissions[0].profile_id='other',
    f=>f.snapshot.runs[0].status='running',f=>f.snapshot.runs[0].reserved_cents=2,
    f=>f.snapshot.runs[0].cap_cents=10,f=>f.snapshot.admissions.push(f.snapshot.admissions[0]),
    f=>f.snapshot.runs[0].status='completed',
  ]){
    const f=fixture();change(f);
    assert.throws(()=>exactSettledPrefix([f.group],[f.approval],f.snapshot,f.holds));
  }
});
test('held markers cannot accept ownership, invent completed operations, or conceal charges',()=>{
  for(const change of [
    f=>f.holds[0].importEligible=true,f=>f.holds[0].ownershipAccepted=true,
    f=>f.holds[0].paid=false,f=>f.holds[0].operationKey='unknown',
    f=>f.holds[0].conflicts=[],f=>f.holds.push(f.holds[0]),
  ]){
    const f=fixture();
    f.holds=[{runId:f.group.id,operationKey:'op-0',paid:true,
      ownershipAccepted:false,importEligible:false,conflicts:[{profileId:'other'}]}];
    change(f);assert.throws(()=>exactSettledPrefix([f.group],[f.approval],f.snapshot,f.holds));
  }
});
async function handoverFixture(t,inFlight=false){
  const f=fixture(),root=await fs.mkdtemp('generated-artifacts/channel-speed-test-');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sourceRoot=root+'/source',sourceId=sourceRoot.replace('generated-artifacts/','');
  f.group.id=sourceId+'-part-1';
  const run=f.snapshot.runs[0];run.id=f.group.id;run.status='running';run.plan_sha256=digest(f.group);
  for(const row of f.snapshot.admissions)row.run_id=f.group.id;
  if(inFlight)f.snapshot.admissions[1].status='admitted';
  await fs.mkdir(sourceRoot+'/part-1',{recursive:true});
  await fs.writeFile(sourceRoot+'/part-1/plan.json',JSON.stringify(f.group));
  await fs.writeFile(sourceRoot+'/part-1/approval.json',JSON.stringify(f.approval));
  await fs.mkdir(sourceRoot+'/part-1/receipts');
  for(const row of f.snapshot.admissions){
    const name=sourceRoot+'/part-1/receipts/'+digest(row.operation_key);
    await fs.writeFile(name+'.json','{}');await fs.writeFile(name+'.raw','{}');
  }
  const plan={id:'replacement',maximumPotentialCalls:4,sourcePlan:{id:sourceId,groups:[f.group],
    predecessor:{sourcePlan:{sourcePlan:{id:'zero-original'}}}}};
  const events=[];
  const c={release(){},async query(sql,args=[]){
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)){events.push(sql);return {rows:[]};}
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.includes('count(*)::int n'))return {rows:[{n:0}]};
    if(sql.includes('FROM youtube_video_identity_runs WHERE id=ANY'))
      return {rows:args[0].includes(f.group.id)?structuredClone(f.snapshot.runs):[]};
    if(sql.includes('FROM youtube_video_identity_admissions'))
      return {rows:args[0].includes(f.group.id)?structuredClone(f.snapshot.admissions):[]};
    if(sql.startsWith('UPDATE youtube_video_identity_runs')){
      assert.equal(args[1],run.owner);assert.equal(run.status,'running');
      await fs.access(root+'/cutover.json');events.push('fenced_after_saved_cutover');
      run.status='stopped';return {rowCount:1};
    }
    throw Error('Unexpected SQL: '+sql);
  }};
  return {...f,root,plan,events,pool:{connect:async()=>c},assertFrozen:async()=>{},
    checkHistory:async()=>{},verifyReceipts:async()=>{},
    deriveSuffix:(_p,s,holds)=>{
      const counted=exactSettledPrefix([f.group],[f.approval],s,holds);
      return {priorReservedCents:258+counted.paid*2,remaining:4-counted.settled,maximumRemainingCents:(4-counted.settled)*2};
    }};
}
test('safe switch saves the accounted boundary before fencing the old owner and sends no requests',async t=>{
  const f=await handoverFixture(t);
  const cutover=await switchAtBoundary(f);
  assert.equal(cutover.remaining,2);assert.equal(cutover.noPaidReplays,true);
  assert.equal(f.snapshot.runs[0].status,'stopped');
  assert.deepEqual(f.events,['BEGIN','fenced_after_saved_cutover','COMMIT']);
});
test('an in-flight request blocks switching without fencing the worker or replaying the call',async t=>{
  const f=await handoverFixture(t,true);
  await assert.rejects(()=>switchAtBoundary({...f,waitMs:0,delay:async()=>{}}),/Unacknowledged/);
  assert.equal(f.snapshot.runs[0].status,'running');
  assert.deepEqual(f.events,['BEGIN','ROLLBACK']);
  await assert.rejects(()=>fs.access(f.root+'/cutover.json'),{code:'ENOENT'});
});
test('a gap before the next source group starts is not mistaken for a fenced worker',async t=>{
  const f=await handoverFixture(t);
  f.snapshot.runs=[];f.snapshot.admissions=[];
  await assert.rejects(()=>switchAtBoundary({...f,waitMs:0,delay:async()=>{}}),/Unacknowledged/);
  assert.deepEqual(f.events,['BEGIN','ROLLBACK']);
  await assert.rejects(()=>fs.access(f.root+'/cutover.json'),{code:'ENOENT'});
});
