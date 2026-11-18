import test from 'node:test';
import assert from 'node:assert/strict';
import {select} from './instagram-artist-metadata-overlay.mjs';

test('typed catalog IDs are bound outside the SQL while readonly protections remain set', async () => {
  const oldFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (url,request)=>{
    calls++;
    assert.equal(url.searchParams.get('readonly'),'1');
    assert.equal(url.searchParams.get('max_execution_time'),'30');
    assert.deepEqual(JSON.parse(url.searchParams.get('param_ids')),[4012009,7006976]);
    assert.equal(request.body,'WITH scoped AS (SELECT {ids:Array(UInt32)} AS ids) SELECT ids FROM scoped FORMAT JSON');
    assert.equal(request.redirect,'error');
    return {ok:true,json:async()=>({data:[{test:true}]})};
  };
  try{
    assert.deepEqual(await select('WITH scoped AS (SELECT {ids:Array(UInt32)} AS ids) SELECT ids FROM scoped',
      {params:{ids:[4012009,7006976]}}),[{test:true}]);
    assert.equal(calls,1);
  }finally{globalThis.fetch=oldFetch;}
});

test('invalid UInt32 parameters or writes fail before any request', async () => {
  const oldFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('Unexpected network request');};
  try{
    for(const ids of [[-1],[4294967296],['4012009'],[1.2],Array(5001).fill(1)])
      await assert.rejects(()=>select('SELECT {ids:Array(UInt32)}',{params:{ids}}),/UInt32/);
    await assert.rejects(()=>select('SELECT 1',{params:{'ids&readonly=0':[1]}}),/UInt32/);
    await assert.rejects(()=>select('INSERT INTO catalog VALUES (1)'),/Read-only/);
    assert.equal(calls,0);
  }finally{globalThis.fetch=oldFetch;}
});

test('catalog errors preserve diagnostic codes without exposing response bodies or retrying', async () => {
  const oldFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    return {ok:false,status:500,text:async()=>
      'Code: 60. DB::Exception: private response context (UNKNOWN_TABLE)'};
  };
  try{
    await assert.rejects(()=>select('SELECT name FROM system.tables'),error=>
      error.httpStatus===500&&error.catalogCode==='60'&&error.catalogException==='UNKNOWN_TABLE'
        &&!error.message.includes('private response context'));
    assert.equal(calls,1);
  }finally{globalThis.fetch=oldFetch;}
});
