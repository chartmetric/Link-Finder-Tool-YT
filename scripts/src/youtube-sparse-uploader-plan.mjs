import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateVideoStagePlan,SMALL_VIDEO_STAGE_POLICY} from './youtube-video-stage.mjs';
import {CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE} from './youtube-uploader-conflict-handling.mjs';
import {SPARSE_ID,SPARSE_SOURCE,SPARSE_DIRECT} from './youtube-sparse-uploader-source.mjs';

function hashes(input,prefix){
  assert.ok(input&&Object.keys(input).length);
  for(const [name,hash] of Object.entries(input)){
    assert.match(name,new RegExp('^'+prefix+'/[A-Za-z0-9_./-]+$'));
    assert.ok(!name.split('/').some(p=>['..','.',''].includes(p)));
    assert.match(hash,/^[a-f0-9]{64}$/);
  }
  return structuredClone(input);
}
export function sparseUploaderPlan(input){
  assert.equal(input.id,SPARSE_ID);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.match(input.sourcePlanSha256,/^[a-f0-9]{64}$/);
  assert.ok(input.children.length>=1&&input.children.length<=5);
  const artists=[],operations=[];
  const children=input.children.map((c,i)=>{
    const p=validateVideoStagePlan(c.plan);
    assert.equal(p.version,SMALL_VIDEO_STAGE_POLICY);
    assert.equal(p.sourceRunId,SPARSE_SOURCE);assert.equal(p.sourcePlanSha256,input.sourcePlanSha256);
    assert.equal(c.id,p.id);assert.equal(p.id,`youtube-video-review-sparse-100-2026-11-16-part-${i+1}`);
    assert.equal(p.evidenceFiles[CONFLICT_HANDLING_FILE],digest(JSON.stringify(CONFLICT_HANDLING_SCOPE)));
    artists.push(...p.artists);operations.push(...p.operations);
    return {id:p.id,plan:structuredClone(p),planSha256:digest(p),capCents:p.maximumSpendCents};
  });
  for(const key of ['profileId','cmArtist'])
    assert.equal(new Set(artists.map(a=>a[key])).size,artists.length,'Duplicate '+key);
  for(const key of ['key','videoId'])
    assert.equal(new Set(operations.map(o=>o[key])).size,operations.length,'Duplicate '+key);
  assert.ok(artists.length>0&&artists.length<=24);
  assert.ok(operations.length>0&&operations.length<=48);
  return {version:'sparse-saved-uploader-bundle-v1',id:SPARSE_ID,preparedAt:input.preparedAt,
    sourceId:SPARSE_SOURCE,directExclusionId:SPARSE_DIRECT,sourcePlanSha256:input.sourcePlanSha256,
    children,evidenceFiles:hashes(input.evidenceFiles,'evidence'),runtimeFiles:hashes(input.runtimeFiles,'runtime'),
    originalArtists:100,originalDirectSelections:55,savedVideoCandidates:24,
    proposedArtists:artists.length,maximumCalls:operations.length,maximumSpendCents:operations.length*2,
    allowedKinds:['video_uploader'],searchCalls:0,channelMetadataCalls:0,modelCalls:0,
    acceptedArtistChannels:0,explicitApproval:false,inheritsPriorApproval:false,
    sequentialChildren:true,stopOnChildFailure:true,noAutomaticRetries:true,noCatalogWrites:true,
    fullCampaignRemainsPaused:true,validatedConflictsHeld:true,unknownDownstreamRequestsApproved:false,
    nextStage:'Separately freeze and approve exact channel and identity requests after uploader discovery'};
}
export function approveSparseUploaders(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(sparseUploaderPlan(plan),plan);
  assert.equal(planSha256,digest(plan));assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,policy:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    childScopeSha256:digest(plan.children.map(c=>({id:c.id,planSha256:c.planSha256,capCents:c.capCents}))),
    scope:'exact_saved_uploaders_only_no_search_channel_identity_or_replay'};
}
