// Exact fresh search stage; no uploader/channel/model approval is inherited.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';

export const STAGED_SEARCH_POLICY='exact-twenty-artist-youtube-search-v1';
const sha=/^[a-f0-9]{64}$/;
function files(value){
  assert.ok(value&&Object.keys(value).length);
  for(const [file,hash] of Object.entries(value)){
    assert.match(file,/^[A-Za-z0-9_./-]+$/);
    assert.ok(!file.startsWith('/')&&!file.split('/').some(p=>['','..','.'].includes(p)));
    assert.match(hash,sha);
  }
  return structuredClone(value);
}
export function stagedSearchPlan(input){
  assert.match(input.id,/^youtube-test-[a-z0-9-]{4,100}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  assert.equal(input.artists.length,20);assert.equal(input.packets.length,20);
  const artists=input.artists.map(a=>{
    assert.match(a.profile_id,/^\d+$/);assert.match(a.cm_artist,/^\d+$/);
    assert.ok(typeof a.artist==='string'&&a.artist.trim());
    assert.ok(Number.isInteger(a.tier)&&a.tier>=1&&a.tier<=5);
    assert.ok(Number.isInteger(a.ordinal));
    assert.ok(Number.isFinite(Date.parse(a.snapshot_at.replace(' ','T')+'Z')));
    return {profile_id:a.profile_id,cm_artist:a.cm_artist,artist:a.artist,tier:a.tier,
      ordinal:a.ordinal,snapshot_at:a.snapshot_at};
  });
  assert.equal(new Set(artists.map(a=>a.profile_id)).size,20);
  assert.equal(new Set(artists.map(a=>a.cm_artist)).size,20);
  assert.ok(artists.every((a,i)=>!i||artists[i-1].tier<a.tier
    ||artists[i-1].tier===a.tier&&artists[i-1].ordinal<=a.ordinal));
  const operations=artists.map(a=>{
    const packets=input.packets.filter(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist);
    assert.equal(packets.length,1);
    const artist=youtubeArtistFromCatalogPacket(packets[0]);
    assert.equal(artist.name,a.artist);
    const searchPlan=youtubeSearchPlan(artist);
    const request={method:'POST',url:'https://google.serper.dev/search',body:searchPlan.request};
    return {profileId:a.profile_id,cmArtist:a.cm_artist,kind:'search',
      key:'search-'+a.profile_id+'-0',request,inputSha256:digest(request),reservationCents:2};
  });
  return {version:STAGED_SEARCH_POLICY,id:input.id,preparedAt:input.preparedAt,
    parentId:'full-tiers-1-5-no-youtube-uncapped',artists,scopeSha256:digest(artists),
    packets:structuredClone(input.packets),catalogEvidenceSha256:digest(input.packets),operations,
    evidenceFiles:files(input.evidenceFiles),runtimeFiles:files(input.runtimeFiles),
    maxCalls:20,proposedCapCents:40,operationalCapCents:40,userCapCents:null,
    allowedKinds:['search'],explicitApproval:false,approvalStatus:'awaiting_spending_approval',
    discoveryPolicyVersion:2,noAutomaticRetries:true,noCatalogWrites:true,fullCampaignRemainsPaused:true,
    retainDirectChannels:true,retainVideoFallbacks:true,includeTopicChannels:true,
    acceptedLinks:0,unknownDownstreamRequestsApproved:false,
    laterStageCeilings:{videoUploaderCalls:40,channelCaptureCalls:40,identityModelCalls:40,
      proposedMaximumAdditionalCents:240,separateExactApprovalRequired:true},
    warning:'Only the 20 frozen search requests can be approved here. Uploaders, channel captures and identity requests require later exact plans and approvals. Discovery is not ownership.'};
}
export function validateStagedSearchPlan(plan){
  assert.deepEqual(stagedSearchPlan(plan),plan);return plan;
}
export function approveStagedSearch(plan,{expectedPlanSha256,capCents,approvedAt}){
  validateStagedSearchPlan(plan);
  assert.equal(digest(plan),expectedPlanSha256);assert.equal(capCents,40);
  assert.ok(Number.isFinite(Date.parse(approvedAt)));
  return {...plan,planSha256:digest(plan),userCapCents:40,explicitApproval:true,
    approvalStatus:'approved',approvedAt,approvedScope:'exact_twenty_searches_only'};
}
export function assertStagedSearchApproval(plan,approval){
  assert.deepEqual(approveStagedSearch(plan,{expectedPlanSha256:approval.planSha256,
    capCents:approval.userCapCents,approvedAt:approval.approvedAt}),approval);
}
