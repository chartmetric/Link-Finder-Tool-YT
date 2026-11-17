// Offline recovery planning only. No provider imports, dispatch, or approval inheritance.
import assert from 'node:assert/strict';
import {digest,normalizeDiscoveryChannel} from './youtube-video-discovery-offline.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';

export const COVERAGE_RECOVERY_VERSION='youtube-coverage-recovery-v1';
const quote=value=>'"'+String(value).replace(/["\\]/gu,' ').replace(/\s+/gu,' ').trim()+'"';
const key=r=>JSON.stringify([r.artist.profileId,r.artist.cmArtist]);
const suggested=r=>r.candidates.some(c=>c.status==='review_suggestion');

function attemptedChannels(record){
  const urls=new Set();
  for(const c of record.candidates){
    for(const raw of [c.url,c.capture?.requestedUrl,...(c.providerAliases??[])]){
      const url=normalizeDiscoveryChannel(raw);if(url)urls.add(url);
    }
    const id=c.capture?.body?.channelId;
    if(/^UC[A-Za-z0-9_-]{22}$/.test(id??''))urls.add('https://www.youtube.com/channel/'+id);
  }
  return urls;
}
function savedVideoLeads(record){
  const tried=new Set((record.videoContexts??[]).map(c=>c.videoId));
  for(const c of record.candidates){
    try{
      const u=new URL(c.sourceUrl);
      if(u.hostname==='www.youtube.com'&&u.pathname==='/watch')tried.add(u.searchParams.get('v'));
    }catch{/* Non-video candidates have no uploader attempt. */}
  }
  const seen=new Set();
  return [...(record.videoPlan?.resolutionQueue??[]),...(record.videoPlan?.deferredVideos??[])]
    .filter(v=>{
      assert.equal(v.profileId,record.artist.profileId);
      assert.equal(v.cmArtist,record.artist.cmArtist);
      assert.match(v.videoId??'',/^[A-Za-z0-9_-]{11}$/);
      assert.equal(v.url,'https://www.youtube.com/watch?v='+v.videoId);
      if(tried.has(v.videoId)||seen.has(v.videoId))return false;
      seen.add(v.videoId);
      return v.eligible===true&&v.sources?.some(s=>
        s.profileId===record.artist.profileId&&s.cmArtist===record.artist.cmArtist&&
        s.matchedNames?.length&&!s.videoMentionHold&&
        /^[a-f0-9]{64}$/.test(s.receiptSha256??'')&&s.archivePath);
    }).map(v=>({...v,verified:false,ownershipEvidence:false}));
}

export function coverageRecoveryPlan(records){
  assert.ok(Array.isArray(records)&&records.length>0);
  const identities=new Set(),profiles=new Set();
  for(const r of records){
    assert.match(r.artist?.profileId??'',/^\d+$/);
    assert.match(r.artist?.cmArtist??'',/^\d+$/);
    assert.ok([1,2,3,4,5].includes(r.tier));
    assert.ok(Array.isArray(r.candidates));
    assert.ok(!identities.has(key(r))&&!profiles.has(r.artist.profileId),'Duplicate artist');
    identities.add(key(r));profiles.add(r.artist.profileId);
  }
  const recovery=records.filter(r=>!suggested(r)).map(r=>{
    const base=youtubeSearchPlan(r.artist),tried=attemptedChannels(r);
    const selected=new Set((r.discovery?.candidates??[]).map(c=>c.url));
    const channels=new Map();
    for(const c of r.discovery?.allSearchCandidates??[]){
      const url=normalizeDiscoveryChannel(c.url);
      if(!url||selected.has(c.url)||tried.has(url)||c.relevance?.bucket==='off_target')continue;
      if(!channels.has(url))channels.set(url,{...c,url,verified:false,ownershipEvidence:false});
    }
    const videos=savedVideoLeads(r);
    // Different requests, not retries of the original broad query. Names/context
    // are exclusively catalog-bound by youtubeSearchPlan; never guess a handle.
    const names=base.queryNames.map(n=>quote(n.value));
    const exact=names.length===1?names[0]:'('+names.join(' OR ')+')';
    const queries=[
      {kind:'direct_channel',q:`${exact} (site:youtube.com/@ OR site:youtube.com/channel/ OR site:youtube.com/c/ OR site:youtube.com/user/)`},
      {kind:'topic_music_presence',q:`${exact} "Topic" site:youtube.com/channel/`},
    ].filter(q=>q.q!==r.searchPlan?.request?.q).map(q=>({...q,request:{q:q.q,num:10}}));
    const status=r.candidates.some(c=>['uncertain','held'].includes(c.status))?'held_or_uncertain':
      r.candidates.length?'only_nonmatches':'no_selected_channel';
    return {profileId:r.artist.profileId,cmArtist:r.artist.cmArtist,artist:r.artist.name,tier:r.tier,
      previousOutcome:status,
      savedDirectCandidates:[...channels.values()],savedVideoLeads:videos,
      fallbackSuppressedByDirectSelection:selected.size>0&&videos.length>0,
      newSearches:queries,
      order:['untried_saved_channels','untried_saved_video_uploaders','targeted_searches'],
      stopWhen:'At least one independently assessed, identity-supported channel suggestion exists.',
      evidenceWarning:'Discovery leads are not supported links. A video credit does not identify the uploader as the artist.',
      ownershipAccepted:false,importEligible:false};
  });
  const summary={
    totalArtists:records.length,artistsWithSuggestions:records.filter(suggested).length,
    artistsNeedingRecovery:recovery.length,
    artistsWithUnusedSavedChannels:recovery.filter(r=>r.savedDirectCandidates.length).length,
    artistsWithUnusedSavedVideoLeads:recovery.filter(r=>r.savedVideoLeads.length).length,
    artistsWhoseVideoFallbackWasSuppressed:recovery.filter(r=>r.fallbackSuppressedByDirectSelection).length,
    heldOrUncertain:recovery.filter(r=>r.previousOutcome==='held_or_uncertain').length,
    onlyNonmatches:recovery.filter(r=>r.previousOutcome==='only_nonmatches').length,
    noSelectedChannel:recovery.filter(r=>r.previousOutcome==='no_selected_channel').length,
    newPaidCalls:0,newSupportedLinks:0,measuredCoverageGain:null,
  };
  return {version:COVERAGE_RECOVERY_VERSION,sourceResultsSha256:digest(records),summary,recovery,
    executionEnabled:false,inheritsSpendingApproval:false,catalogWrites:0,
    requirements:[
      'Fresh spending approval and a frozen bounded live policy are required before any provider call.',
      'Reconcile original admissions, including uncertain operations, before selecting paid work; this plan does not authorize replay.',
      'Recheck current tier eligibility and absence of catalog YouTube links before paid work.',
      'No initial direct-channel selection suppresses recovery after its candidates fail to produce a supported suggestion.',
      'Channel capture, exact-artist assessment and shared-channel conflict checks remain required.',
      'Topic suggestions remain labeled separately from artist-facing channels.',
      'Report artists with supported suggestions separately from raw candidates, channel counts and reviewed precision.',
    ]};
}
