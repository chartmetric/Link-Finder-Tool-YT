import assert from 'node:assert/strict';
import {digest,normalizeDiscoveryChannel,planVideoDiscovery,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {rankYoutubeSearchCandidates,youtubeSearchPlan} from './youtube-search-plan.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {artistRepresentationRequest,parseArtistRepresentationResponse} from './youtube-artist-representation.mjs';
import {uploaderContext} from './youtube-review-batch.mjs';
import {coverageRecoveryPlan} from './youtube-coverage-recovery.mjs';

export const COVERAGE_EXECUTION='bounded-youtube-coverage-recovery-v1';
export const COVERAGE_LIMITS=Object.freeze({totalCalls:500,perArtist:12,search:2,metadata:6,model:4});
export class CoverageLimit extends Error {
  constructor(reason){super(reason);this.code='COVERAGE_LIMIT';}
}
export function validateCoverageApproval(plan,approval){
  assert.equal(plan.version,COVERAGE_EXECUTION);
  assert.match(plan.id,/^youtube-test-100-coverage-75-[a-z0-9-]+$/);
  assert.equal(plan.maximumSpendCents,1000);
  assert.deepEqual(plan.limits,COVERAGE_LIMITS);
  assert.equal(plan.records.length,100);assert.equal(plan.recovery.recovery.length,75);
  assert.equal(plan.recovery.sourceResultsSha256,digest(plan.records));
  assert.deepEqual(plan.recovery,coverageRecoveryPlan(plan.records));
  assert.equal(plan.recovery.summary.artistsWithSuggestions,25);
  assert.equal(plan.reviewOnly,true);assert.equal(plan.catalogWrites,0);
  assert.equal(approval.planSha256,digest(plan));
  assert.equal(approval.explicitApproval,true);assert.equal(approval.additionalCapCents,1000);
  assert.equal(approval.approvalScope,'75 previously unsuggested artists; additional $10 recovery; review only');
  if(plan.sourceRun){
    assert.match(plan.sourceRun.id,/^youtube-test-100-coverage-75-[a-z0-9-]+$/);
    assert.notEqual(plan.sourceRun.id,plan.id);
    assert.equal(plan.sourceRun.snapshot.run.id,plan.sourceRun.id);
    assert.equal(plan.sourceRun.snapshot.run.status,'stopped');
    assert.equal(plan.sourceRun.snapshot.run.scope_sha256,plan.scopeSha256);
    assert.equal(plan.sourceRun.reservedCents,plan.sourceRun.snapshot.run.reserved_cents);
    assert.equal(plan.sourceRun.reservedCents,plan.sourceRun.snapshot.admissions.length*2);
    assert.ok(plan.sourceRun.snapshot.admissions.every(a=>a.status==='returned'));
    assert.equal(plan.sourceRun.initialState.length,100);
    assert.equal(digest(plan.sourceRun.initialState),plan.sourceRun.initialStateSha256);
    assert.deepEqual(plan.sourceRun.initialState.map(r=>[r.artist.profileId,r.artist.cmArtist]),
      plan.records.map(r=>[r.artist.profileId,r.artist.cmArtist]));
  }
}
export function assertCoverageAdmission({run,owner,approvalHash,scopeHash,operation,history,pending,live}){
  assert.equal(run.owner,owner);assert.equal(run.status,'running');
  assert.equal(run.scope_sha256,scopeHash);
  assert.equal(run.cap_cents,1000);
  assert.equal(operation.approvalHash,approvalHash);
  for(const p of pending)assert.deepEqual(live.get(p.operation_key),
    {profileId:p.profile_id,kind:p.kind,inputSha256:p.input_sha256});
  assert.ok(!pending.some(p=>p.profile_id===operation.profileId),'One request at a time per artist');
  assert.ok(history.every(h=>h.status==='returned'),'Unknown outcome blocks new work');
  if(Number(run.reserved_cents)+2>1000)throw new CoverageLimit('Additional $10 cap reached');
  if(history.length>=COVERAGE_LIMITS.perArtist||
    history.filter(h=>h.kind===operation.kind).length>=COVERAGE_LIMITS[operation.kind])
    throw new CoverageLimit('Per-artist request limit reached');
  assert.ok(!history.some(h=>h.input_sha256===operation.inputSha256&&h.kind===operation.kind),
    'Paid request must be reused, never repeated');
}
export function recoverySearchCandidates(data){
  assert.ok(Array.isArray(data.organic),'Missing search results are not a no-match');
  const seen=new Set();
  return data.organic.flatMap(r=>{
    const url=normalizeDiscoveryChannel(r.link);
    if(!url||seen.has(url))return [];seen.add(url);
    return [{url,title:String(r.title??''),snippet:String(r.snippet??''),
      sourceUrl:r.link,source:'serper_recovery',verified:false}];
  });
}
export function recoveryQueues(record,recovery){
  const urls=new Set(record.candidates.flatMap(c=>[c.url,...(c.providerAliases??[]),
    c.capture?.body?.channelId?'https://www.youtube.com/channel/'+c.capture.body.channelId:null])
    .map(normalizeDiscoveryChannel).filter(Boolean));
  return {seenUrls:urls,seenIds:new Set(record.candidates.map(c=>c.capture?.body?.channelId).filter(Boolean)),
    channels:structuredClone(recovery.savedDirectCandidates),
    videos:structuredClone(recovery.savedVideoLeads).filter(v=>
      !(record.videoContexts??[]).some(context=>context.videoId===v.videoId)),
    videoAttempts:0,searches:structuredClone(recovery.newSearches)};
}
// Injectable request path: the live adapter independently enforces every cap.
// Each pass handles one artist; no search occurs again after a supported suggestion.
export async function recoverCoverageArtist({record,recovery,request,conflicts,round,queues}){
  if(record.candidates.some(c=>c.status==='review_suggestion'))return;
  const artist=record.artist;
  record.recoveryEvents??=[];
  const fetchChannel=async(clue,contexts=[])=>{
    const url=normalizeDiscoveryChannel(clue.url);
    if(!url||queues.seenUrls.has(url))return;
    queues.seenUrls.add(url);
    const packet=await request(artist,'metadata',{method:'GET',
      url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url})});
    const capture=normalizeYoutubeChannel(packet,url),id=capture?.body?.channelId;
    const candidate={...clue,url,capture,recovery:true,verified:false,status:'held',
      reason:'Recovery assessment not completed; not a supported link'};
    record.candidates.push(candidate);
    if(!id){candidate.status='held';candidate.reason='Recovery capture could not be bound to its target';return;}
    if(queues.seenIds.has(id)){
      candidate.status='held';candidate.reason='Already assessed channel discovered through another URL; no repeated model check';return;
    }
    queues.seenIds.add(id);
    if(await conflicts(artist,candidate)){
      candidate.status='held';candidate.reason='Conflicting artist or channel evidence';
      candidate.sharedChannelConflict=true;return;
    }
    const input=youtubeVerificationInput(artist,candidate);
    if(!input.readyForModel){candidate.status='held';candidate.reason='Usable bound channel evidence is missing';return;}
    const model=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
      expectedModel:'typesafe/jev-1.13',maxRequestBytes:64000}});
    const template={key:'coverage-'+artist.profileId+'-'+id,kind:'model',
      profileId:artist.profileId,cmArtist:artist.cmArtist,channelId:id,
      request:model.request,inputSha256:model.inputSha256,policyInputSha256:input.inputSha256,
      requestBytes:model.bytes,requestBodySha256:digest(Buffer.from(JSON.stringify(model.request.body))),
      proposedReservationCents:2};
    const draft=artistRepresentationRequest(template,capture,contexts,64000);
    if(!draft.readyForComparison){candidate.status='held';candidate.reason='Complete evidence exceeds approved request size';return;}
    candidate.modelInputSha256=draft.requestSha256;
    const response=await request(artist,'model',draft.request);
    const assessment=parseArtistRepresentationResponse(draft,response);
    candidate.assessment=assessment;
    candidate.status=assessment.decision.reviewSuggestion?'review_suggestion':
      ['third_party_channel','different_artist'].includes(assessment.modelAssessment.category)?'not_a_match':'uncertain';
    candidate.reason=assessment.modelAssessment.label;
  };
  const resolveVideo=async clue=>{
    queues.videoAttempts++;
    const packet=await request(artist,'metadata',proposedUploaderRequest(clue.url));
    let context;
    try{context=uploaderContext(packet,clue);}
    catch(e){
      if(e.code!=='YOUTUBE_UPLOADER_CONFLICT')throw e;
      record.recoveryEvents.push({kind:'conflicting_uploader',videoId:clue.videoId,sourceReceipt:packet.sourcePath});return;
    }
    record.videoContexts??=[];record.videoContexts.push(context);
    await fetchChannel({url:'https://www.youtube.com/channel/'+context.channelId,
      title:context.uploaderDisplayName??'',snippet:context.title,sourceUrl:clue.url,
      source:'bound_recovery_video_uploader'},[context]);
  };
  if(round===0&&queues.channels.length){await fetchChannel(queues.channels.shift());return;}
  if(queues.videos.length&&queues.videoAttempts<2){await resolveVideo(queues.videos.shift());return;}
  if(queues.channels.length){await fetchChannel(queues.channels.shift());return;}
  if(!queues.searches.length)return;
  const query=queues.searches.shift(),packet=await request(artist,'search',
    {method:'POST',url:'https://google.serper.dev/search',body:query.request});
  const found=rankYoutubeSearchCandidates(recoverySearchCandidates(packet.data),youtubeSearchPlan(artist),
    {limit:2,includeTopicChannels:true});
  record.recoveryEvents.push({kind:'targeted_search',query:query.request.q,
    sourceReceipt:packet.sourcePath,discoveredChannels:found.allSearchCandidates});
  for(const c of found.candidates)if(!queues.seenUrls.has(c.url)&&!queues.channels.some(x=>x.url===c.url))
    queues.channels.push(c);
  const video=planVideoDiscovery(artist,packet.data.organic,{archivePath:packet.sourcePath,receiptSha256:digest(packet)});
  const usedVideos=new Set((record.videoContexts??[]).map(c=>c.videoId));
  for(const v of video.resolutionQueue)if(!usedVideos.has(v.videoId)&&!queues.videos.some(x=>x.videoId===v.videoId))
    queues.videos.push(v);
  if(queues.channels.length)await fetchChannel(queues.channels.shift());
  else if(queues.videos.length&&queues.videoAttempts<2)await resolveVideo(queues.videos.shift());
}
