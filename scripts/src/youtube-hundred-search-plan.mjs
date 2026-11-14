// A fresh aggregate authorization of five unchanged exact-twenty search stages.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateStagedSearchPlan} from './youtube-staged-search-plan.mjs';
export const HUNDRED_SEARCH_POLICY='five-exact-twenty-search-cohorts-v1';
export function freshHundredArtists(rows,history,now=Date.now()){
  const ids=new Set(history.map(r=>String(r.profile_id))),cms=new Set(history.map(r=>String(r.cm_artist)));
  const seenIds=new Set(),seenCms=new Set(),tiers=new Map([1,2,3,4,5].map(t=>[t,[]]));
  for(const r of [...rows].sort((a,b)=>Number(a.tier)-Number(b.tier)||Number(a.tier_rank)-Number(b.tier_rank)
    ||String(a.profile_id).localeCompare(String(b.profile_id)))){
    assert.match(r.profile_id,/^\d+$/);assert.match(r.cm_artist,/^\d+$/);
    const tier=Number(r.tier),ordinal=Number(r.tier_rank);
    assert.ok(tiers.has(tier)&&Number.isInteger(ordinal)&&ordinal>=0);
    const age=now-Date.parse(r.snapshot_at.replace(' ','T')+'Z');
    assert.ok(Number.isFinite(age)&&age>=0&&age<=36*3600000,'Stale global tier snapshot');
    if(ids.has(r.profile_id)||cms.has(r.cm_artist)||seenIds.has(r.profile_id)||seenCms.has(r.cm_artist))continue;
    seenIds.add(r.profile_id);seenCms.add(r.cm_artist);
    tiers.get(tier).push({...r,tier,ordinal});
  }
  const selected=[];
  while(selected.length<100){
    let added=0;
    for(const tier of [1,2,3,4,5]){
      if(selected.length===100)break;
      const a=tiers.get(tier).shift();if(a){selected.push(a);added++;}
    }
    assert.ok(added,'Fewer than 100 fresh eligible artists; never fill with previous attempts');
  }
  return selected.sort((a,b)=>a.tier-b.tier||a.ordinal-b.ordinal);
}
export function hundredSearchPlan(input){
  assert.match(input.id,/^youtube-batch-100-[a-z0-9-]{4,70}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.equal(input.children.length,5);
  const artists=[],children=input.children.map(child=>{
    const p=validateStagedSearchPlan(child.plan);
    assert.match(child.id,/^youtube-test-[a-z0-9-]{4,100}$/);assert.equal(p.id,child.id);
    assert.equal(p.operationalCapCents,40);assert.equal(p.operations.length,20);
    assert.equal(p.explicitApproval,false);assert.deepEqual(p.allowedKinds,['search']);
    artists.push(...p.artists);
    return {id:p.id,plan:structuredClone(p),planSha256:digest(p),capCents:40};
  });
  assert.equal(new Set(children.map(c=>c.id)).size,5);
  assert.equal(new Set(artists.map(a=>a.profile_id)).size,100);
  assert.equal(new Set(artists.map(a=>a.cm_artist)).size,100);
  assert.ok(artists.every((a,i)=>!i||artists[i-1].tier<a.tier
    ||artists[i-1].tier===a.tier&&artists[i-1].ordinal<=a.ordinal));
  assert.ok(Object.keys(input.runtimeFiles??{}).length);
  for(const [name,hash] of Object.entries(input.runtimeFiles)){
    assert.match(name,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(hash,/^[a-f0-9]{64}$/);
  }
  return {version:HUNDRED_SEARCH_POLICY,id:input.id,preparedAt:input.preparedAt,children,
    artists,scopeSha256:digest(artists),runtimeFiles:structuredClone(input.runtimeFiles),
    totalArtists:100,maximumCalls:100,maximumSpendCents:200,
    tiers:Object.fromEntries([1,2,3,4,5].map(t=>[t,artists.filter(a=>a.tier===t).length])),
    allowedKinds:['search'],noRetries:true,noCatalogWrites:true,fullCampaignRemainsPaused:true,
    sequentialChildren:true,stopOnChildFailure:true,explicitApproval:false,
    unknownDownstreamRequestsApproved:false,
    note:'Only these 100 searches. Keep stricter channel matching, labeled Topic leads and one artist/channel row in later stages. Uploader, channel and identity stages require separate exact approvals.'};
}
export function approveHundredSearch(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(hundredSearchPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,200);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:HUNDRED_SEARCH_POLICY,planSha256,capCents,approvedAt,
    childScopeSha256:digest(plan.children.map(c=>({id:c.id,planSha256:c.planSha256,capCents:c.capCents}))),
    explicitApproval:true,scope:'only_five_exact_twenty_search_stages_no_downstream_authority'};
}
