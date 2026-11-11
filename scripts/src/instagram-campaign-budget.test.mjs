import test from 'node:test';
import assert from 'node:assert/strict';
import {nextCampaignAllocation,allocateCampaignChild,campaignTransaction} from './instagram-campaign-budget.mjs';

const claim={id:'campaign',scopeSha256:'frozen',capCents:10000,owner:'owner'};
function fixture(children=[],override={}){
  const calls=[];
  const c={release(){},async query(sql,args){
    calls.push({sql,args});
    if(sql.startsWith('SELECT * FROM instagram_campaign_budgets'))
      return {rows:[{id:claim.id,scope_sha256:claim.scopeSha256,cap_cents:claim.capCents,owner:claim.owner,...override}]};
    if(sql.startsWith('SELECT b.*'))return {rows:children};
    return {rows:[]};
  }};
  return {calls,pool:{connect:async()=>c}};
}
test('shared $100 cap counts all active child allocations, not just used reservations',()=>{
  const children=Array.from({length:5},(_,i)=>({id:String(i),cap_cents:2000,reserved_cents:1900}));
  assert.deepEqual(nextCampaignAllocation(10000,children),{allocatedCents:10000,reservedCents:9500,nextCapCents:0});
  assert.throws(()=>nextCampaignAllocation(10000,[...children,{id:'extra',cap_cents:2,reserved_cents:0}]));
});
test('unused funds become available only after an old child ceiling is durably retired',()=>{
  const retired=[{id:'first',cap_cents:1900,reserved_cents:1900}];
  assert.equal(nextCampaignAllocation(10000,retired).nextCapCents,2000);
  const nearlySpent=Array.from({length:5},(_,i)=>({id:String(i),cap_cents:1990,reserved_cents:1990}));
  assert.equal(nextCampaignAllocation(10000,nearlySpent).nextCapCents,50);
  assert.throws(()=>nextCampaignAllocation(10000,[{id:'bad',cap_cents:100,reserved_cents:102}]));
  assert.throws(()=>nextCampaignAllocation(10000,[...retired,...retired]));
});
test('child allocation locks the parent and atomically records both budget and parent binding',async()=>{
  const f=fixture();
  await allocateCampaignChild(f.pool,claim,{id:'campaign-chunk-001',scopeSha256:'child',capCents:2000});
  assert.ok(f.calls.find(x=>x.sql.includes('FOR UPDATE')));
  assert.equal(f.calls.filter(x=>x.sql.startsWith('INSERT')).length,2);
  assert.equal(f.calls.at(-1).sql,'COMMIT');
});
test('exhausted parent, foreign owner, changed approval or foreign child never allocates',async()=>{
  for(const overrides of [{owner:'other'},{scope_sha256:'changed'},{cap_cents:9999}]){
    const f=fixture([],overrides);
    await assert.rejects(campaignTransaction(f.pool,claim,async()=>{}));
    assert.equal(f.calls.at(-1).sql,'ROLLBACK');
  }
  const f=fixture(Array.from({length:5},(_,i)=>({id:String(i),cap_cents:2000,reserved_cents:0})));
  await assert.rejects(allocateCampaignChild(f.pool,claim,{id:'campaign-chunk-006',scopeSha256:'child',capCents:2}));
  assert.equal(f.calls.filter(x=>x.sql.startsWith('INSERT')).length,0);
  await assert.rejects(allocateCampaignChild(f.pool,claim,{id:'foreign',scopeSha256:'child',capCents:2}));
});
