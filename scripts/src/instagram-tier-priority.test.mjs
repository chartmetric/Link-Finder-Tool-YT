import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {priorityOrder,legacyCounts,validatePriorityAdmission,priorityTransport,normalizeSavedInstagram} from './instagram-tier-priority-core.mjs';
import {instagramPriorityEligibility} from './run-instagram-tier-priority.mjs';

test('tier comes before saved-candidate availability and preserves identities',()=>{
  const rows=[
    {profile_id:'3',tier:3,tier_rank:1,has_saved_candidate:1},
    {profile_id:'2',tier:2,tier_rank:5,has_saved_candidate:1},
    {profile_id:'1',tier:1,tier_rank:10,has_saved_candidate:0},
    {profile_id:'4',tier:2,tier_rank:1,has_saved_candidate:0},
  ];
  assert.deepEqual(priorityOrder(rows).map(r=>r.profile_id),['1','4','2','3']);
  assert.equal(rows[0].profile_id,'3');
});
test('global eligibility is bounded to selected artists missing catalog Instagram, not YouTube',()=>{
  const q=instagramPriorityEligibility(['1','2']);
  assert.ok(q.includes("grain='global'"));assert.ok(q.includes("lower(a.platform)='instagram'"));
  assert.ok(q.includes('p.id IN (1,2)'));assert.ok(!q.includes('LIMIT 4 BY'));
  assert.throws(()=>instagramPriorityEligibility(['1) OR 1=1']));
});
test('baseline counts only terminal checkpoints, preserving unavailable evidence as incomplete',()=>{
  assert.equal(legacyCounts({candidates:[{status:'uninspected'}]}).processed,false);
  assert.deepEqual(legacyCounts({candidates:[{recordedAnswer:{verdict:'likely'},review:{reviewSuggestion:true}}]}),
    {processed:true,checked:true,likely:true});
  assert.deepEqual(legacyCounts({candidates:[{status:'unavailable'}]}),{processed:true,checked:false,likely:false});
});
test('transactional admission refuses lower tiers, stale owners, changed scope and uncertain prior requests',()=>{
  const p={owner:'o',status:'running',scope_sha256:'s',approval_sha256:'a',maximum_spend_cents:null};
  const artist={profile_id:'1',status:'in_progress'};
  const input={owner:'o',scopeHash:'s',approvalHash:'a',profileId:'1',lowerTier:0};
  validatePriorityAdmission(p,artist,0,input);
  assert.throws(()=>validatePriorityAdmission(p,artist,0,{...input,lowerTier:1}));
  assert.throws(()=>validatePriorityAdmission(p,artist,1,input));
  assert.throws(()=>validatePriorityAdmission({...p,owner:'other'},artist,0,input));
  assert.throws(()=>validatePriorityAdmission({...p,scope_sha256:'other'},artist,0,input));
});
async function harness(t,fetchImpl,timeoutMs=100){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ig-priority-'));await fs.mkdir(root+'/receipts');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sent=new Set(),returns=[];
  const request=priorityTransport({root,fetchImpl,timeoutMs,assertFrozen:async()=>{},credentials:{serper:'fixture'},
    admit:async op=>{assert.equal(sent.size,returns.length);assert.ok(!sent.has(op.key));sent.add(op.key);},
    returned:async op=>returns.push(op.key)});
  const spec={method:'POST',url:'https://google.serper.dev/search',body:{q:'"Artist" musician Instagram site:instagram.com',num:10}};
  return {root,request,spec,sent,returns};
}
test('exact returned receipts are saved before completion, and the same operation never dispatches twice',async t=>{
  let calls=0;const h=await harness(t,async()=>{calls++;return new Response('{"organic":[]}');});
  const p=await h.request('1','search','search-1',h.spec);assert.equal(p.status,200);
  assert.equal((await fs.readdir(h.root+'/receipts')).length,1);
  await assert.rejects(()=>h.request('1','search','search-1',h.spec));assert.equal(calls,1);
});
test('timeout retains uncertainty, blocks the next request and never saves a late response as returned',async t=>{
  let release,calls=0;const h=await harness(t,()=>{calls++;return new Promise(resolve=>release=resolve);},5);
  await assert.rejects(()=>h.request('1','search','search-1',h.spec),/timeout/);
  await assert.rejects(()=>h.request('2','search','search-2',h.spec));
  release(new Response('{"organic":[]}'));await new Promise(r=>setTimeout(r,10));
  assert.equal(calls,1);assert.equal(h.returns.length,0);
});
test('acknowledged server errors keep a charged receipt; funding failures stop',async t=>{
  const h=await harness(t,async()=>new Response('{"error":"server unavailable"}',{status:500}));
  const packet=await h.request('1','search','search-1',h.spec);assert.equal(packet.status,500);assert.equal(h.returns.length,1);
  const funding=await harness(t,async()=>new Response('{"error":"Insufficient credits"}',{status:402}));
  await assert.rejects(()=>funding.request('1','search','search-1',funding.spec),/funding/);
  assert.equal(funding.returns.length,1);
});
test('saved channel metadata is normalized without another network request, including resource restrictions',async t=>{
  const h=await harness(t,async()=>{throw Error('No network permitted');});
  const url='https://www.instagram.com/example/';
  const packet={kind:'metadata',status:404,request:{url:'https://api.scrapecreators.com/v1/instagram/profile?handle=example'},
    data:{success:true,error:'not_found',errorStatus:404,message:'Profile is restricted',handle:'example'}};
  const result=await normalizeSavedInstagram(packet,url,h.root,'normalization');
  assert.equal(result.available,false);
  assert.equal(result.reason,'confirmed_restricted_profile_not_retried');
  assert.equal(h.sent.size,0);
  await assert.rejects(()=>normalizeSavedInstagram(packet,'https://www.instagram.com/other/',h.root,'other'));
});
