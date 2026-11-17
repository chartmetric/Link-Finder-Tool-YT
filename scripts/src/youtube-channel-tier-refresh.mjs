import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {errorContinuationPlan,approveErrorContinuation} from './youtube-channel-error-continuation.mjs';
import {immutableValidationCache} from './youtube-immutable-validation-cache.mjs';
import {assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';

export function refreshTierSelections(selections,rows,now){
  assert.equal(new Set(selections.map(s=>s.profileId)).size,selections.length);
  assert.equal(rows.length,selections.length);
  const refreshed=selections.map(s=>{
    const matches=rows.filter(r=>String(r.profile_id)===s.profileId);
    assert.equal(matches.length,1);
    const r=matches[0];
    assert.equal(String(r.cm_artist),s.cmArtist);
    assert.equal(r.artist,s.artist);
    assert.ok(Number.isInteger(Number(r.tier))&&Number(r.tier)>=1&&Number(r.tier)<=5);
    return {...s,tier:Number(r.tier)};
  });
  assertCurrentIdentityEligibility(refreshed,rows,now);
  return refreshed;
}
export function tierRefreshScope(original,operations,rows,now){
  assert.ok(rows.every(r=>original.some(s=>s.profileId===String(r.profile_id))));
  const eligible=original.filter(s=>rows.some(r=>String(r.profile_id)===s.profileId));
  const deferred=original.filter(s=>!eligible.includes(s));
  assert.ok(eligible.length>0);
  const selections=refreshTierSelections(eligible,rows,now);
  const pending=operations.filter(o=>selections.some(s=>s.profileId===o.profileId));
  assert.equal(pending.length,selections.length);
  assert.equal(new Set(pending.map(o=>o.profileId)).size,pending.length);
  for(const o of pending)assert.ok(selections.some(s=>s.profileId===o.profileId&&s.cmArtist===o.cmArtist));
  return {selections,pending,deferred};
}
export const tierRefreshPlan=immutableValidationCache(function(input){
  const p=input.sourcePlan;
  assert.deepEqual(errorContinuationPlan(p),p);
  assert.deepEqual(approveErrorContinuation(p,input.sourceApproval),input.sourceApproval);
  assert.match(input.id,/^youtube-channel-tier-refresh-[a-z0-9-]{4,60}$/);
  const now=Date.parse(input.preparedAt);assert.ok(Number.isFinite(now));
  const original=p.groups.flatMap(g=>g.selections);
  const {selections,pending,deferred}=tierRefreshScope(original,p.groups.flatMap(g=>g.operations),input.currentRows,now);
  const groups=[];
  for(let at=0;at<pending.length;at+=20){
    const operations=pending.slice(at,at+20);
    groups.push({...p.groups[0],id:input.id+'-part-'+(groups.length+1),groupIndex:groups.length,
      version:'exact-channel-tier-refresh-v1',runtimeFiles:input.runtimeFiles,operations,
      maximumCalls:operations.length,maximumSpendCents:operations.length*2,
      selections:selections.filter(s=>operations.some(o=>o.profileId===s.profileId))});
  }
  for(const [file,sha] of Object.entries(input.sourceFiles)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);
    assert.ok(!file.split('/').includes('..'));assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.ok(Object.keys(input.runtimeFiles).length);
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  const root='generated-artifacts/'+p.id;
  for(const f of ['plan.json','approval.json','run-started.json','error-acknowledgment.json'])
    assert.match(input.sourceFiles[root+'/'+f]??'',/^[a-f0-9]{64}$/);
  return {version:'exact-channel-tier-refresh-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlan:p,sourceApproval:input.sourceApproval,currentRows:input.currentRows,deferred,
    sourceFiles:input.sourceFiles,runtimeFiles:input.runtimeFiles,groups,
    priorReservedCents:p.priorReservedCents,maximumCalls:pending.length,
    maximumSpendCents:pending.length*2,combinedCapCents:p.combinedCapCents,
    scope:'Only refresh current Tier 1–5 classifications for the same untouched channel requests; no recovery, retries, substitutions or ownership acceptance',
    explicitApproval:false,executionEnabled:false,noRetries:true,noCatalogWrites:true,modelCalls:0,uploaderCalls:0};
});
export function approveTierRefresh(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(tierRefreshPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,planSha256,capCents,approvedAt,scope:plan.scope,explicitApproval:true};
}
export const tierGroupApproval=immutableValidationCache(function(plan,approval,group){
  assert.deepEqual(approveTierRefresh(plan,approval),approval);
  assert.deepEqual(plan.groups[group.groupIndex],group);
  return {id:group.id,parentId:plan.id,planSha256:digest(group),parentPlanSha256:digest(plan),
    parentApprovalSha256:digest(approval),capCents:group.maximumSpendCents,
    approvedAt:approval.approvedAt,scope:plan.scope,explicitApproval:true};
});
