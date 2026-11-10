import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
function reconciliationFixture(){
  const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const historicalAdmissions=Array.from({length:3},(_,i)=>({phase:'admitted',key:'meta-'+i,
    profileId:String(i),reservedCents:2,at:'2026-11-10T05:00:00.000Z'}));
  const scope={authorization:{maxSpendCents:20,budgetId:'test-only'},candidateMetadataFetchesApproved:true,
    requests:historicalAdmissions.map(a=>({key:a.key,profileId:a.profileId,kind:'scrapecreators_candidate',
      body:{url:'https://www.instagram.com/test'+a.profileId+'/'},sha256:hash({url:'https://www.instagram.com/test'+a.profileId+'/'})}))};
  const state={budget:{scope_sha256:hash(scope),cap_cents:20,reserved_cents:2},
    admissions:[{admission_key:'meta-0',profile_id:'0',cents:2}]};
  let snapshot;
  const pool={connect:async()=>({release(){},query:async(sql,p)=>{
    if(sql==='BEGIN')snapshot=structuredClone(state);
    if(sql==='ROLLBACK')Object.assign(state,snapshot);
    if(sql.includes('SELECT *'))return {rows:[{...state.budget}]};
    if(sql.includes('SELECT admission_key'))return {rows:structuredClone(state.admissions)};
    if(sql.startsWith('INSERT'))state.admissions.push({admission_key:p[1],profile_id:p[2],cents:p[3]});
    if(sql.includes('SET reserved_cents=$2'))state.budget.reserved_cents=p[1];
    if(sql.includes('SET cap_cents=reserved_cents'))state.budget.cap_cents=state.budget.reserved_cents;
    return {rows:[]};
  }})};
  return {pool,state,args:{scope,scopeSha256:hash(scope),
    receipts:[{key:'meta-0',httpStatus:200},{key:'meta-1',httpStatus:200},
      {key:'meta-2',httpStatus:null,outcome:'interrupted_never_retry'}],skipUncertainKeys:['meta-2'],
    approvedReconciliation:{approved:true,expectedReservedCents:2,historicalAdmissions,missingKeys:['meta-1','meta-2']}}};
}
test('approved exact historical backfill atomically charges missing and uncertain requests and retires scope',async()=>{
  const f=reconciliationFixture(),r=await retireStoppedMetadataBudget(f.pool,f.args);
  assert.equal(f.state.budget.reserved_cents,6);assert.equal(f.state.budget.cap_cents,6);
  assert.equal(f.state.admissions.length,3);assert.equal(r.remainingMetadataCents,14);
  assert.deepEqual(r.reconciledHistoricalKeys,['meta-1','meta-2']);
  assert.deepEqual(r.uncertainKeysPermanentlySkipped,['meta-2']);
  await assert.rejects(retireStoppedMetadataBudget(f.pool,f.args));
});
test('reconciliation refuses changed counts, keys, approval, scope or identity without altering ledger',async()=>{
  for(const mutate of [
    f=>{f.args.approvedReconciliation.approved=false;},
    f=>{f.args.approvedReconciliation.missingKeys=['meta-0','meta-2'];},
    f=>{f.state.budget.reserved_cents=4;},
    f=>{f.state.admissions[0].profile_id='wrong';},
    f=>{f.args.approvedReconciliation.historicalAdmissions[1].profileId='wrong';},
    f=>{f.args.scope.requests[0].body.url='changed';},
    f=>{f.state.admissions.push({admission_key:'unexpected',profile_id:'8',cents:2});}
  ]){
    const f=reconciliationFixture();mutate(f);const before=structuredClone(f.state);
    await assert.rejects(retireStoppedMetadataBudget(f.pool,f.args));assert.deepEqual(f.state,before);
  }
});
