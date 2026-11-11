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
