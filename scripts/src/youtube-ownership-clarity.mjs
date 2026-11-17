// Offline-only experimental requests. No transport, approval or acceptance path.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeMusicKey} from './youtube-ownership-policy.mjs';
import {validateSavedModelOperation} from './youtube-saved-verification-execution.mjs';

export const CLARITY_VERSION='youtube-ownership-evidence-navigation-v1';
export const CLARITY_GUIDANCE=[
  'Evidence navigation below only indexes facts in this same request; it is not additional independent evidence or an ownership verdict.',
  'Evaluate exact artist identity and channel control together, while explaining which remains uncertain.',
  'An exact Spotify artist ID in a captured channel link supports identity; combine it with the actual channel description, self-identification and other supplied account links. It alone does not prove ownership.',
  'Read localized Spotify artist paths by their exact case-sensitive artist ID. Ignore tracking parameters, not identity differences.',
  'Missing Official Artist Channel or auto-generation flags do not require unknown channel type. Neither a missing badge nor missing reciprocal link is a mandatory veto; require positive combined support for artist control, not a checklist of mandatory fields.',
  'Classify what the account itself represents. A musician mentioning a label, publisher, church or group is not by that word alone a third-party account.',
  'A member is not their group, a distributor is not its artists, and a lyric uploader is not a credited musician. A song title, artist name or exact music link alone cannot overcome those distinctions.',
  'Keep Topic music presence separate from artist-managed ownership. Unresolved shared-channel or conflicting artist-ID evidence stays unresolved.',
  'When evidence remains insufficient, return uncertainty. Do not force a positive answer because this request contains an evidence index.',
].join('\n');

export function clarifiedOwnershipRequest(op,capture){
  assert.ok(capture,'Original capture required; model-readable summaries are not replay packets');
  const input=validateSavedModelOperation(op,op.requestBytes,capture);
  const {artist,candidate}=input.state;
  const linked=(artist.accounts??[]).flatMap((account,index)=>{
    if(String(account.profile_id)!==artist.profileId||String(account.cm_artist)!==artist.cmArtist)return [];
    const key=youtubeMusicKey(account.account_url??account.url);
    return key?[{key,sourcePath:`artist.accounts[${index}]`}]:[];
  });
  const knownSpotify=new Set(linked.filter(x=>x.key.startsWith('spotify:')).map(x=>x.key));
  const observed=(candidate.channelCapture.body.externalUrls??[]).flatMap((url,index)=>{
    const key=youtubeMusicKey(url);
    return key?[{key,sourcePath:`candidate.channelCapture.body.externalUrls[${index}]`}]:[];
  });
  const matches=observed.flatMap(o=>linked.filter(a=>a.key===o.key).map(a=>({
    accountKey:o.key,catalogSource:a.sourcePath,channelSource:o.sourcePath,
    direction:'candidate_channel_links_to_catalog_account',
    catalogStatus:'catalog_link_not_independently_verified',
  })));
  const otherSpotifyIds=observed.filter(o=>knownSpotify.size&&o.key.startsWith('spotify:')&&!knownSpotify.has(o.key));
  const request=structuredClone(op.request);
  request.body.state.evidenceRules+='\n\n'+CLARITY_GUIDANCE;
  request.body.state.evidenceNavigation={
    version:CLARITY_VERSION,derivedFromThisRequestOnly:true,
    sameAccountLinks:matches,otherObservedSpotifyIds:otherSpotifyIds,
    note:'Source paths are relative to the unchanged artist/candidate state. No new captures, ownership labels or independent adjudications.',
  };
  request.body.questions.channel_type.instructions+=
    ' Assess the channel itself, not the artist’s affiliations. Unknown badge flags alone do not mean an unknown role. Read evidenceRules and evidenceNavigation; exact account links support identity but do not automatically prove control.';
  request.body.questions.verdict.instructions+=
    ' Weigh the combined captured evidence, including exact cross-links; do not treat the absence of a mandatory badge or reciprocal link as a rule, because neither is mandatory.';
  request.body.questions.ownership_reason={
    type:'choice',
    instructions:'Give the primary evidence-based reason for your current judgment. This is an explanation category, not an extra vote. Use only supplied evidence.',
    criteria:{
      combined_identity_and_control:'Combined captured facts support this exact artist’s identity and artist-managed control.',
      identity_supported_control_uncertain:'Identity has supporting evidence, but who controls the channel remains unclear.',
      weak_identity_support:'Only weak identity clues such as names, snippets or associations support the pair.',
      third_party_channel:'The channel represents a label, group for an individual member, fan, lyric uploader or another third party.',
      conflicting_evidence:'Supplied evidence identifies competing artist identities or contradictory ownership.',
      topic_presence:'Auto-generated music presence, not artist-managed ownership.',
      insufficient_capture:'Supplied captures lack enough usable information to assess identity or control.',
    },
  };
  assert.deepEqual(request.body.state.artist,op.request.body.state.artist);
  assert.deepEqual(request.body.state.candidate,op.request.body.state.candidate);
  return {version:CLARITY_VERSION,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
    originalRequestSha256:op.inputSha256,request,proposedRequestSha256:digest(request),
    originalRequestBytes:op.requestBytes,proposedRequestBytes:Buffer.byteLength(JSON.stringify(request.body)),
    matchingSpotifyIds:[...new Set(matches.filter(m=>m.accountKey.startsWith('spotify:')).map(m=>m.accountKey))],
    executionEnabled:false,requiresFreshSpendingApproval:true,ownershipAccepted:false,importEligible:false};
}
