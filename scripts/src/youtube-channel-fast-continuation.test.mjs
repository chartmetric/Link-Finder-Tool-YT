import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {accountedChannelPlan,approveAccountedChannels} from './youtube-accounted-channel-plan.mjs';
import {accountedChannelGroups,approveAccountedGroups,groupApproval} from './youtube-accounted-channel-groups.mjs';
import {fastChannelPlan,approveFastChannels,channelSuffix,recoveredChannelSnapshot} from './youtube-channel-fast-continuation.mjs';
import {handoverChannels} from './youtube-channel-fast-live.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {targetedCatalogCheck} from './youtube-targeted-catalog-check.mjs';
function fixture(sourceId='youtube-accounted-channel-groups-synthetic'){
  const records=Array.from({length:500},(_,i)=>{
    const artist={name:'Artist '+i,profileId:String(i+1),cmArtist:String(i+1001),
      catalogProfile:{profile_id:String(i+1),cm_artist:String(i+1001)}};
    return {sourceRunId:'youtube-test-synthetic-source',sourceReceipt:'generated-artifacts/test/receipt-'+i+'.json',
      receiptSha256:digest('receipt'+i),record:{artist,tier:2,ownershipAccepted:false,
        candidates:i<47?[{title:artist.name,url:'https://www.youtube.com/channel/UC'+String(i).padStart(22,'a')}]:[],
        videoPlan:{resolutionQueue:[]}}};
  });
  const sourceFiles={'generated-artifacts/test/source.json':digest('source')},runtimeFiles={'runtime/run.mjs':digest('runtime')};
  const flat=accountedChannelPlan({id:'youtube-accounted-channel-checks-synthetic',preparedAt:'2026-11-16T21:00:00Z',
    sourceRoot:'generated-artifacts/youtube-accounted-channel-checks-synthetic',records,claims:[],
    currentRows:records.map(r=>({profile_id:r.record.artist.profileId,cm_artist:r.record.artist.cmArtist,
      artist:r.record.artist.name,tier:2,snapshot_at:'2026-11-16 00:00:00'})),sourceFiles,runtimeFiles});
  const flatApproval=approveAccountedChannels(flat,{planSha256:digest(flat),capCents:94,approvedAt:'2026-11-16T21:01:00Z'});
  const sourcePlan=accountedChannelGroups({id:sourceId,preparedAt:'2026-11-16T22:00:00Z',
    sourcePlan:flat,sourceApproval:flatApproval,previousAttempt:{runs:[],admissions:[{n:0,reserved_cents:0}]},
    sourceFiles,runtimeFiles});
  const sourceApproval=approveAccountedGroups(sourcePlan,{planSha256:digest(sourcePlan),capCents:94,approvedAt:'2026-11-16T22:01:00Z'});
  return fastChannelPlan({id:'youtube-channel-fast-continuation-synthetic',preparedAt:'2026-11-16T23:00:00Z',
    sourcePlan,sourceApproval,sourceFiles,runtimeFiles});
}
function snapshot(plan,paid=3,status='stopped'){
  const group=plan.sourcePlan.groups[0];
  return {runs:[{id:group.id,owner:'original-owner',status,plan_sha256:digest(group),
    approval_sha256:digest(groupApproval(plan.sourcePlan,plan.sourceApproval,group)),
    execution_sha256:digest(group.runtimeFiles),cap_cents:40,reserved_cents:paid*2}],
  admissions:group.operations.slice(0,paid).map(op=>({run_id:group.id,operation_key:op.key,
    profile_id:op.profileId,cm_artist:op.cmArtist,channel_id:op.allocationChannelKey,kind:'metadata',
    input_sha256:op.inputSha256,reserved_cents:2,status:'returned',http_status:200,
    receipt_sha256:digest('receipt'),raw_sha256:digest('raw')}))};
}
test('continuation subtracts only a fully acknowledged exact prefix and preserves the combined cap',()=>{
  const p=fixture(),s=snapshot(p),suffix=channelSuffix(p,s);
  assert.equal(suffix.paidCount,3);assert.equal(suffix.pendingCount,44);
  assert.equal(suffix.priorReservedCents+suffix.maximumRemainingCents,94);
  assert.deepEqual(suffix.groups.map(g=>g.maximumCalls),[20,20,4]);
  assert.deepEqual(suffix.groups.flatMap(g=>g.operations),p.sourcePlan.groups.flatMap(g=>g.operations).slice(3));
  assert.ok(suffix.groups.every(g=>g.maximumSpendCents<=40&&!g.executionEnabled));
});
test('uncertain receipts, missing prefix, changed identity and inflated budget block the faster path',()=>{
  const p=fixture();
  for(const mutate of [
    s=>{s.admissions[0].status='admitted';},
    s=>{s.admissions[0].profile_id='99999';},
    s=>{s.admissions[0].operation_key='unknown';},
    s=>{s.runs[0].reserved_cents=0;},
    s=>{s.runs[0].status='running';},
    s=>{s.admissions[0].receipt_sha256=null;},
  ]){const s=snapshot(p);mutate(s);assert.throws(()=>channelSuffix(p,s));}
  const a=approveFastChannels(p,{planSha256:digest(p),combinedCapCents:94,approvedAt:'2026-11-16T23:01:00Z'});
  assert.equal(a.noAdditionalBudget,true);
  assert.throws(()=>approveFastChannels(p,{...a,combinedCapCents:96}));
  assert.throws(()=>approveFastChannels(p,p.sourceApproval),'Old worker approval does not authorize the faster worker');
});
test('cached file checks still detect same-size edits with restored mtime and reject symlinks',async()=>{
  const root=await fs.mkdtemp('generated-artifacts/youtube-fast-cache-test-');
  try{
    const file=root+'/evidence.json';await fs.writeFile(file,'first');
    const old=await fs.stat(file);let reads=0;
    const verify=frozenFileVerifier({[file]:digest('first')},{readFile:async f=>{reads++;return fs.readFile(f);}});
    assert.equal((await verify()).contentReads,1);assert.equal((await verify()).contentReads,0);
    assert.equal(reads,1);
    await fs.writeFile(file,'other');await fs.utimes(file,old.atime,old.mtime);
    await assert.rejects(verify,/Frozen contents changed/);
    await fs.unlink(file);await fs.writeFile(root+'/real.json','first');await fs.symlink('real.json',file);
    await assert.rejects(verify,/Nonregular frozen file/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('per-target catalog checking retains identity and alias checks without rechecking unrelated artists',async()=>{
  const group=fixture().sourcePlan.groups[0],queries=[];
  const target=group.selections[0];
  const check=targetedCatalogCheck(group,{now:()=>Date.parse('2026-11-16T23:00:00Z'),query:async sql=>{
    queries.push(sql);
    if(queries.length===1)return [{profile_id:target.profileId,cm_artist:target.cmArtist,
      artist:target.artist,tier:target.tier,snapshot_at:'2026-11-16 00:00:00'}];
    assert.match(sql,/FROM new_vertical\.account FINAL/);return [];
  }});
  await check([{alias:target.url,channelId:target.channelId,profileId:target.profileId,cmArtist:target.cmArtist}]);
  assert.match(queries[0],new RegExp('p.id IN \\('+target.profileId+'\\)'));
  assert.equal(queries.length,2);
  await assert.rejects(()=>check([{alias:target.url,profileId:'999999',cmArtist:'99999'}]),/different artist/);
});
test('handover waits rather than stopping an in-flight paid request',async()=>{
  const p=fixture(),s=snapshot(p,1,'running');s.admissions[0].status='admitted';
  const updates=[];
  const c={query:async(sql)=>{
    if(/SELECT status FROM youtube_link_campaigns/.test(sql))return {rows:[{status:'stopped'}]};
    if(/SELECT id,owner,status/.test(sql))return {rows:s.runs};
    if(/SELECT run_id,operation_key/.test(sql))return {rows:s.admissions};
    if(/count\(\*\)/.test(sql))return {rows:[{n:0}]};
    if(/UPDATE/.test(sql))updates.push(sql);
    return {rows:[]};
  },release(){}};
  await assert.rejects(()=>handoverChannels({pool:{connect:async()=>c},plan:p,
    root:'generated-artifacts/not-created',assertFrozen:async()=>{},waitMs:0}),/No safe handover boundary/);
  assert.equal(updates.length,0);
});
test('zero-inflight handover saves the exact cutover then owner-fences the old worker',async()=>{
  const p=fixture(),s=snapshot(p,0,'running'),root=await fs.mkdtemp('generated-artifacts/youtube-fast-handover-test-');
  const calls=[];
  const c={query:async(sql,values)=>{
    calls.push(sql);
    if(/SELECT status FROM youtube_link_campaigns/.test(sql))return {rows:[{status:'stopped'}]};
    if(/SELECT id,owner,status/.test(sql))return {rows:structuredClone(s.runs)};
    if(/SELECT run_id,operation_key/.test(sql))return {rows:[]};
    if(/count\(\*\)/.test(sql))return {rows:[{n:0}]};
    if(/UPDATE/.test(sql)){
      assert.deepEqual(values,[s.runs[0].id,'original-owner']);
      const saved=JSON.parse(await fs.readFile(root+'/cutover.json'));
      assert.equal(saved.snapshot.runs[0].status,'stopped');return {rowCount:1};
    }return {rows:[]};
  },release(){}};
  try{
    const cut=await handoverChannels({pool:{connect:async()=>c},plan:p,root,assertFrozen:async()=>{}});
    assert.equal(cut.paidCount,0);assert.equal(cut.pendingCount,47);
    assert.ok(cut.noRequestsInFlight);assert.match(calls.find(s=>/^UPDATE/.test(s)),/owner=\$2/);
    assert.equal(calls.at(-1),'COMMIT');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('explicit saved-receipt recovery acknowledges transport only and never accepts the conflicted artist',async()=>{
  const sourceId='youtube-accounted-channel-groups-recovery-test-'+randomUUID().replaceAll('-','').slice(0,12);
  const sourceRoot='generated-artifacts/'+sourceId,root=await fs.mkdtemp('generated-artifacts/youtube-fast-recovery-test-');
  await fs.mkdir(sourceRoot);
  try{
    const p=fixture(sourceId),s=snapshot(p,1,'stopped'),row=s.admissions[0],group=p.sourcePlan.groups[0],op=group.operations[0];
    Object.assign(row,{status:'admitted',receipt_sha256:null,raw_sha256:null,http_status:null});
    await fs.mkdir(sourceRoot+'/part-1');await fs.mkdir(sourceRoot+'/part-1/receipts');
    const raw=Buffer.from(JSON.stringify({success:true,credits_charged:1,channelId:op.expectedChannelId,name:'Artist 0'}));
    const receipt={runId:group.id,planSha256:digest(group),approvalSha256:s.runs[0].approval_sha256,
      operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,
      inputSha256:op.inputSha256,status:200,rawPath:'receipts/'+digest(op.key)+'.raw',
      rawBodySha256:digest(raw),request:op.request};
    const receiptPath=sourceRoot+'/part-1/receipts/'+digest(op.key)+'.json',
      rawPath=sourceRoot+'/part-1/'+receipt.rawPath,receiptBytes=Buffer.from(JSON.stringify(receipt));
    await fs.writeFile(receiptPath,receiptBytes);await fs.writeFile(rawPath,raw);
    const recovery={version:'exact-held-channel-receipt-only-v1',runId:group.id,operationKey:op.key,snapshot:s,
      receiptPath,rawPath,receiptSha256:digest(receipt),rawSha256:digest(raw),
      receiptFileSha256:digest(receiptBytes),rawFileSha256:digest(raw),
      catalogConflictHeld:true,ownershipAccepted:false,importEligible:false,providerRequests:0};
    const plan=fastChannelPlan({...p,savedResponseRecovery:recovery,sourceFiles:{...p.sourceFiles,
      [receiptPath]:digest(receiptBytes),[rawPath]:digest(raw)}});
    const projected=recoveredChannelSnapshot(plan,s);
    assert.equal(projected.admissions[0].status,'returned');assert.equal(s.admissions[0].status,'admitted');
    assert.equal(channelSuffix(plan,projected).pendingCount,46);
    const changed=structuredClone(s);changed.runs[0].owner='other-owner';
    assert.throws(()=>recoveredChannelSnapshot(plan,changed),/ledger changed/);
    const statements=[];
    const c={query:async(sql,args)=>{
      statements.push(sql);
      if(/SELECT status FROM youtube_link_campaigns/.test(sql))return {rows:[{status:'stopped'}]};
      if(/SELECT id,owner,status/.test(sql))return {rows:structuredClone(s.runs)};
      if(/SELECT run_id,operation_key/.test(sql))return {rows:structuredClone(s.admissions)};
      if(/count\(\*\)/.test(sql))return {rows:[{n:0}]};
      if(/^UPDATE youtube_video_identity_admissions/.test(sql)){
        assert.deepEqual(args,[group.id,op.key,digest(receipt),digest(raw)]);
        assert.equal(JSON.parse(await fs.readFile(root+'/cutover.json')).heldResponse.ownershipAccepted,false);
        return {rowCount:1};
      }return {rows:[]};
    },release(){}};
    const cut=await handoverChannels({pool:{connect:async()=>c},plan,root,assertFrozen:async()=>{}});
    assert.equal(cut.heldResponse.importEligible,false);assert.ok(cut.heldResponse.transportReceivedOnly);
    assert.equal(cut.priorReservedCents,2);assert.equal(cut.pendingCount,46);
    assert.ok(!statements.some(sql=>/INSERT|SET reserved_cents|identity_claims/.test(sql)));
  }finally{
    await fs.rm(sourceRoot,{recursive:true,force:true});await fs.rm(root,{recursive:true,force:true});
  }
});
