import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedTestOptions,approveBoundedTestPlan} from './youtube-bounded-test-plan.mjs';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
const artists=Array.from({length:20},(_,i)=>({profile_id:String(i+1),cm_artist:String(i+100),tier:2}));
const plan={id:'youtube-test-new-20',artists,scopeSha256:hash(artists),explicitApproval:false,
  approvalStatus:'awaiting_spending_approval',proposedCapCents:200,operationalCapCents:200,
  candidatesPerArtist:2,maxCalls:100,fullCampaignRemainsPaused:true,noAutomaticRetries:true,userCapCents:null};
const options={id:plan.id,capCents:200,approvedAt:'2026-11-11T23:30:00Z',expectedPlanSha256:hash(plan)};
test('new preparations require a separate safe ID and cannot reuse the archived pilot',()=>{
  assert.equal(boundedTestOptions(['--prepare-only','--test-id=youtube-test-new-20']).id,plan.id);
  for(const args of [
    ['--prepare-only'],['--prepare-only','--test-id=youtube-test-20-usd5-2026-11-11'],
    ['--test-id=../../escape'],['--test-id=youtube-test-one','--test-id=youtube-test-two'],
  ])assert.throws(()=>boundedTestOptions(args));
});
test('authorization binds the exact pending plan without mutating it or launching work',()=>{
  const before=JSON.stringify(plan),approved=approveBoundedTestPlan(plan,options);
  assert.equal(JSON.stringify(plan),before);assert.equal(plan.userCapCents,null);
  assert.equal(approved.planSha256,hash(plan));assert.equal(approved.explicitApproval,true);
  assert.equal(approved.userCapCents,200);assert.equal(approved.approvalStatus,'approved');
});
test('wrong cap, artist substitution, duplicate artists and prior approval fail closed',()=>{
  assert.throws(()=>approveBoundedTestPlan(plan,{...options,capCents:500}));
  for(const patch of [
    {artists:artists.slice(1)},{artists:artists.map(()=>artists[0])},
    {scopeSha256:'0'.repeat(64)},{explicitApproval:true},{fullCampaignRemainsPaused:false},
    {candidatesPerArtist:3},{maxCalls:101},{noAutomaticRetries:false},
  ]){
    const bad={...plan,...patch};
    assert.throws(()=>approveBoundedTestPlan(bad,{...options,expectedPlanSha256:hash(bad)}));
  }
  assert.throws(()=>approveBoundedTestPlan({...plan,artists:artists.slice(1)},options),/changed after review/);
});
