import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBoundedYoutubeAdmission as check} from './youtube-bounded-test-gate.mjs';
const scope={scopeSha256:'scope',operationalCapCents:200,userCapCents:500,artists:[{profile_id:'1'}]};
const run={owner:'owner',status:'running',scope_sha256:'scope',cap_cents:200,reserved_cents:0};
const op={profileId:'1',kind:'search',key:'search-1-0',inputSha256:'a'.repeat(64)};
test('bounded test can use a smaller allowance but never exceed either limit',()=>{
  check(run,scope,op,0,'owner');
  check({...run,reserved_cents:198},scope,op,0,'owner');
  assert.throws(()=>check({...run,reserved_cents:200},scope,op,0,'owner'),/allowance/);
  assert.throws(()=>check({...run,cap_cents:500}, {...scope,operationalCapCents:500},op,0,'owner'));
  assert.throws(()=>check(run,{...scope,userCapCents:100},op,0,'owner'));
});
test('owner, scope, paused run, unreturned requests and unknown artists are fences',()=>{
  for(const change of [{owner:'other'},{status:'stopped'},{scope_sha256:'other'}])
    assert.throws(()=>check({...run,...change},scope,op,0,'owner'));
  assert.throws(()=>check(run,scope,op,1,'owner'),/Uncertain/);
  assert.throws(()=>check(run,scope,{...op,profileId:'2'},0,'owner'),/outside/);
});
test('exact request hashes and artist/kind-bound operation keys are required',()=>{
  for(const change of [{inputSha256:'wrong'},{kind:'video'},{key:'search-2-0'}])
    assert.throws(()=>check(run,scope,{...op,...change},0,'owner'));
  for(const kind of ['search','metadata','model'])
    check(run,scope,{...op,kind,key:kind+'-1-hash'},0,'owner');
});
test('100-artist gate enforces the separately approved $10 ceiling and preserves fences',()=>{
  const large={...scope,artists:Array.from({length:100},(_,i)=>({profile_id:String(i+1)})),
    operationalCapCents:1000,userCapCents:1000,proposedCapCents:1000,maxCalls:500,
    explicitApproval:true,approvalStatus:'approved'};
  const r={...run,cap_cents:1000,reserved_cents:998};
  check(r,large,op,0,'owner');
  assert.throws(()=>check({...r,reserved_cents:1000},large,op,0,'owner'),/allowance/);
  for(const patch of [{explicitApproval:false},{maxCalls:501},{userCapCents:200},{artists:large.artists.slice(1)}])
    assert.throws(()=>check(r,{...large,...patch},op,0,'owner'));
  assert.throws(()=>check(r,large,op,1,'owner'),/Uncertain/);
  assert.throws(()=>check(r,large,{...op,kind:'video'},0,'owner'));
});
