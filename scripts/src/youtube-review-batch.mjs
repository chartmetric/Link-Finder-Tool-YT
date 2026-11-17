// Review-only end-to-end policy: one search, at most five paid calls per artist.
import assert from 'node:assert/strict';
import {digest,planVideoDiscovery,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {captureYoutubeCandidates} from './youtube-candidate-consolidation.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {revisedContextRequest} from './youtube-context-revision.mjs';
import {parseCombinedResponse} from './youtube-combined-ownership.mjs';

export const REVIEW_BATCH_POLICY='fresh-youtube-review-hundred-end-to-end-v1';
export function reviewBatchPlan(p){
  assert.equal(p.version,REVIEW_BATCH_POLICY);
  // The existing coordinator permits a $10 cap only for this supported
  // hundred-artist namespace. Other experiment IDs are limited to $2.
  assert.match(p.id,/^youtube-test-100-review-[a-z0-9-]{4,65}$/);
  assert.equal(p.artists.length,100);assert.equal(p.packets.length,100);
  assert.equal(new Set(p.artists.map(a=>a.profile_id)).size,100);
  assert.equal(new Set(p.artists.map(a=>a.cm_artist)).size,100);
  for(const a of p.artists){
    assert.match(a.profile_id,/^\d+$/);assert.match(a.cm_artist,/^\d+$/);
    assert.ok([1,2,3,4,5].includes(a.tier));
    assert.equal(p.packets.filter(r=>r.profileId===a.profile_id&&r.cmArtist===a.cm_artist).length,1);
  }
  assert.equal(p.scopeSha256,digest(p.artists));
  assert.equal(p.catalogEvidenceSha256,digest(p.packets));
  assert.equal(p.maximumSpendCents,1000);assert.equal(p.maximumCalls,500);
  assert.equal(p.maximumCallsPerArtist,5);
  assert.ok(Object.keys(p.sourceFiles).length&&Object.keys(p.runtimeFiles).length);
  for(const [f,sha] of Object.entries(p.sourceFiles)){
    assert.ok(f.startsWith('generated-artifacts/')&&!f.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  for(const [f,sha] of Object.entries(p.runtimeFiles)){
    assert.match(f,/^runtime\/[\w-]+\.mjs$/);assert.match(sha,/^[a-f0-9]{64}$/);
  }
  assert.equal(p.pricing.id,'typesafe/jev-1.13');
  assert.ok(Number(p.pricing.promptUsdPerToken)>0&&Number(p.pricing.promptUsdPerToken)<=.000000042);
  assert.equal(Number(p.pricing.completionUsdPerToken),0);
  assert.ok(p.pricing.contextTokens>=262144);
  return {...p,parentId:'full-tiers-1-5-no-youtube-uncapped',maximumModelRequestBytes:64000,
    reviewOnly:true,ownershipAccepted:false,importEligible:false,catalogWrites:0,noRetries:true,
    includeTopicChannels:true,policyActivated:false,
    policy:'For each artist: one search; up to two direct channel captures and one model check per distinct captured channel. Only when no direct channel is selected, resolve one saved eligible video uploader, then capture and check that channel. Maximum five calls per artist and 500 calls in total, reserving two cents before every call. Preserve unknown, conflicting, failed and no-selected-channel outcomes separately. No paid retries, source refreshes, automatic acceptance or catalog writes.'};
}
export function approveReviewBatch(plan,{planSha256,capCents,approvedAt}){
  assert.deepEqual(reviewBatchPlan(plan),plan);assert.equal(planSha256,digest(plan));
  assert.equal(capCents,1000);assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {...plan,planSha256,capCents,approvedAt,userCapCents:1000,proposedCapCents:1000,operationalCapCents:1000,
    explicitApproval:true,approvalStatus:'approved',maxCalls:500,
    scope:'User approved 100 new artists and a $10 total allowance across search, channel information and verification. Review suggestions only; no live-link changes.'};
}
export function uploaderContext(packet,clue){
  const raw=packet.data;
  assert.equal(packet.kind,'metadata');assert.equal(packet.status,200);
  assert.equal(packet.rawBodySha256,digest(Buffer.from(packet.rawBodyBase64,'base64')));
  assert.deepEqual(JSON.parse(Buffer.from(packet.rawBodyBase64,'base64')),raw);
  assert.deepEqual(packet.request,proposedUploaderRequest(clue.url));
  assert.equal(raw.success,true);assert.equal(raw.id,clue.videoId);
  const id=raw.channel?.id;assert.match(id??'',/^UC[A-Za-z0-9_-]{22}$/);
  for(const owner of [raw.uploader,raw.ownerByline])if(owner?.channelId)assert.equal(owner.channelId,id);
  return {videoId:clue.videoId,videoUrl:clue.url,channelId:id,
    title:typeof raw.title==='string'?raw.title:'',description:typeof raw.description==='string'?raw.description:null,
    uploaderDisplayName:raw.channel.title??null,capturedAt:packet.at,
    provenance:{rawBodySha256:packet.rawBodySha256,receiptSha256:digest(packet),
      requestSha256:digest(packet.request),operationKey:packet.operationKey,runId:packet.runId},
    establishesOwnership:false};
}
export async function reviewBatchArtist({artist,tier,request,conflicts,maximumModelRequestBytes=64000}){
  const searchPlan=youtubeSearchPlan(artist);
  const search=await request(artist.profileId,'search','search-'+artist.profileId+'-0',
    {method:'POST',url:'https://google.serper.dev/search',body:searchPlan.request});
  assert.equal(search.status,200);assert.ok(Array.isArray(search.data?.organic));
  const discovery=rankYoutubeSearchCandidates(youtubeSearchCandidates(search.data),searchPlan,
    {limit:2,includeTopicChannels:true});
  const videoPlan=planVideoDiscovery(artist,search.data.organic,
    {archivePath:search.sourcePath,receiptSha256:digest(search)});
  let selected=discovery.candidates,videoContexts=[];
  if(!selected.length&&videoPlan.resolutionQueue.length){
    const clue=videoPlan.resolutionQueue[0],packet=await request(artist.profileId,'metadata',
      'metadata-'+artist.profileId+'-video-'+clue.videoId,proposedUploaderRequest(clue.url));
    const context=uploaderContext(packet,clue);videoContexts=[context];
    selected=[{url:'https://www.youtube.com/channel/'+context.channelId,
      title:context.uploaderDisplayName??'',snippet:context.title,
      sourceUrl:clue.url,source:'bound_video_uploader',verified:false}];
  }
  const candidates=await captureYoutubeCandidates(artist,selected,async c=>{
    const packet=await request(artist.profileId,'metadata',
      'metadata-'+artist.profileId+'-channel-'+digest(c.url),
      {method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url:c.url})});
    return normalizeYoutubeChannel(packet,c.url);
  });
  for(const candidate of candidates){
    const channelId=candidate.capture?.body.channelId;
    if(!channelId){candidate.status='held';candidate.reason='Channel information could not be bound to the requested URL';continue;}
    const externalConflict=await conflicts(artist,candidate);
    if(externalConflict||candidate.contradictoryPair){
      candidate.status='held';candidate.reason='Conflicting artist or channel evidence';candidate.sharedChannelConflict=true;continue;
    }
    const input=youtubeVerificationInput(artist,candidate);
    if(!input.readyForModel){candidate.status='held';candidate.reason='Usable bound channel evidence is missing';continue;}
    const prepared=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
      expectedModel:'typesafe/jev-1.13',maxRequestBytes:maximumModelRequestBytes}});
    const template={key:'unsent-'+artist.profileId+'-'+channelId,kind:'model',profileId:artist.profileId,
      cmArtist:artist.cmArtist,channelId,request:prepared.request,inputSha256:prepared.inputSha256,
      policyInputSha256:input.inputSha256,requestBytes:prepared.bytes,
      requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),proposedReservationCents:2};
    const draft=revisedContextRequest(template,candidate.capture,videoContexts.filter(c=>c.channelId===channelId));
    candidate.modelInputSha256=draft.requestSha256;
    if(draft.requestBytes>maximumModelRequestBytes){
      candidate.status='held';candidate.reason='Full evidence exceeds the request-size limit; not truncated';continue;
    }
    const response=await request(artist.profileId,'model','model-'+artist.profileId+'-'+channelId,draft.request);
    const result=parseCombinedResponse({...draft,originalOperation:template,originalCapture:candidate.capture,
      stateSha256:digest({policy:REVIEW_BATCH_POLICY,state:draft.request.body.state})},response);
    candidate.assessment=result;
    candidate.status=['experimental_artist_support','experimental_topic_support'].includes(result.decision.status)
      ?'review_suggestion':['third_party_channel','different_artist'].includes(result.modelAssessment.category)
        ?'not_a_match':'uncertain';
    candidate.reason=result.modelAssessment.label;
  }
  return {artist,tier,searchPlan,discovery,videoPlan,videoContexts,candidates,
    status:candidates.length?'processed':'no_selected_channel',ownershipAccepted:false,importEligible:false};
}
export function holdSharedBatchChannels(records){
  const owners=new Map();
  for(const r of records)for(const c of r.candidates){
    const id=c.capture?.body.channelId;if(!id)continue;
    const ids=owners.get(id)??new Set();ids.add(r.artist.profileId);owners.set(id,ids);
  }
  for(const r of records)for(const c of r.candidates)
    if((owners.get(c.capture?.body.channelId)?.size??0)>1){
      c.status='held';c.reason='Same channel appeared for multiple artists; ownership unresolved';
      c.sharedChannelConflict=true;
    }
}
export function reviewBatchRows(records){
  holdSharedBatchChannels(records);
  return records.flatMap(r=>{
    const seen=new Set(),candidates=r.candidates.length?r.candidates:[null];
    return candidates.flatMap(c=>{
      const id=c?.capture?.body.channelId;
      if(id&&seen.has(id))return [];if(id)seen.add(id);
      const topic=c?.capture?.body.isAutoGenerated===true||
        /[-–—]\s*topic$/iu.test(c?.capture?.body.displayName??'');
      return [{artist:r.artist.name,tier:r.tier,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,
        youtube_url:id?'https://www.youtube.com/channel/'+id:'',
        channel_type_label:topic?'Topic — auto-generated':c?.assessment?.channelTypeLabel??'Unknown',
        status:c?.status??r.status,assessment:c?.assessment?.modelAssessment.category??'',
        reason:c?.reason??(r.status==='failed'?'Processing failed; not a completed no-match':
          'No channel selected from this search; not proof the artist has no channel'),
        channel_name:c?.capture?.body.displayName??'',ownership_accepted:false,import_eligible:false}];
    });
  });
}
