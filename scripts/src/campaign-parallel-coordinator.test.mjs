import test from 'node:test';
import assert from 'node:assert/strict';
import {COORDINATOR_OPTIONS,coordinatorTransactions} from './campaign-parallel-coordinator.mjs';

test('coordinator capacity is bounded and does not change the old shared pool',()=>{
  assert.equal(COORDINATOR_OPTIONS.max,8);
  assert.equal(COORDINATOR_OPTIONS.connectionTimeoutMillis,60000);
  assert.equal(Object.isFrozen(COORDINATOR_OPTIONS),true);
});
test('128 workers wait outside the connection pool and retain FIFO order',async()=>{
  let active=0,peak=0,released=0;
  const order=[];
  const pool={connect:async()=>{
    active++;peak=Math.max(peak,active);
    return {query:async()=>{},release:()=>{active--;released++;}};
  }};
  const tx=coordinatorTransactions(pool);
  const values=await Promise.all(Array.from({length:128},(_,i)=>tx(async()=>{
    await new Promise(r=>setImmediate(r));order.push(i);return i;
  })));
  assert.equal(peak,1);
  assert.equal(released,128);
  assert.deepEqual(values,Array.from({length:128},(_,i)=>i));
  assert.deepEqual(order,values);
});
test('transaction failure rolls back and releases without poisoning the drain queue',async()=>{
  const queries=[];let released=0;
  const tx=coordinatorTransactions({connect:async()=>({
    query:async sql=>{queries.push(sql);},release:()=>released++,
  })});
  const failed=tx(async()=>{throw Error('closed dispatch gate');});
  const drained=tx(async()=> 'saved existing receipt');
  await assert.rejects(failed,/closed dispatch gate/);
  assert.equal(await drained,'saved existing receipt');
  assert.equal(released,2);
  assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.filter(x=>x==='COMMIT').length,1);
});
test('connection acquisition failure rejects safely but later drain work can proceed',async()=>{
  let attempts=0,released=0;
  const tx=coordinatorTransactions({connect:async()=>{
    if(++attempts===1)throw Error('connection unavailable');
    return {query:async()=>{},release:()=>released++};
  }});
  const failed=tx(async()=>assert.fail('must not execute'));
  const next=tx(async()=>42);
  await assert.rejects(failed,/connection unavailable/);
  assert.equal(await next,42);assert.equal(released,1);
});
test('queue limits reject excess work before acquiring a connection',async()=>{
  let release,connections=0;
  const block=new Promise(resolve=>{release=resolve;});
  const tx=coordinatorTransactions({connect:async()=>{
    connections++;
    return {query:async()=>{},release:()=>{}};
  }},{maximumPending:1});
  const first=tx(async()=>{await block;});
  await assert.rejects(tx(async()=>assert.fail()),/queue capacity/);
  release();await first;assert.equal(connections,1);
});
