// New preparation only: local to one catalog artist, never an answer cache.
import assert from 'node:assert/strict';
import {boundYoutubeCapture,youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';

export const YOUTUBE_CANDIDATE_POLICY='provider-bound-artist-channel-v1';

function assertFresh(artist,candidates){
  assert.match(String(artist.profileId),/^\d+$/);
  assert.match(String(artist.cmArtist),/^\d+$/);
  assert.equal(String(artist.catalogProfile?.profile_id),String(artist.profileId));
  assert.equal(String(artist.catalogProfile?.cm_artist),String(artist.cmArtist));
  for(const c of candidates){
    assert.ok(!c.recordedAnswer&&!c.decision&&!c.metadataActuallyUsed,
      'Consolidation is for fresh candidates, not archived assessments.');
  }
}

// Keeps every independently obtained capture (and its original requested URL).
// A reused alias is explicitly NOT represented as a second metadata capture.
export function consolidateYoutubeCandidates(artist,observations){
  assertFresh(artist,observations);
  const groups=[],byChannel=new Map();
  for(const observation of observations){
    const capture=boundYoutubeCapture(observation.url,observation.capture);
    let channel=capture?.body.channelId;
    if(observation.metadataReusedFrom){
      const source=observations.find(c=>c.url===observation.metadataReusedFrom.candidateUrl
        &&!c.metadataReusedFrom);
      const bound=source&&boundYoutubeCapture(source.url,source.capture);
      assert.ok(bound&&bound.aliases.includes(youtubeOwnershipUrl(observation.url))
        &&bound.body.channelId===observation.metadataReusedFrom.channelId
        &&bound.bodySha256===observation.metadataReusedFrom.bodySha256
        &&source.capture.rawReceiptSha256===observation.metadataReusedFrom.rawReceiptSha256,
      'Alias reuse requires an exact local provider capture.');
      assert.equal(observation.capture,null);
      channel=bound.body.channelId;
    }
    let group=channel?byChannel.get(channel):null;
    if(!group){
      assert.ok(!observation.metadataReusedFrom,'Alias source must precede its reuse.');
      group={...observation,aliasProvenance:[],providerAliases:[],
        consolidation:{policy:YOUTUBE_CANDIDATE_POLICY,
          profileId:String(artist.profileId),cmArtist:String(artist.cmArtist),channelId:channel??null}};
      groups.push(group);
      if(channel)byChannel.set(channel,group);
    }
    group.aliasProvenance.push(structuredClone(observation));
    if(capture){
      group.providerAliases=[...new Set([...group.providerAliases,...capture.aliases])];
      // Do not silently choose a favorable observation if the source changed.
      // Every capture remains available for review; no model dispatch on conflict.
      if(capture.bodySha256!==group.capture.bodySha256)group.contradictoryPair=true;
    }
    if(observation.contradictoryPair)group.contradictoryPair=true;
  }
  return groups;
}

export async function captureYoutubeCandidates(artist,candidates,fetchCapture){
  assertFresh(artist,candidates);
  const observations=[];
  for(const candidate of candidates){
    const url=youtubeOwnershipUrl(candidate.url);
    const source=observations.find(c=>{
      const capture=boundYoutubeCapture(c.url,c.capture);
      return capture&&capture.aliases.includes(url);
    });
    if(source){
      const bound=boundYoutubeCapture(source.url,source.capture);
      observations.push({...candidate,capture:null,metadataReusedFrom:{
        candidateUrl:source.url,channelId:bound.body.channelId,
        bodySha256:bound.bodySha256,rawReceiptSha256:source.capture.rawReceiptSha256}});
    }else observations.push({...candidate,capture:await fetchCapture(candidate)});
  }
  return consolidateYoutubeCandidates(artist,observations);
}
