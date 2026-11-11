import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateQueue,assertAdmission,campaignTransport,classifyYoutubeResult,validateRequest,MODEL_PLAN} from './youtube-campaign-core.mjs';
import {eligibilitySql} from './run-youtube-campaign.mjs';

test('continuous scope removes sample limit and remains global-tier, missing catalog YouTube only',()=>{
  const q=eligibilitySql(['123','456']);
  assert.ok(!q.includes('LIMIT 4 BY'));
  assert.ok(q.includes("grain='global'"));
  assert.ok(q.includes("lower(a.platform)='youtube'"));
  assert.ok(q.includes('p.id IN (123,456)'));
  assert.ok(!q.includes("'instagram'"));
  assert.throws(()=>eligibilitySql(['1) OR true']));
});
test('queue rejects duplicates, outside tiers, nonnumeric IDs and incorrect priority',()=>{
  const a={profile_id:'1',cm_artist:'2',artist:'One',tier:1};
  validateQueue([a,{...a,profile_id:'3',tier:5}]);
  assert.throws(()=>validateQueue([a,a]));
  assert.throws(()=>validateQueue([{...a,tier:6}]));
  assert.throws(()=>validateQueue([{...a,profile_id:'bad'}]));
  assert.throws(()=>validateQueue([{...a,tier:5},{...a,profile_id:'3',tier:2}]));
});
test('admission checks owner, frozen authorization and unresolved admissions without a spending cap',()=>{
  const c={owner:'a',status:'running',maximum_spend_cents:null,scope_sha256:'s',approval_sha256:'h'};
  const a={profile_id:'1',status:'in_progress'},context={owner:'a',scopeHash:'s',approvalHash:'h',profileId:'1'};
  assertAdmission(c,a,0,context);
  for(const change of [{owner:'b'},{status:'stopped'},{maximum_spend_cents:10000},{scope_sha256:'other'},{approval_sha256:'other'}])
    assert.throws(()=>assertAdmission({...c,...change},a,0,context));
  assert.throws(()=>assertAdmission(c,a,1,context));
  assert.throws(()=>assertAdmission(c,{...a,status:'completed'},0,context));
});
test('no-match is completed search, not an ownership check, and uncertain answers are not rejected by score',()=>{
  assert.deepEqual(classifyYoutubeResult({searchStatus:'no_match',candidates:[]}),{searched:true,checked:false,likely:false,candidates:0});
  const stats=classifyYoutubeResult({searchStatus:'candidates_found',candidates:[{decision:{status:'likely_artist_owned',score:.3,reviewSuggestion:true}}]});
  assert.equal(stats.likely,true);assert.equal(stats.checked,true);
  assert.equal(classifyYoutubeResult({searchStatus:'candidates_found',candidates:[{decision:{status:'needs_channel_metadata'}}]}).checked,false);
});
test('64 KB model bound preserves full prepared evidence without accepting arbitrary endpoints',()=>{
  const req={method:'POST',url:MODEL_PLAN.model.endpoint,body:{model:MODEL_PLAN.model.expectedModel,state:'x'.repeat(8000)}};
  validateRequest('model',req);
  assert.throws(()=>validateRequest('model',{...req,url:'https://example.org'}));
  assert.throws(()=>validateRequest('model',{...req,body:{...req.body,state:'x'.repeat(65000)}}));
});
async function harness(t,fetchImpl,timeoutMs=1000){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-campaign-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/receipts');
  const admitted=new Set(),returned=[];
  const request=campaignTransport({root,timeoutMs,fetchImpl,credentials:{serper:'fixture-only'},
    assertFrozen:async()=>{},
    admit:async op=>{assert.ok(!admitted.has(op.key)&&admitted.size===returned.length);admitted.add(op.key);},
    returned:async op=>returned.push(op.key)});
  const spec={method:'POST',url:'https://google.serper.dev/search',body:{q:'Artist artist official YouTube channel',num:10}};
  return {root,admitted,returned,request,spec};
}
test('paid receipt is archived and bound before being marked returned; duplicate dispatch is blocked',async t=>{
  let calls=0;const h=await harness(t,async()=>{calls++;return new Response(JSON.stringify({organic:[]}),{status:200});});
  const p=await h.request('1','search','search-1',h.spec);
  assert.equal(p.status,200);assert.equal(h.returned.length,1);
  assert.equal((await fs.readdir(h.root+'/receipts')).length,1);
  await assert.rejects(()=>h.request('1','search','search-1',h.spec));
  assert.equal(calls,1);
});
test('timeout remains an uncertain admission, stops subsequent dispatch and ignores late response',async t=>{
  let release,calls=0;const h=await harness(t,()=>{calls++;return new Promise(resolve=>release=resolve);},10);
  await assert.rejects(()=>h.request('1','search','search-1',h.spec),/timeout/);
  await assert.rejects(()=>h.request('2','search','search-2',h.spec));
  release(new Response(JSON.stringify({organic:[]}),{status:200}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,1);assert.equal(h.returned.length,0);
  assert.equal((await fs.readdir(h.root+'/receipts')).length,0);
});
test('funding response retains charged receipt and stops without retry',async t=>{
  let calls=0;const h=await harness(t,async()=>{calls++;return new Response('{"error":"Insufficient credits"}',{status:402});});
  await assert.rejects(()=>h.request('1','search','search-1',h.spec),/funding/);
  assert.equal(calls,1);assert.equal(h.returned.length,1);
});
