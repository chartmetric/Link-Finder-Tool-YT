import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {prepareVideoIdentityModels,reviewVideoIdentityAnswers} from './youtube-video-identity-plan.mjs';
import {approveIdentityExecution,assertIdentityExecutionApproval,executeVideoIdentity,identityClaims,
  assertNoNewIdentityClaims,archiveBytes} from './youtube-video-identity-execution.mjs';
import {identityCatalogCheck,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {identityExecutionOptions} from './run-youtube-video-identity.mjs';
import {identityExecutionFixture,fixtureAt,fixtureChannelData,fixtureModelData} from './youtube-video-identity-execution-fixture.mjs';

async function rootFor(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'identity-execution-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
function memoryGate(fixture,root,{failAt}={}){
  const state={reserved:0,admitted:[],returned:[],status:null};
  return {state,
    async start(){assert.equal(state.status,null);state.status='running';},
    async admit(op){
      if(failAt==='admit')throw Error('admission fence');
      assert.equal(state.admitted.length,state.returned.length);
      state.reserved+=2;state.admitted.push(op.key);
    },
    async returned(op,receiptSha,rawSha){
      const receipt=await fs.readFile(root+'/receipts/'+digest(op.key)+'.json');
      const raw=await fs.readFile(root+'/receipts/'+digest(op.key)+'.raw');
      assert.equal(digest(receipt),receiptSha);assert.equal(digest(raw),rawSha);
      if(failAt==='returned')throw Error('owner fence');
      state.returned.push(op.key);
    },
    async finish(status){
      if(status==='completed')assert.equal(state.returned.length,fixture.plan.maximumCalls);
      state.status=status;
    }};
}
test('execution approval is separate and binds the exact stage, cap and executor',()=>{
  const f=identityExecutionFixture();
  assert.equal(f.approval.executionEnabled,false);
  assert.equal(f.executionApproval.executionEnabled,true);
  assert.throws(()=>assertIdentityExecutionApproval(f.plan,f.approval,f.manifest,f.approval));
  for(const mutate of [
    x=>x.capCents++,x=>x.planSha256=digest('other'),x=>x.executionSha256=digest('other'),
    x=>x.approvedAt='2026-01-01',x=>x.executionEnabled=false,
  ]){
    const changed=structuredClone(f.executionApproval);mutate(changed);
    assert.throws(()=>assertIdentityExecutionApproval(f.plan,f.approval,f.manifest,changed));
  }
  const model=identityExecutionFixture({model:true});
  assert.throws(()=>assertIdentityExecutionApproval(model.plan,model.approval,model.manifest,f.executionApproval));
  assert.equal(approveIdentityExecution(f.plan,f.approval,f.manifest,f.executionApproval).capCents,40);
});
test('capture and model execution persist exact bytes before acknowledgment and produce preparer-compatible returns',async t=>{
  let captures=null;
  for(const model of [false,true]){
    const f=identityExecutionFixture({model}),root=await rootFor(t),gate=memoryGate(f,root),calls=[];
    const before=digest(f.plan);
    const returns=await executeVideoIdentity({...f,root,gate,assertFrozen:async()=>{},
      credentials:{scrapecreators:'synthetic-key',openrouter:'synthetic-key'},
      fetchImpl:async(url,options)=>{
        const op=f.plan.operations[calls.length];calls.push(op);
        assert.equal(url,op.request.url);assert.equal(options.redirect,'error');
        assert.equal(options.method,op.request.method);
        assert.equal(options.body,op.request.body?JSON.stringify(op.request.body):undefined);
        const raw=JSON.stringify(model?fixtureModelData():fixtureChannelData(op));
        return new Response(' \n'+raw+' \n',{status:200});
      }});
    assert.equal(digest(f.plan),before);
    assert.equal(gate.state.reserved,f.plan.maximumSpendCents);
    assert.equal(gate.state.status,'completed');
    assert.deepEqual(JSON.parse(await fs.readFile(root+'/returns.json','utf8')),returns);
    assert.ok(Buffer.from(returns.receipts[0].rawBodyBase64,'base64').toString().startsWith(' \n'));
    if(!model){
      captures=returns;
      const prepared=prepareVideoIdentityModels({id:'youtube-video-identity-execution-next',preparedAt:fixtureAt,
        runtimeFiles:f.plan.runtimeFiles,capturePlan:f.plan,captureReturns:returns});
      assert.ok(prepared.maximumCalls>0);
    }else assert.equal(reviewVideoIdentityAnswers(f.plan,returns).length,20);
  }
  assert.ok(captures);
});
test('provider errors, unknown billing, wrong IDs, malformed bytes, funding and owner loss stop without retry or completion',async t=>{
  const failures=[
    {fetch:()=>{throw Error('timeout');}},
    {body:'not-json'},
    {body:JSON.stringify({error:'insufficient credits'}),status:402},
    {data:op=>({...fixtureChannelData(op),channelId:'UC'+''.padStart(22,'9')})},
    {data:op=>({...fixtureChannelData(op),credits_charged:undefined})},
    {data:op=>({...fixtureChannelData(op),credits_charged:2})},
    {body:Buffer.from([0xff])},
    {body:'x'.repeat(2*1024*1024+1)},
    {failAt:'returned'},
  ];
  for(const failure of failures){
    const f=identityExecutionFixture(),root=await rootFor(t),gate=memoryGate(f,root,failure);let calls=0;
    await assert.rejects(()=>executeVideoIdentity({...f,root,gate,assertFrozen:async()=>{},
      credentials:{scrapecreators:'synthetic'},fetchImpl:async()=>{
        calls++;if(failure.fetch)return failure.fetch();
        return new Response(failure.body??JSON.stringify((failure.data??fixtureChannelData)(f.plan.operations[0])),
          {status:failure.status??200});
      }}));
    assert.equal(calls,1);assert.equal(gate.state.reserved,2);
    assert.equal(gate.state.returned.length,0);assert.equal(gate.state.status,'stopped');
    await assert.rejects(fs.access(root+'/returns.json'));
  }
  for(const data of [
    {...fixtureModelData(),model:'unapproved-model'}, {...fixtureModelData(),usage:{}},
    {...fixtureModelData(),usage:{cost:.03}},
  ]){
    const f=identityExecutionFixture({model:true}),root=await rootFor(t),gate=memoryGate(f,root);
    await assert.rejects(()=>executeVideoIdentity({...f,root,gate,assertFrozen:async()=>{},
      credentials:{openrouter:'synthetic'},fetchImpl:async()=>new Response(JSON.stringify(data))}));
    assert.equal(gate.state.returned.length,0);
  }
});
test('pre-dispatch failures never spend; frozen evidence changes after one return stop the next operation',async t=>{
  for(const fail of ['approval','credential','frozen','admit','start']){
    const f=identityExecutionFixture(),root=await rootFor(t),gate=memoryGate(f,root,{failAt:fail});let calls=0;
    if(fail==='approval')f.executionApproval.capCents++;
    if(fail==='start')gate.start=async()=>{throw Error('coordinator unavailable');};
    await assert.rejects(()=>executeVideoIdentity({...f,root,gate,
      assertFrozen:async()=>{if(fail==='frozen')throw Error('changed');},
      credentials:{scrapecreators:fail==='credential'?null:'synthetic'},
      fetchImpl:async()=>{calls++;throw Error('must not dispatch');}}));
    assert.equal(calls,0);assert.equal(gate.state.reserved,0);
  }
  const f=identityExecutionFixture(),root=await rootFor(t),gate=memoryGate(f,root);let calls=0;
  await assert.rejects(()=>executeVideoIdentity({...f,root,gate,credentials:{scrapecreators:'synthetic'},
    assertFrozen:async()=>{if(gate.state.returned.length)throw Error('changed approval');},
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify(fixtureChannelData(f.plan.operations[0])));}}));
  assert.equal(calls,1);assert.equal(gate.state.reserved,2);
});
test('receipt persistence failure never acknowledges or retries the paid request',async t=>{
  const f=identityExecutionFixture(),root=await rootFor(t),gate=memoryGate(f,root);let calls=0;
  const op=f.plan.operations[0],rawFile=root+'/receipts/'+digest(op.key)+'.raw';
  await assert.rejects(()=>executeVideoIdentity({...f,root,gate,assertFrozen:async()=>{},
    credentials:{scrapecreators:'synthetic'},fetchImpl:async()=>{
      calls++;await fs.writeFile(rawFile,'existing immutable bytes',{flag:'wx'});
      return new Response(JSON.stringify(fixtureChannelData(op)));
    }}));
  assert.equal(calls,1);assert.equal(gate.state.reserved,2);
  assert.equal(gate.state.returned.length,0);assert.equal(gate.state.status,'stopped');
  assert.equal(await fs.readFile(rawFile,'utf8'),'existing immutable bytes');
  await assert.rejects(fs.access(root+'/returns.json'));
});
test('all alternatives and aliases participate in outside-cohort claims and current eligibility checks',async()=>{
  const {plan}=identityExecutionFixture();
  const claims=identityClaims(plan),alias=claims[0].alias;
  assertNoNewIdentityClaims(claims,claims);
  assert.throws(()=>assertNoNewIdentityClaims(claims,[{alias,profileId:'999',cmArtist:'999'}]));
  assert.throws(()=>assertNoNewIdentityClaims(claims,[{alias:'',channelId:claims[0].channelId,profileId:'999',cmArtist:'999'}]));
  const rows=plan.selections.map(s=>({profile_id:s.profileId,cm_artist:s.cmArtist,artist:s.artist,tier:s.tier,snapshot_at:fixtureAt}));
  const now=Date.parse(fixtureAt)+1000;
  assertCurrentIdentityEligibility(plan.selections,rows,now);
  for(const mutate of [
    a=>a.pop(),a=>a[0].cm_artist='999',a=>a[0].tier=5,a=>a[0].artist='new identity',
    a=>a[0].snapshot_at='2020-01-01',
  ]){
    const changed=structuredClone(rows);mutate(changed);
    assert.throws(()=>assertCurrentIdentityEligibility(plan.selections,changed,now));
  }
  let n=0;
  await assert.rejects(identityCatalogCheck(plan,{now:()=>now,query:async sql=>{
    if(++n===1){assert.match(sql,/grain='global'/);assert.ok(!sql.includes('LIMIT 4 BY'));return rows;}
    return [{account_url:alias,profile_id:'999',cm_artist:'999'}];
  }})(claims));
  await assert.rejects(identityCatalogCheck(plan,{query:async()=>{throw Error('catalog unavailable');}})(claims));
});
test('CLI refuses unsafe options and symlink archive inputs',async t=>{
  for(const args of [
    ['--run-approved','--id=youtube-video-review-test'],
    ['--run-approved','--id=youtube-video-identity-test','--approve-cents=40'],
    ['--authorize-execution','--id=youtube-video-identity-test'],
    ['--prepare-executor','--run-approved','--id=youtube-video-identity-test'],
    ['--prepare-executor','--id=youtube-video-identity-test','--id=youtube-video-identity-test'],
  ])assert.throws(()=>identityExecutionOptions(args));
  const root=await rootFor(t);await fs.symlink('/tmp',root+'/link');
  await assert.rejects(archiveBytes(root,'link/anything'));
});
test('real CLI prepares and separately authorizes offline, refuses mutable runtime and never alters sources',async t=>{
  const root=await rootFor(t),f=identityExecutionFixture(),archive=root+'/generated-artifacts/'+f.plan.id;
  await fs.mkdir(archive,{recursive:true});await fs.mkdir(archive+'/runtime');
  await fs.writeFile(archive+'/plan.json',JSON.stringify(f.plan));
  await fs.writeFile(archive+'/approval.json',JSON.stringify(f.approval));
  await fs.writeFile(archive+'/runtime/fixture.mjs','// preparation fixture');
  const fence=root+'/fence.mjs';
  await fs.writeFile(fence,`import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
    const fail=()=>{throw Error('offline executor attempted network');};
    globalThis.fetch=fail;net.Socket.prototype.connect=fail;tls.connect=fail;
    http.request=fail;https.request=fail;http.get=fail;https.get=fail;`);
  const run=(file,args)=>spawnSync(process.execPath,[file,...args],{cwd:root,
    env:{PATH:process.env.PATH,HOME:root,NODE_OPTIONS:'--import='+fence},encoding:'utf8',timeout:30000});
  const entry=path.resolve('scripts/src/run-youtube-video-identity.mjs');
  let p=run(entry,['--prepare-executor','--id='+f.plan.id]);assert.equal(p.status,0,p.stderr);
  const manifest=JSON.parse(await fs.readFile(archive+'/execution/manifest.json','utf8'));
  const args=['--authorize-execution','--id='+f.plan.id,'--plan-sha256='+digest(f.plan),
    '--execution-sha256='+digest(manifest),'--approve-cents=40'];
  assert.notEqual(run(entry,args).status,0,'Unsealed authorization must fail');
  const sealed=archive+'/execution/runtime/run-youtube-video-identity.mjs';
  p=run(sealed,args);assert.equal(p.status,0,p.stderr);
  assert.notEqual(run(sealed,args).status,0,'Approval must never be overwritten');
  const module=archive+'/execution/runtime/youtube-video-identity-gate.mjs';
  await fs.appendFile(module,'\n// modified');
  assert.notEqual(run(sealed,['--run-approved','--id='+f.plan.id]).status,0);
  assert.equal(digest(JSON.parse(await fs.readFile(archive+'/plan.json','utf8'))),digest(f.plan));
  assert.equal(digest(JSON.parse(await fs.readFile(archive+'/approval.json','utf8'))),digest(f.approval));
  await assert.rejects(fs.access(archive+'/returns.json'));
});
