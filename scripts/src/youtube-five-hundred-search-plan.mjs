// Aggregate five unchanged hundred-artist bundles. No legacy caps are widened.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {hundredSearchPlan} from './youtube-hundred-search-plan.mjs';

export function fiveHundredSearchPlan(input){
  assert.match(input.id,/^youtube-batch-500-[a-z0-9-]{4,70}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.equal(input.children.length,5);
  const children=input.children.map(c=>{
    const plan=hundredSearchPlan(c.plan);
    assert.deepEqual(plan,c.plan);assert.equal(c.id,plan.id);
    return {id:plan.id,plan:structuredClone(plan),planSha256:digest(plan),capCents:200};
  });
  const artists=children.flatMap(c=>c.plan.artists);
  assert.equal(new Set(children.map(c=>c.id)).size,5);
  assert.equal(new Set(children.flatMap(c=>c.plan.children.map(p=>p.id))).size,25);
  for(const key of ['profile_id','cm_artist'])assert.equal(new Set(artists.map(a=>a[key])).size,500,
    'Duplicate '+key+' across search bundles');
  assert.ok(Object.keys(input.runtimeFiles??{}).length);
  for(const [name,sha] of Object.entries(input.runtimeFiles)){
    assert.match(name,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return {version:'five-exact-hundred-search-bundles-v1',id:input.id,preparedAt:input.preparedAt,
    children,scopeSha256:digest(artists),runtimeFiles:structuredClone(input.runtimeFiles),
    totalArtists:500,maximumCalls:500,maximumSpendCents:1000,
    tiers:Object.fromEntries([1,2,3,4,5].map(t=>[t,artists.filter(a=>a.tier===t).length])),
    allowedKinds:['search'],sequentialChildren:true,stopOnChildFailure:true,noRetries:true,
    noCatalogWrites:true,fullCampaignRemainsPaused:true,explicitApproval:false,
    unknownDownstreamRequestsApproved:false,
    note:'Only these 500 searches. Channel captures, uploader checks and artist verification require separate approval.'};
}
export function approveFiveHundredSearch(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(fiveHundredSearchPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,1000);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    childScopeSha256:digest(plan.children.map(c=>({id:c.id,planSha256:c.planSha256,capCents:c.capCents}))),
    scope:'only_five_exact_hundred_search_bundles_no_downstream_authority'};
}
