import test from 'node:test';
import assert from 'node:assert/strict';
import {retireStoppedMetadataBudget} from './instagram-stopped-batch-recovery.mjs';
function fixture(){
  const row={scope_sha256:'frozen',cap_cents:1000,reserved_cents:94},keys=Array.from({length:47},(_,i)=>'key-'+i);
  const pool={connect:async()=>({release(){},query:async sql=>{
    if(sql.includes('SELECT *'))return {rows:[{...row}]};
    if(sql.includes('SELECT admission_key'))return {rows:keys.map(admission_key=>({admission_key}))};
    if(sql.startsWith('UPDATE'))row.cap_cents=row.reserved_cents;
    return {rows:[]};
  }})};
  return {pool,row,args:{scope:{authorization:{maxSpendCents:1000,budgetId:'old'},candidateMetadataFetchesApproved:true},
    scopeSha256:'frozen',receipts:keys.map((key,i)=>({key,httpStatus:i===46?500:200}))}};
}
test('known completed HTTP failure can be skipped while old allocation is sealed and charges retained',async()=>{
  const f=fixture(),r=await retireStoppedMetadataBudget(f.pool,f.args);
  assert.equal(f.row.reserved_cents,94);assert.equal(f.row.cap_cents,94);assert.equal(r.remainingMetadataCents,906);
  assert.equal(r.retiredCeilingCents+r.remainingMetadataCents+1000,2000);
  await assert.rejects(retireStoppedMetadataBudget(f.pool,f.args));
});
test('unknown receipts, unmatched admissions, changed scope or extra reservations cannot authorize continuation',async()=>{
  for(const mutate of [f=>{f.args.receipts[0].httpStatus=undefined;},f=>{f.args.receipts.pop();},
    f=>{f.args.receipts[0].key='another-key';},f=>{f.row.scope_sha256='changed';},f=>{f.row.reserved_cents=96;}]){
    const f=fixture();mutate(f);await assert.rejects(retireStoppedMetadataBudget(f.pool,f.args));assert.equal(f.row.cap_cents,1000);
  }
});
test('explicitly abandoning an interrupted request retains its charge and prevents replay',async()=>{
  const f=fixture(),r=f.args.receipts[46];
  r.httpStatus=null;r.outcome='interrupted_never_retry';f.args.skipUncertainKeys=[r.key];
  const result=await retireStoppedMetadataBudget(f.pool,f.args);
  assert.equal(f.row.reserved_cents,94);assert.equal(f.row.cap_cents,94);
  assert.deepEqual(result.uncertainKeysPermanentlySkipped,[r.key]);assert.equal(result.remainingMetadataCents,906);
});
test('uncertain exclusions cannot cover a different key or disguise a completed receipt',async()=>{
  for(const mutate of [f=>{f.args.skipUncertainKeys=['not-admitted'];},
    f=>{f.args.skipUncertainKeys=['key-46'];},f=>{
      f.args.receipts[46].httpStatus=null;f.args.skipUncertainKeys=['key-46'];
    }]){
    const f=fixture();mutate(f);await assert.rejects(retireStoppedMetadataBudget(f.pool,f.args));assert.equal(f.row.cap_cents,1000);
  }
});
