// Pending preparation is deliberately not paid-work authorization.
import assert from 'node:assert/strict';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
export function boundedTestSize(plan){
  const count=plan.artists.length;
  assert.ok(count===20||count===100,'Only reviewed 20- or 100-artist runs are supported');
  const capCents=count===100?1000:200;
  assert.equal(plan.proposedCapCents,capCents);
  assert.equal(plan.operationalCapCents,capCents);
  assert.equal(plan.maxCalls,count*5);
  return {count,capCents};
}
export function boundedTestOptions(args){
  const ids=args.filter(a=>a.startsWith('--test-id='));
  assert.ok(ids.length<=1,'Duplicate test ID');
  const id=ids.length?ids[0].slice('--test-id='.length):'youtube-test-20-usd5-2026-11-11';
  assert.match(id,/^youtube-test-[a-z0-9][a-z0-9-]{3,100}$/,'Unsafe test ID');
  if(args.includes('--prepare-only')){
    assert.equal(ids.length,1,'A fresh test requires its own explicit ID');
    assert.notEqual(id,'youtube-test-20-usd5-2026-11-11','Never overwrite the historical test');
  }
  return {id,root:'generated-artifacts/'+id};
}
export function approveBoundedTestPlan(plan,{id,capCents,approvedAt,expectedPlanSha256}){
  assert.match(expectedPlanSha256??'',/^[a-f0-9]{64}$/);
  assert.equal(hash(plan),expectedPlanSha256,'Prepared plan changed after review');
  assert.equal(plan.id,id);assert.equal(plan.explicitApproval,false);
  assert.equal(plan.approvalStatus,'awaiting_spending_approval');
  const size=boundedTestSize(plan);
  assert.equal(capCents,size.capCents,'Only the exact proposed cap can authorize this plan');
  assert.equal(new Set(plan.artists.map(a=>a.profile_id)).size,size.count);
  assert.equal(hash(plan.artists),plan.scopeSha256);
  assert.equal(plan.candidatesPerArtist,2);
  assert.equal(plan.fullCampaignRemainsPaused,true);assert.equal(plan.noAutomaticRetries,true);
  return {...plan,planSha256:hash(plan),userCapCents:capCents,explicitApproval:true,
    approvalStatus:'approved',approvedAt,approvedBy:`User explicitly approved this fresh ${size.count}-artist run with a $${capCents/100} cap.`};
}
