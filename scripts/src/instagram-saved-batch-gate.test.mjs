import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSavedBatchGate,SAVED_BATCH_REQUEST_TIMEOUT_MS} from './instagram-saved-batch-gate.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(cap=2000){
  const body={state:{artist:'Frozen artist'},questions:{}};
  const scope={authorization:{approved:true,maxSpendCents:cap,budgetId:'explicit-new-batch'},
    artists:[{profile_id:'1'}],savedEvidenceOnly:true,liveLinkWrites:false,automaticRetries:0,
    requests:['one','two'].map(key=>({key,profileId:'1',kind:'jev',body:structuredClone(body),
      sha256:hash(JSON.stringify(body)),bytes:Buffer.byteLength(JSON.stringify(body))}))};
  const digest=hash(JSON.stringify(scope));
  const row={scope_sha256:digest,cap_cents:cap,reserved_cents:0,owner:null};
  const keys=new Set();let dispatches=0;
  const pool={connect:async()=>({release(){},query:async(sql,params)=>{
    assert.doesNotMatch(sql,/instagram_pilot_/);
    if(sql.startsWith('SELECT'))return {rows:[{...row}]};
    if(sql.includes('SET owner'))row.owner=params[1];
    if(sql.startsWith('INSERT')){
      if(keys.has(params[1]))throw Error('Duplicate admission');keys.add(params[1]);
    }
    if(sql.includes('reserved_cents=reserved_cents+2'))row.reserved_cents+=2;
    return {rows:[]};
  }})};
  const transport={live:true,dispatch:async()=>{dispatches++;return {cost:0.001,model:'fixed',answers:[]};}};
  return {scope,scopeSha256:digest,pool,transport,row,dispatches:()=>dispatches};
}
test('new authorization has an independent durable ceiling, exact scope, and non-replayable admissions',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-gate-')),f=fixture();
  let gate;
  try{
    gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
    f.scope.requests[0].body.state.artist='Mutated outside gate';
    await gate.request('one');assert.equal(f.dispatches(),1);assert.equal(f.row.reserved_cents,2);
    await assert.rejects(gate.request('one'),/Duplicate/);
    assert.equal(f.dispatches(),1);assert.equal(f.row.reserved_cents,2);
    await assert.rejects(gate.request('two'),/stopped/);
    await assert.rejects(openSavedBatchGate({...fixture(),pool:f.pool,journalPath:path.join(dir,'duplicate-process')}),/already claimed/);
  }finally{await gate?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('cap checks occur before dispatch and preserve uncertain reservations',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-gate-')),f=fixture();
  const gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
  try{
    f.row.reserved_cents=1998;await gate.request('one');assert.equal(f.row.reserved_cents,2000);
    await assert.rejects(gate.request('two'),/cap reached/);assert.equal(f.dispatches(),1);
  }finally{await gate.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('a separately approved 48-cent test cannot inherit a larger ceiling',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-small-gate-')),f=fixture(48);
  let gate;
  try{
    gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
    assert.equal(gate.snapshot().maximumSpendCents,48);
    f.row.reserved_cents=46;
    await gate.request('one');assert.equal(f.row.reserved_cents,48);
    await assert.rejects(gate.request('two'),/cap reached/);assert.equal(f.dispatches(),1);
    const changed=fixture(48);changed.row.cap_cents=2000;
    await assert.rejects(openSavedBatchGate({...changed,journalPath:path.join(dir,'changed-cap')}),/approval/);
    const insufficient=fixture(2);
    await assert.rejects(openSavedBatchGate({...insufficient,journalPath:path.join(dir,'too-small')}),/authorization/);
  }finally{await gate?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('provider failure fences later work, never refunds and never retries',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-gate-')),f=fixture();let calls=0;
  f.transport.dispatch=async()=>{calls++;throw Error('Unknown provider outcome');};
  const gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
  try{
    await assert.rejects(gate.request('one'),/Unknown provider/);await assert.rejects(gate.request('two'),/stopped/);
    assert.equal(calls,1);assert.equal(f.row.reserved_cents,2);
    const rows=(await fs.readFile(path.join(dir,'admissions'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].phase,'admitted');assert.equal(rows[1].phase,'stopped_no_retry');
  }finally{await gate.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('a slow response beyond the old 25-second deadline completes once within the two-minute window',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-slow-gate-')),f=fixture();
  t.mock.timers.enable({apis:['setTimeout']});
  let started;
  const dispatchStarted=new Promise(resolve=>{started=resolve;});
  let calls=0;
  f.transport.dispatch=async()=>{
    calls++;started();
    await new Promise(resolve=>setTimeout(resolve,60000));
    return {cost:0.001};
  };
  const gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
  try{
    assert.equal(SAVED_BATCH_REQUEST_TIMEOUT_MS,120000);
    const pending=gate.request('one');
    await dispatchStarted;
    t.mock.timers.tick(25001);
    assert.equal(gate.snapshot().stopped,false);
    t.mock.timers.tick(34999);
    await pending;
    assert.equal(calls,1);assert.equal(f.row.reserved_cents,2);
    assert.equal(gate.snapshot().returned,1);
    const rows=(await fs.readFile(path.join(dir,'admissions'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].timeoutMs,120000);
    assert.deepEqual(rows.map(r=>r.phase),['admitted','returned']);
  }finally{await gate.close();t.mock.timers.reset();await fs.rm(dir,{recursive:true,force:true});}
});
test('a genuinely hung request still aborts at two minutes, keeps its charge and cannot be replayed',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-hung-gate-')),f=fixture();
  t.mock.timers.enable({apis:['setTimeout']});
  let started,lateResponse,signal,calls=0;
  const dispatchStarted=new Promise(resolve=>{started=resolve;});
  f.transport.dispatch=request=>{
    calls++;signal=request.signal;started();
    return new Promise(resolve=>{lateResponse=resolve;});
  };
  const gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
  try{
    const pending=assert.rejects(gate.request('one'),/Timed-out request is uncertain; no retry/);
    await dispatchStarted;
    t.mock.timers.tick(119999);
    assert.equal(gate.snapshot().stopped,false);
    assert.equal(signal.aborted,false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(signal.aborted,true);
    assert.equal(f.row.reserved_cents,2);
    await assert.rejects(gate.request('two'),/stopped/);
    lateResponse({cost:0.001});
    await Promise.resolve();
    assert.equal(calls,1);
    assert.equal(gate.snapshot().returned,0);
    const rows=(await fs.readFile(path.join(dir,'admissions'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r=>r.phase),['admitted','stopped_no_retry']);
  }finally{await gate.close();t.mock.timers.reset();await fs.rm(dir,{recursive:true,force:true});}
});
test('tampered requests and unapproved scopes never claim a budget',async()=>{
  const f=fixture();f.scope.requests[0].body.state.artist='Changed';
  await assert.rejects(openSavedBatchGate({...f,journalPath:'/unused'}),/authorization/);
  const g=fixture();g.scope.authorization.approved=false;g.scopeSha256=hash(JSON.stringify(g.scope));
  await assert.rejects(openSavedBatchGate({...g,journalPath:'/unused'}),/authorization/);
  assert.equal(g.row.owner,null);
});
test('candidate fetches require explicit approval and a frozen artist-owned candidate scope',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-metadata-gate-')),f=fixture(48);
  const url='https://www.instagram.com/example_artist/';
  f.scope.savedEvidenceOnly=false;f.scope.candidateMetadataFetchesApproved=true;
  f.scope.artists[0].savedCandidateUrls=[url];
  f.scope.requests=f.scope.requests.map(r=>{const body={url};return {...r,kind:'scrapecreators_candidate',body,
    sha256:hash(JSON.stringify(body)),bytes:Buffer.byteLength(JSON.stringify(body))};});
  f.scopeSha256=hash(JSON.stringify(f.scope));f.row.scope_sha256=f.scopeSha256;
  f.transport.dispatch=async r=>{assert.equal(r.kind,'scrapecreators_candidate');return {cost:0.02};};
  let gate;
  try{
    const bad=structuredClone(f.scope);bad.candidateMetadataFetchesApproved=false;
    await assert.rejects(openSavedBatchGate({...f,scope:bad,scopeSha256:hash(JSON.stringify(bad)),journalPath:path.join(dir,'unapproved')}),/authorization/);
    const foreign=structuredClone(f.scope);foreign.artists[0].savedCandidateUrls=[];
    await assert.rejects(openSavedBatchGate({...f,scope:foreign,scopeSha256:hash(JSON.stringify(foreign)),journalPath:path.join(dir,'foreign')}),/Unbound/);
    gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'approved')});
    await gate.request('one');assert.equal(gate.snapshot().estimatedCostUsd,0.02);
    assert.equal(gate.snapshot().reportedCostUsd,undefined);
    await assert.rejects(gate.request('one'),/Duplicate/);
  }finally{await gate?.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('acknowledged verifier errors retain a reservation without inventing reported charges',async()=>{
  const f=fixture(48),dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-known-error-'));
  f.transport.dispatch=async()=>({cost:0.02,costBasis:'conservative_failed_verification_estimate',unavailable:true});
  const gate=await openSavedBatchGate({...f,journalPath:path.join(dir,'admissions')});
  try{
    await gate.request('one');
    assert.equal(gate.snapshot().reservedCents,2);assert.equal(gate.snapshot().estimatedCostUsd,0.02);
    assert.equal(gate.snapshot().reportedCostUsd,0);
  }finally{await gate.close();await fs.rm(dir,{recursive:true,force:true});}
});
