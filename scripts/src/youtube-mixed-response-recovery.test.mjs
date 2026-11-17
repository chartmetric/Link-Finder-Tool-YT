import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mixedCapturePlan,approveMixedCaptures,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {auditMixedSavedResponses,mixedRecoveryPlan,approveMixedRecovery,
  mixedRecoveryContinuation,approveMixedRecoveryContinuation} from './youtube-mixed-response-recovery.mjs';
import {acknowledgeMixedSavedResponse,executeMixedRecoveryContinuation,
  saveMixedRecoveryResult,verifyMixedRecoveryArchives} from './youtube-mixed-response-recovery-live.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const channel=n=>'UC'+String(n).padStart(22,'a');
const url=n=>'https://www.youtube.com/channel/'+channel(n);
const at='2026-11-17T00:00:00.000Z',later='2026-11-17T01:00:00.000Z';
const runtimeFiles={'runtime/synthetic.mjs':digest('synthetic-runtime')};
const clone=structuredClone;
function fixture(){
  const suffix=randomUUID(),id='youtube-mixed-captures-synthetic-'+suffix;
  const searchId='youtube-test-synthetic-'+suffix,sourceFile='generated-artifacts/'+searchId+'/source.json';
  const artists=[1,2,3].map(n=>({profileId:String(n),cmArtist:String(n+100),name:'Artist '+n,tier:2,
    catalogProfile:{profile_id:String(n),cm_artist:String(n+100)}}));
  const plan=mixedCapturePlan({version:DIRECT_CAPTURE_POLICY,id,preparedAt:at,artists,
    directLeads:artists.map((a,i)=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
      candidates:[{url:url(i+1),title:a.name}]})),uploaderResults:[],
    sourceSearchId:searchId,sourceUploaderIds:[],cohortClaims:artists.map((a,i)=>({
      url:url(i+1),profileId:a.profileId,cmArtist:a.cmArtist})),
    sourceFiles:{[sourceFile]:digest('synthetic-source')},runtimeFiles});
  const approval=approveMixedCaptures(plan,{planSha256:digest(plan),capCents:6,approvedAt:later});
  const savedResponses=plan.operations.slice(0,2).map(op=>{
    const raw=Buffer.from(JSON.stringify({success:true,credits_charged:1,channelId:op.expectedChannelId,
      channel:op.targetUrl,name:'Artist '+op.profileId,description:'Musician'}));
    const receipt={runId:id,planSha256:digest(plan),approvalSha256:digest(approval),
      operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',
      targetUrl:op.targetUrl,inputSha256:op.inputSha256,request:op.request,
      capturedAt:later,status:200,rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)};
    return {receipt,receiptFileSha256:digest(Buffer.from(JSON.stringify(receipt))),rawBodyBase64:raw.toString('base64')};
  });
  const admissions=plan.operations.slice(0,2).map((op,i)=>({run_id:id,operation_key:op.key,
    profile_id:op.profileId,cm_artist:op.cmArtist,channel_id:op.allocationChannelKey,kind:'metadata',
    input_sha256:op.inputSha256,reserved_cents:2,status:i===0?'returned':'admitted',
    receipt_sha256:i===0?digest(savedResponses[i].receipt):null,
    raw_sha256:i===0?savedResponses[i].receipt.rawBodySha256:null,http_status:i===0?200:null}));
  const run={id,owner:'synthetic-original-owner',plan_sha256:digest(plan),approval_sha256:digest(approval),
    execution_sha256:digest(plan.runtimeFiles),cap_cents:6,reserved_cents:4,status:'stopped'};
  const evidence={plan,approval,run,admissions,savedResponses,claims:[]};
  const recovery=mixedRecoveryPlan({id:'youtube-mixed-response-recovery-'+suffix,
    preparedAt:later,evidence,runtimeFiles});
  const recoveryApproval=approveMixedRecovery(recovery,{planSha256:digest(recovery),capCents:0,approvedAt:later});
  return {evidence,recovery,recoveryApproval};
}
function changeBody(evidence,change){
  const saved=evidence.savedResponses[1],body=JSON.parse(Buffer.from(saved.rawBodyBase64,'base64'));
  change(body);const raw=Buffer.from(JSON.stringify(body));
  saved.rawBodyBase64=raw.toString('base64');saved.receipt.rawBodySha256=digest(raw);
  saved.receiptFileSha256=digest(Buffer.from(JSON.stringify(saved.receipt)));
}
test('offline audit binds exact original owner, plan, approvals, paid prefix and raw bytes',()=>{
  const f=fixture(),audit=auditMixedSavedResponses(f.evidence);
  assert.equal(audit.priorReservedCents,4);assert.equal(audit.maximumAdditionalCents,2);
  assert.deepEqual(audit.pending,[f.evidence.plan.operations[2]]);
  assert.equal(audit.providerRequests,0);assert.ok(audit.captures.every(c=>!c.importEligible&&!c.ownershipAccepted));
  for(const mutate of [
    e=>e.run.owner='',e=>e.run.status='running',e=>e.run.plan_sha256=digest('other'),
    e=>e.run.approval_sha256=digest('other'),e=>e.run.execution_sha256=digest('other'),
    e=>e.run.reserved_cents=2,e=>e.run.cap_cents=8,e=>e.approval.capCents=8,
    e=>e.admissions.push(clone(e.admissions[0])),e=>e.admissions[1].input_sha256=digest('other'),
    e=>e.admissions[0].raw_sha256=digest('other'),e=>e.savedResponses[1].receipt.request={},
    e=>e.savedResponses[1].receipt.runId='other',e=>e.savedResponses[1].rawBodyBase64=Buffer.from('changed').toString('base64'),
    e=>e.savedResponses.pop(),e=>e.savedResponses.push(clone(e.savedResponses[0])),
    e=>e.admissions[1].receipt_sha256=digest('partial'),e=>e.admissions.reverse().pop(),
  ]){
    const e=clone(f.evidence);mutate(e);assert.throws(()=>auditMixedSavedResponses(e));
  }
});
test('provider failures, unknown charges, invalid identity and claim conflicts stay unresolved',()=>{
  const f=fixture();
  for(const mutate of [
    e=>e.savedResponses[1].receipt.status=500,
    e=>changeBody(e,b=>b.success=false),
    e=>changeBody(e,b=>b.error='provider failure'),
    e=>changeBody(e,b=>delete b.credits_charged),
    e=>changeBody(e,b=>b.credits_charged=2),
    e=>changeBody(e,b=>b.channelId=channel(9)),
    e=>changeBody(e,b=>delete b.channelId),
    e=>e.claims.push({alias:url(2),channelId:channel(2),profileId:'999',cmArtist:'999'}),
  ]){
    const e=clone(f.evidence);mutate(e);assert.throws(()=>auditMixedSavedResponses(e));
  }
});
test('the same offline recovery contract supports an original mixed-source plan without inventing an uploader',()=>{
  const {evidence}=fixture(),input={...evidence.plan};
  delete input.version;delete input.cohortClaims;
  input.sourceUploaderIds=['youtube-video-review-synthetic-source'];
  const plan=mixedCapturePlan(input);
  const approval=approveMixedCaptures(plan,{planSha256:digest(plan),capCents:6,approvedAt:later});
  evidence.plan=plan;evidence.approval=approval;
  evidence.run.plan_sha256=digest(plan);evidence.run.approval_sha256=digest(approval);
  for(const saved of evidence.savedResponses){
    Object.assign(saved.receipt,{planSha256:digest(plan),approvalSha256:digest(approval)});
    saved.receiptFileSha256=digest(Buffer.from(JSON.stringify(saved.receipt)));
  }
  evidence.admissions[0].receipt_sha256=digest(evidence.savedResponses[0].receipt);
  assert.equal(auditMixedSavedResponses(evidence).pending.length,1);
});
test('receipt approval grants no continuation; fresh exact runtime and ceiling approval are mandatory',()=>{
  const {recovery,recoveryApproval}=fixture();
  const continuation=mixedRecoveryContinuation({id:'youtube-mixed-captures-recovered-synthetic',
    preparedAt:later,recoveryPlan:recovery,recoveryApproval,runtimeFiles});
  assert.equal(continuation.maximumSpendCents,2);assert.equal(continuation.priorReservedCents,4);
  assert.equal(continuation.combinedCapCents,6);
  assert.throws(()=>approveMixedRecoveryContinuation(continuation,recoveryApproval));
  const a=approveMixedRecoveryContinuation(continuation,{planSha256:digest(continuation),capCents:2,approvedAt:later});
  for(const mutate of [
    p=>p.operations.push(recovery.evidence.plan.operations[0]),
    p=>p.operations[0].request.url+='&different=true',
    p=>p.runtimeFiles['runtime/synthetic.mjs']=digest('new runtime'),
    p=>p.maximumSpendCents=6,p=>p.priorReservedCents=0,p=>p.combinedCapCents=8,
    p=>p.recoveryPlan.evidence.run.owner='new-owner',
  ]){
    const p=clone(continuation);mutate(p);assert.throws(()=>approveMixedRecoveryContinuation(p,a));
  }
  assert.throws(()=>approveMixedRecovery(recovery,{...recoveryApproval,capCents:2}));
});
async function liveFixture(t){
  const f=fixture(),sourceRoot='generated-artifacts/'+f.evidence.plan.id;
  const searchRoot='generated-artifacts/'+f.evidence.plan.sourceSearchId;
  const recoveryRoot='generated-artifacts/'+f.recovery.id;
  const roots=[sourceRoot,searchRoot,recoveryRoot];
  t.after(async()=>{for(const root of roots)await fs.rm(root,{recursive:true,force:true});});
  for(const root of roots)await fs.mkdir(root,{recursive:true});
  await fs.mkdir(sourceRoot+'/runtime');await fs.mkdir(sourceRoot+'/receipts');await fs.mkdir(searchRoot+'/receipts');
  await fs.writeFile(sourceRoot+'/plan.json',JSON.stringify(f.evidence.plan));
  await fs.writeFile(sourceRoot+'/approval.json',JSON.stringify(f.evidence.approval));
  await fs.writeFile(sourceRoot+'/runtime/synthetic.mjs','synthetic-runtime');
  await fs.writeFile(searchRoot+'/source.json','synthetic-source');
  for(const saved of f.evidence.savedResponses){
    await fs.writeFile(sourceRoot+'/receipts/'+digest(saved.receipt.operationKey)+'.json',JSON.stringify(saved.receipt));
    await fs.writeFile(sourceRoot+'/'+saved.receipt.rawPath,Buffer.from(saved.rawBodyBase64,'base64'));
  }
  const searchRows=[];
  for(let i=1;i<=20;i++){
    const receipt={operationKey:'synthetic-search-'+i,inputSha256:digest('search-'+i)};
    searchRows.push({operation_key:receipt.operationKey,profile_id:String(i),input_sha256:receipt.inputSha256,
      receipt_sha256:digest(receipt),status:'returned',http_status:200});
    await fs.writeFile(searchRoot+'/receipts/'+archivedSearchReceiptName(String(i)),JSON.stringify(receipt));
  }
  const state={runs:[clone(f.evidence.run)],admissions:clone(f.evidence.admissions),claims:[],requests:[],updates:0};
  let backup=null;
  const client={release(){},async query(sql,args=[]){
    const q=sql.replace(/\s+/g,' ').trim();
    if(q==='BEGIN'){backup=clone(state);return {rows:[]};}
    if(q==='ROLLBACK'){if(backup)Object.assign(state,backup);backup=null;return {rows:[]};}
    if(q==='COMMIT'){
      if(f.failure==='commit_before'){f.failure=null;throw Error('synthetic precommit disconnect');}
      backup=null;
      if(f.failure==='commit_after'){f.failure=null;throw Error('synthetic lost commit reply');}
      return {rows:[]};
    }
    if(q.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(q.startsWith('SELECT to_regclass'))return {rows:[{runs:'runs',admissions:'admissions',claims:'claims'}]};
    if(q.startsWith('SELECT * FROM youtube_video_identity_runs'))return {rows:clone(state.runs.filter(r=>r.id===args[0]))};
    if(q.startsWith('SELECT * FROM youtube_video_identity_admissions'))return {rows:clone(state.admissions.filter(r=>r.run_id===args[0]))};
    if(q.startsWith('SELECT * FROM youtube_video_identity_claims'))return {rows:clone(state.claims)};
    if(q.includes('FROM youtube_link_campaign_channels')||q.includes('FROM youtube_discovery_test_results'))return {rows:[]};
    if(q.startsWith('SELECT status,reserved_cents FROM youtube_discovery_test_runs'))return {rows:[{status:'completed',reserved_cents:40}]};
    if(q.startsWith('SELECT operation_key,profile_id,input_sha256,receipt_sha256,status,http_status'))return {rows:searchRows};
    if(q.startsWith('SELECT profile_id,cm_artist FROM youtube_video_identity_claims'))return {rows:clone(state.claims)};
    if(q.startsWith('SELECT count(*)::int n FROM youtube_video_identity_runs')){
      return {rows:[{n:state.runs.filter(r=>r.status==='running'&&r.id!==args[0]).length}]};
    }
    if(q.startsWith('SELECT count(*)::int n FROM youtube_video_identity_admissions')){
      const rows=state.admissions.filter(r=>r.run_id!==args[0]);
      const n=q.includes("status='admitted'")?rows.filter(r=>r.status==='admitted').length:
        rows.filter(r=>r.kind==='metadata'&&(args[1].includes(r.profile_id)||args[2].includes(r.cm_artist)||
          args[3].includes(r.channel_id))).length;
      return {rows:[{n}]};
    }
    if(q.startsWith('SELECT count(*)::int'))return {rows:[{n:0}]};
    if(q.startsWith('INSERT INTO youtube_video_identity_runs')){
      assert.ok(!state.runs.some(r=>r.id===args[0]),'Unique run prevents replay');
      state.runs.push({id:args[0],owner:args[1],plan_sha256:args[2],approval_sha256:args[3],
        execution_sha256:args[4],cap_cents:args[5],reserved_cents:0,status:'running'});return {rowCount:1};
    }
    if(q.startsWith('INSERT INTO youtube_video_identity_admissions')){
      assert.ok(!state.admissions.some(r=>r.profile_id===args[2]||r.cm_artist===args[3]||r.channel_id===args[4]));
      state.admissions.push({run_id:args[0],operation_key:args[1],profile_id:args[2],cm_artist:args[3],
        channel_id:args[4],kind:'metadata',input_sha256:args[5],reserved_cents:2,status:'admitted',
        receipt_sha256:null,raw_sha256:null,http_status:null});return {rowCount:1};
    }
    if(q.includes('SET reserved_cents=reserved_cents+2')){
      const r=state.runs.find(r=>r.id===args[0]);assert.ok(r.reserved_cents+2<=r.cap_cents);
      r.reserved_cents+=2;return {rowCount:1};
    }
    if(q.includes("SET status='returned'")){
      if(f.failure==='update'){f.failure=null;throw Error('synthetic update disconnect');}
      const row=state.admissions.find(r=>r.run_id===args[0]&&r.operation_key===args[1]);
      assert.equal(row.status,'admitted');state.updates++;
      Object.assign(row,{status:'returned',receipt_sha256:args[2],raw_sha256:args[3],http_status:200});
      return {rowCount:1};
    }
    if(q.startsWith('INSERT INTO youtube_video_identity_claims')){state.claims.push({
      alias:args[0],channel_id:args[1],profile_id:args[2],cm_artist:args[3]});return {rowCount:1};}
    if(q.includes("SET status='completed'")||q.includes("SET status='stopped'")){
      state.runs.find(r=>r.id===args[0]).status=q.includes("SET status='completed'")?'completed':'stopped';
      return {rowCount:1};
    }
    throw Error('Unexpected synthetic SQL: '+q);
  }};
  Object.assign(f,{state,client,pool:{connect:async()=>client},sourceRoot,recoveryRoot,roots,
    assertFrozen:async()=>{},checkCatalog:async()=>{}});
  f.ack=()=>acknowledgeMixedSavedResponse({plan:f.recovery,approval:f.recoveryApproval,
    pool:f.pool,assertFrozen:f.assertFrozen,checkCatalog:f.checkCatalog});
  return f;
}
test('acknowledgment is separately approved, idempotent and changes no reservations, archives or claims',async t=>{
  const f=await liveFixture(t),before=clone(f.state.runs);
  const original=await fs.readFile(f.sourceRoot+'/plan.json');
  const first=await f.ack(),second=await f.ack();assert.deepEqual(first,second);
  assert.equal(f.state.updates,1);assert.deepEqual(f.state.runs,before);assert.equal(f.state.claims.length,0);
  assert.deepEqual(await fs.readFile(f.sourceRoot+'/plan.json'),original);
  await saveMixedRecoveryResult(f.recoveryRoot,first);await saveMixedRecoveryResult(f.recoveryRoot,second);
  await assert.rejects(()=>saveMixedRecoveryResult(f.recoveryRoot,{...first,status:'changed'}));
  assert.equal(f.state.requests.length,0);
});
for(const fault of ['update','commit_before','commit_after']){
  test('interruption at '+fault+' can be reconciled without paying or acknowledging twice',async t=>{
    const f=await liveFixture(t);f.failure=fault;
    await assert.rejects(f.ack,/synthetic/);
    await f.ack();await f.ack();
    assert.equal(f.state.updates,1);assert.equal(f.state.runs[0].reserved_cents,4);
    assert.equal(f.state.runs[0].status,'stopped');assert.equal(f.state.claims.length,0);
  });
}
test('changed owner, new admissions, raw tampering, orphan files and current identity conflicts block recovery',async t=>{
  for(const fault of ['owner','ledger','raw','orphan','catalog','historical','raw_only','partial_receipt','catalog_in_transaction']){
    await t.test(fault,async t=>{
      const f=await liveFixture(t);
      if(fault==='owner')f.state.runs[0].owner='other-owner';
      if(fault==='ledger')f.state.admissions.push({...f.state.admissions[1],operation_key:'unknown'});
      if(fault==='raw')await fs.writeFile(f.sourceRoot+'/'+f.evidence.savedResponses[1].receipt.rawPath,'changed');
      if(fault==='orphan')await fs.writeFile(f.sourceRoot+'/receipts/orphan.raw','unknown-charge');
      if(fault==='catalog')f.checkCatalog=async()=>{throw Error('current catalog conflict');};
      if(fault==='historical')f.state.claims.push({alias:url(2),channel_id:channel(2),profile_id:'999',cm_artist:'999'});
      const receiptFile=f.sourceRoot+'/receipts/'+digest(f.evidence.savedResponses[1].receipt.operationKey)+'.json';
      if(fault==='raw_only')await fs.unlink(receiptFile);
      if(fault==='partial_receipt')await fs.writeFile(receiptFile,'{"partial":');
      if(fault==='catalog_in_transaction'){
        let calls=0;f.checkCatalog=async()=>{if(++calls===2)throw Error('catalog check unavailable');};
      }
      await assert.rejects(f.ack);assert.equal(f.state.updates,0);assert.equal(f.state.runs[0].reserved_cents,4);
    });
  }
});
test('an interruption after committing but before writing the result can recreate only the new recovery artifact',async t=>{
  const f=await liveFixture(t),first=await f.ack();
  // No result yet: model a process exit between COMMIT and local publication.
  await assert.rejects(()=>fs.readFile(f.recoveryRoot+'/recovery-result.json'),{code:'ENOENT'});
  await fs.writeFile(f.recoveryRoot+'/recovery-result.json.abandoned.tmp','partial write');
  const again=await f.ack();assert.deepEqual(again,first);
  await Promise.all([saveMixedRecoveryResult(f.recoveryRoot,again),saveMixedRecoveryResult(f.recoveryRoot,again)]);
  assert.deepEqual(JSON.parse(await fs.readFile(f.recoveryRoot+'/recovery-result.json')),first);
  assert.equal(f.state.updates,1);assert.equal(f.state.requests.length,0);
});
test('an exact separately approved suffix dispatches only untouched work under the original combined ceiling',async t=>{
  const f=await liveFixture(t);
  const plan=mixedRecoveryContinuation({id:'youtube-mixed-captures-recovered-'+randomUUID(),
    preparedAt:later,recoveryPlan:f.recovery,recoveryApproval:f.recoveryApproval,runtimeFiles});
  const approval=approveMixedRecoveryContinuation(plan,{planSha256:digest(plan),capCents:2,approvedAt:later});
  const root='generated-artifacts/'+plan.id;f.roots.push(root);await fs.mkdir(root);
  const options={root,plan,approval,pool:f.pool,assertFrozen:f.assertFrozen,checkCatalog:f.checkCatalog,
    credential:'synthetic-only',fetchImpl:async request=>{
      f.state.requests.push(request);const op=plan.operations[0];
      assert.equal(request,op.request.url);
      assert.equal(f.state.admissions.find(a=>a.run_id===plan.id).status,'admitted');
      return Response.json({success:true,credits_charged:1,channelId:op.expectedChannelId,
        channel:op.targetUrl,name:'Artist 3',description:'Musician'});
    }};
  await assert.rejects(()=>executeMixedRecoveryContinuation(options));assert.equal(f.state.requests.length,0);
  await f.ack();await executeMixedRecoveryContinuation(options);
  assert.equal(f.state.requests.length,1);
  assert.equal(f.state.runs.reduce((n,r)=>n+r.reserved_cents,0),6);
  assert.equal(f.state.runs[0].status,'stopped');assert.equal(f.state.runs[1].status,'completed');
  await assert.rejects(()=>executeMixedRecoveryContinuation(options));assert.equal(f.state.requests.length,1);
});
test('offline command is usable behind the network fence with no credentials or coordinator',async t=>{
  const f=await liveFixture(t),file=f.recoveryRoot+'/synthetic-evidence.json';
  await fs.writeFile(file,JSON.stringify(f.evidence));
  const result=spawnSync(process.execPath,['--import','./scripts/src/youtube-ownership-offline-fence.mjs',
    './scripts/src/prepare-youtube-mixed-response-recovery.mjs','--audit-offline','--evidence='+file],
  {cwd:process.cwd(),encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).providerRequests,0);
  await verifyMixedRecoveryArchives(f.recovery);
});
test('the sealed CLI authorizes only the exact zero-spend proposal and rejects dispatch or runtime tampering',async t=>{
  const f=await liveFixture(t),root=f.recoveryRoot;
  const files=await freezeLocalModules('scripts/src/run-youtube-mixed-response-recovery.mjs',root+'/runtime');
  const sealedFiles={};
  for(const file of files){
    const name='runtime/'+file.split('/').at(-1);sealedFiles[name]=digest(await fs.readFile(root+'/'+name));
  }
  const plan=mixedRecoveryPlan({...f.recovery,runtimeFiles:sealedFiles});
  await fs.writeFile(root+'/plan.json',JSON.stringify(plan));
  const run=args=>spawnSync(process.execPath,['--import','./scripts/src/youtube-ownership-offline-fence.mjs',
    root+'/runtime/run-youtube-mixed-response-recovery.mjs','--id='+plan.id,...args],
  {cwd:process.cwd(),encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  const authorized=run(['--authorize-prepared','--plan-sha256='+digest(plan),'--approve-cents=0']);
  assert.equal(authorized.status,0,authorized.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(root+'/approval.json')),
    approveMixedRecovery(plan,{planSha256:digest(plan),capCents:0,
      approvedAt:JSON.parse(await fs.readFile(root+'/approval.json')).approvedAt}));
  assert.notEqual(run(['--run-approved']).status,0,'A recovery approval never permits dispatch');
  const dependency=Object.keys(sealedFiles).find(f=>f.endsWith('/youtube-mixed-response-recovery-live.mjs'));
  await fs.appendFile(root+'/'+dependency,'\n// synthetic runtime mutation\n');
  const tampered=run(['--acknowledge-approved']);
  assert.notEqual(tampered.status,0);
  assert.ok(!tampered.stderr.includes('Network forbidden'),'Runtime mismatch is caught before coordinator access');
  assert.equal(f.state.updates,0);
});
