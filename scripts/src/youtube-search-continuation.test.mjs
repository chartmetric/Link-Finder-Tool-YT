import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {stagedSearchPlan,approveStagedSearch} from './youtube-staged-search-plan.mjs';
import {hundredSearchPlan,approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {fiveHundredSearchPlan,approveFiveHundredSearch} from './youtube-five-hundred-search-plan.mjs';
import {untouchedSearchScope,searchContinuationPlan,approveSearchContinuation,searchRecordFromReceipt} from './youtube-search-continuation.mjs';
import {assertSearchContinuationReady,searchContinuationGate} from './youtube-search-continuation-live.mjs';
import {checkContinuationEligibility,runSearchContinuationGroup} from './run-youtube-search-continuation.mjs';
import {campaignTransport} from './youtube-campaign-core.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const at='2026-11-16T20:00:00Z';
function fixture(){
  const childApprovals=[],leafApprovals=[],runs=[],admissions=[],results=[];
  const children=Array.from({length:5},(_,group)=>{
    const cohorts=Array.from({length:5},(_,part)=>{
      const artists=Array.from({length:20},(_,i)=>({
        profile_id:String(group*100+part*20+i+1),cm_artist:String(group*100+part*20+i+1001),
        artist:'Artist '+(group*100+part*20+i+1),tier:2,ordinal:group*100+part*20+i,
        snapshot_at:'2026-11-16 01:30:16',
      }));
      const id=`youtube-test-continuation-fixture-${group}-${part}`;
      const packets=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
        catalogProfile:{profile_id:a.profile_id,cm_artist:a.cm_artist},linkedAccounts:[],releases:[],catalogTracks:[]}));
      const plan=stagedSearchPlan({id,preparedAt:at,artists,packets,
        evidenceFiles:{'evidence/catalog.json':digest('evidence')},runtimeFiles:{'runtime/leaf.mjs':digest('leaf')}});
      const approval=approveStagedSearch(plan,{expectedPlanSha256:digest(plan),capCents:40,approvedAt:at});
      leafApprovals.push(approval);
      if(group===0){
        const n=part===4?10:20;
        runs.push({id,owner:'owner-'+part,scope_sha256:plan.scopeSha256,
          cap_cents:40,reserved_cents:n*2,status:part===4?'stopped':'completed'});
        for(const [i,artist] of artists.entries()){
          const op=plan.operations[i];
          results.push({run_id:id,profile_id:artist.profile_id,cm_artist:artist.cm_artist,
            artist:artist.artist,tier:2,status:part<4||i<9?'search_returned':'search_prepared',
            metadata_json:{approvalSha256:digest(approval)},candidates_json:[]});
          if(i<n)admissions.push({run_id:id,operation_key:op.key,profile_id:op.profileId,
            kind:'search',input_sha256:op.inputSha256,reserved_cents:2,status:'returned',
            receipt_sha256:digest('receipt '+op.key),http_status:200});
        }
      }
      return {id,plan};
    });
    const id='youtube-batch-100-continuation-fixture-'+group;
    const plan=hundredSearchPlan({id,preparedAt:at,children:cohorts,runtimeFiles:{'runtime/child.mjs':digest('child')}});
    childApprovals.push(approveHundredSearch(plan,{planSha256:digest(plan),capCents:200,approvedAt:at}));
    return {id,plan};
  });
  const plan=fiveHundredSearchPlan({id:'youtube-batch-500-continuation-fixture',preparedAt:at,children,
    runtimeFiles:{'runtime/parent.mjs':digest('parent')}});
  const approval=approveFiveHundredSearch(plan,{planSha256:digest(plan),capCents:1000,approvedAt:at});
  return {plan,approval,childApprovals,leafApprovals,runs,admissions,results};
}
function continuation(source){
  return searchContinuationPlan({id:'youtube-search-continuation-fixture',preparedAt:at,
    evidenceFiles:{'evidence/source.json':digest('evidence')},
    runtimeFiles:{'runtime/run.mjs':digest('worker')}},source);
}
function database(source,{group,owner='new-owner',block='',total=0,extraHistory=false}={}){
  const writes=[],newAdmissions=[],run={id:group?.id,owner,status:'running',scope_sha256:group?.scopeSha256,
    cap_cents:group?.maximumSpendCents,reserved_cents:0};
  const c={release(){},async query(sql,params=[]){
    if(sql.startsWith('SELECT id,owner'))return {rows:source.runs};
    if(sql.startsWith('SELECT run_id,operation_key'))return {rows:source.admissions};
    if(sql.startsWith('SELECT run_id,profile_id')){
      if(sql.includes('WHERE run_id=ANY'))return {rows:source.results};
      const rows=source.results.filter(r=>params[0].includes(r.profile_id)||params[1].includes(r.cm_artist));
      return {rows:extraHistory?[...rows,{...rows[0],run_id:'unrelated-run'}]:rows};
    }
    if(sql.startsWith('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:'stopped'}]};
    if(sql.startsWith('SELECT * FROM youtube_discovery_test_runs'))return {rows:[run]};
    if(sql.includes('COALESCE(sum(reserved_cents)'))return {rows:[{n:total}]};
    if(sql.startsWith('SELECT count'))return {rows:[{n:block&&sql.includes(block)?1:0}]};
    if(sql.startsWith('SELECT status,http_status FROM youtube_bounded_test_admissions'))
      return {rows:newAdmissions};
    if(/^(INSERT|UPDATE)/.test(sql)){
      writes.push(sql);
      if(sql.startsWith('INSERT INTO youtube_discovery_test_runs')){
        run.id=params[0];run.owner=params[1];run.scope_sha256=params[2];run.cap_cents=params[3];
      }
      if(sql.startsWith('INSERT INTO youtube_bounded_test_admissions')){
        newAdmissions.push({key:params[1],status:'admitted'});run.reserved_cents+=2;
      }
      if(sql.startsWith('UPDATE youtube_bounded_test_admissions')){
        const row=newAdmissions.find(r=>r.key===params[1]);assert.ok(row);
        row.status='returned';row.http_status=params[6];
      }
      return {rowCount:1,rows:[]};
    }
    assert.ok(['BEGIN','COMMIT','ROLLBACK'].includes(sql),'Unexpected SQL: '+sql);
    return {rows:[]};
  }};
  return {writes,newAdmissions,pool:{connect:async()=>c,query:(...args)=>c.query(...args)},c};
}
test('continuation preserves 90 paid identities and selects only the original 410 unspent searches',()=>{
  const source=fixture(),scope=untouchedSearchScope(source),plan=continuation(source);
  assert.equal(scope.paid.length,90);assert.equal(scope.pending.length,410);
  assert.equal(scope.unprocessedSavedResponses,1);assert.equal(plan.priorReservedCents,180);
  assert.equal(plan.maximumSpendCents,820);assert.equal(plan.combinedMaximumCents,1000);
  assert.deepEqual(plan.groups.map(g=>g.operations.length),[10,...Array(20).fill(20)]);
  assert.equal(new Set(plan.groups.flatMap(g=>g.operations.map(o=>o.profileId))).size,410);
  assert.deepEqual(plan.groups.flatMap(g=>g.operations),scope.pending.map(p=>p.operation));
  assert.equal(plan.explicitApproval,false);
  const a=approveSearchContinuation(plan,source,{planSha256:digest(plan),capCents:820,approvedAt:at});
  for(const patch of [{capCents:1000},{planSha256:digest('wrong')}]){
    assert.throws(()=>approveSearchContinuation(plan,source,{...a,...patch}));
  }
  const changed=structuredClone(plan);changed.groups[0].operations[0].request.body.q='substituted';
  assert.throws(()=>approveSearchContinuation(changed,source,a));
});
test('unknown paid requests, altered owners/budgets, duplicate admissions and non-prefix dispatch stay blocked',()=>{
  const source=fixture();
  for(const change of [
    s=>s.admissions[0].status='admitted',
    s=>s.admissions[0].http_status=500,
    s=>s.admissions.push(s.admissions[0]),
    s=>s.runs[0].status='running',
    s=>s.runs[0].owner='',
    s=>s.runs[0].reserved_cents=2,
    s=>s.results[0].metadata_json.approvalSha256=digest('other'),
    s=>s.admissions[0].input_sha256=digest('other'),
    s=>s.admissions.shift(),
  ]){
    const changed=structuredClone(source);change(changed);
    assert.throws(()=>untouchedSearchScope(changed));
  }
});
test('only exact source placeholders are allowed; real history, pending work and ledger changes fail closed',async()=>{
  const source=fixture(),plan=continuation(source),group=plan.groups[0];
  await assertSearchContinuationReady(database(source,{group}).c,source,group);
  for(const options of [{extraHistory:true},{block:"status='admitted'"},{block:'youtube_video_identity_runs'}]){
    await assert.rejects(assertSearchContinuationReady(database(source,{group,...options}).c,source,group));
  }
  const modified=structuredClone(source);modified.runs[0].owner='changed';
  await assert.rejects(assertSearchContinuationReady(database(modified,{group}).c,source,group));
});
test('transactional gate admits exact unspent searches only, with independent owner, cap and global-history fences',async()=>{
  const source=fixture(),plan=continuation(source),group=plan.groups[0];
  const approval=approveSearchContinuation(plan,source,{planSha256:digest(plan),capCents:820,approvedAt:at});
  const make=options=>{
    const db=database(source,{group,...options});
    const gate=searchContinuationGate({pool:db.pool,source,plan,group,approval,
      owner:'new-owner',assertFrozen:async()=>{}});
    return {...db,gate};
  };
  const valid=make();await valid.gate.admit(group.operations[0]);
  assert.equal(valid.writes.length,2);
  for(const options of [{owner:'wrong-owner'},{total:820},{extraHistory:true},{block:"status='admitted'"}]){
    const db=make(options);await assert.rejects(db.gate.admit(group.operations[0]));assert.equal(db.writes.length,0);
  }
  for(const op of [untouchedSearchScope(source).paid[0].operation,
    {...group.operations[0],kind:'metadata'},
    {...group.operations[0],inputSha256:digest('changed')}]){
    const db=make();await assert.rejects(db.gate.admit(op));assert.equal(db.writes.length,0);
  }
});
test('saved successful content is processed offline without changing ownership or treating a title as a provider error',()=>{
  const entry=untouchedSearchScope(fixture()).paid.at(-1);
  const receipt={kind:'search',operationKey:entry.operation.key,inputSha256:entry.operation.inputSha256,
    request:entry.operation.request,status:200,parseFailed:false,
    data:{organic:[{title:'The Unauthorized Rusical',link:'https://www.youtube.com/watch?v=abcdefghijk',snippet:'Music'}],credits:1}};
  const record=searchRecordFromReceipt({...entry,receipt,receiptPath:'saved/receipt.json',receiptBytes:Buffer.from(JSON.stringify(receipt))});
  assert.equal(record.ownershipAccepted,false);assert.equal(record.channelAbsenceProven,false);
  for(const change of [p=>p.status=403,p=>p.data={error:'invalid API key'},
    p=>p.request.body.q='different',p=>p.operationKey='other',p=>p.data.organic=null]){
    const changed=structuredClone(receipt);change(changed);
    assert.throws(()=>searchRecordFromReceipt({...entry,receipt:changed,receiptPath:'saved',receiptBytes:Buffer.from('{}')}));
  }
  assert.equal(evidenceDigest(receipt.request),entry.operation.inputSha256);
});
test('fresh eligibility still blocks changed names, IDs, tiers, missing profiles and stale snapshots',async()=>{
  const artist=untouchedSearchScope(fixture()).pending[0].artist;
  const row={...artist,snapshot_at:'2026-11-16 01:30:16'};
  const now=Date.parse(at);
  await checkContinuationEligibility([artist],{query:async()=>[row],now});
  for(const rows of [[],[{...row,artist:'Other'}],[{...row,cm_artist:'9'}],
    [{...row,tier:5}],[{...row,snapshot_at:'2026-11-10 01:30:16'}]]){
    await assert.rejects(checkContinuationEligibility([artist],{query:async()=>rows,now}));
  }
});
test('sealed continuation binds source evidence and the corrected worker without enabling dispatch',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-search-continuation-'));
  try{
    const root=temp+'/proposal';await fs.mkdir(root);await fs.mkdir(root+'/evidence');
    const source=fixture(),evidenceFiles={},runtimeFiles={};
    for(const [name,value] of [['evidence/source.json',source],['evidence/source-files.json',{}]]){
      const bytes=JSON.stringify(value);await fs.writeFile(root+'/'+name,bytes);evidenceFiles[name]=digest(bytes);
    }
    for(const file of await freezeLocalModules(path.resolve('scripts/src/run-youtube-search-continuation.mjs'),root+'/runtime'))
      runtimeFiles['runtime/'+path.basename(file)]=digest(await fs.readFile(file));
    const plan=searchContinuationPlan({id:'youtube-search-continuation-fixture',preparedAt:at,evidenceFiles,runtimeFiles},source);
    await fs.writeFile(root+'/plan.json',JSON.stringify(plan));
    const {assertSearchContinuationFrozen}=await import(pathToFileURL(root+'/runtime/run-youtube-search-continuation.mjs'));
    await assertSearchContinuationFrozen(root,plan);
    await fs.writeFile(root+'/runtime/youtube-ownership-transport.mjs','changed');
    await assert.rejects(assertSearchContinuationFrozen(root,plan));
    assert.ok(!(await fs.readdir(root)).includes('approval.json'));
  }finally{await fs.rm(temp,{recursive:true,force:true});}
});
test('mock execution saves standard channel-stage inputs, accounts before dispatch and never retries a provider failure',async()=>{
  const source=fixture(),plan=continuation(source),group=plan.groups[0];
  const approval=approveSearchContinuation(plan,source,{planSha256:digest(plan),capCents:820,approvedAt:at});
  for(const failAt of [null,2]){
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-search-run-')),old=process.cwd();
    try{
      process.chdir(temp);await fs.mkdir('generated-artifacts');await fs.mkdir('proposal');
      const db=database(source,{group});let calls=0;
      const execute=()=>runSearchContinuationGroup({root:'proposal',plan,source,approval,group,pool:db.pool,
        assertFrozen:async()=>{},eligibilityCheck:async()=>{},
        transportFactory:options=>campaignTransport({...options,fetchImpl:async()=>{
          calls++;assert.equal(db.newAdmissions.length,calls,'Reserve exactly once before sending');
          return new Response(JSON.stringify(calls===failAt?{error:'invalid API key'}:
            {organic:[],credits:1}),{status:calls===failAt?403:200});
        }})});
      if(failAt)await assert.rejects(execute(),/provider_authentication/);
      else await execute();
      assert.equal(calls,failAt??10);
      const folder='generated-artifacts/'+group.id;
      const summary=JSON.parse(await fs.readFile(folder+'/summary.json'));
      assert.equal(summary.status,failAt?'stopped':'completed');
      assert.equal(summary.reservedCents,calls*2);
      assert.equal((await fs.readdir(folder+'/receipts')).length,calls);
      assert.equal((await fs.readdir(folder+'/artists')).length,failAt?1:10);
      assert.equal(JSON.parse(await fs.readFile(folder+'/plan.json')).parentPlanSha256,digest(plan));
      assert.ok(db.newAdmissions.every(r=>r.status==='returned'));
    }finally{process.chdir(old);await fs.rm(temp,{recursive:true,force:true});}
  }
});
