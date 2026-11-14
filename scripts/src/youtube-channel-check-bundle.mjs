import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateMixedCapturePlan,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
export function channelCheckBundle(input){
  assert.match(input.id,/^youtube-batch-channel-checks-[a-z0-9-]{4,75}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.ok(input.children.length>0&&input.children.length<=5);
  assert.match(input.sourceBundleId,/^youtube-batch-100-[a-z0-9-]{4,70}$/);
  assert.match(input.sourceBundleSha256,/^[a-f0-9]{64}$/);
  const operations=[],children=input.children.map(c=>{
    const p=validateMixedCapturePlan(c.plan);
    assert.equal(p.version,DIRECT_CAPTURE_POLICY);assert.equal(c.id,p.id);
    operations.push(...p.operations);
    return {id:p.id,plan:p,planSha256:digest(p),capCents:p.maximumSpendCents};
  });
  assert.equal(new Set(children.map(c=>c.id)).size,children.length);
  for(const key of ['profileId','cmArtist','allocationChannelKey'])
    assert.equal(new Set(operations.map(o=>o[key])).size,operations.length,'Duplicate '+key+' across capture groups');
  assert.ok(operations.length>0&&operations.length<=100);
  assert.ok(Object.keys(input.runtimeFiles??{}).length);
  for(const [file,sha] of Object.entries(input.runtimeFiles)){
    assert.match(file,/^runtime\/[A-Za-z0-9_-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return {version:'exact-direct-channel-check-bundle-v1',id:input.id,preparedAt:input.preparedAt,
    sourceBundleId:input.sourceBundleId,sourceBundleSha256:input.sourceBundleSha256,
    children:structuredClone(children),runtimeFiles:structuredClone(input.runtimeFiles),
    maximumCalls:operations.length,maximumSpendCents:operations.length*2,allowedKinds:['metadata'],
    sequentialChildren:true,stopOnChildFailure:true,noRetries:true,noCatalogWrites:true,
    explicitApproval:false,fullCampaignRemainsPaused:true,modelCalls:0,uploaderCalls:0,
    nextStage:'Keep video fallbacks and independent artist-identity checks separately approved'};
}
export function approveChannelCheckBundle(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(channelCheckBundle(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,plan.maximumSpendCents);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    childScopeSha256:digest(plan.children.map(c=>({id:c.id,planSha256:c.planSha256,capCents:c.capCents}))),
    scope:'only_exact_channel_metadata_no_search_uploaders_models_or_retries'};
}
