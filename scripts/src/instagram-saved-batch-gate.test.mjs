import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSavedBatchGate} from './instagram-saved-batch-gate.mjs';
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
test('tampered requests and unapproved scopes never claim a budget',async()=>{
  const f=fixture();f.scope.requests[0].body.state.artist='Changed';
  await assert.rejects(openSavedBatchGate({...f,journalPath:'/unused'}),/authorization/);
  const g=fixture();g.scope.authorization.approved=false;g.scopeSha256=hash(JSON.stringify(g.scope));
  await assert.rejects(openSavedBatchGate({...g,journalPath:'/unused'}),/authorization/);
  assert.equal(g.row.owner,null);
});
