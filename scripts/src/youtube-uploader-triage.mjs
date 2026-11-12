// Pure discovery triage. No network, spending, acceptance or catalog writes.
import assert from 'node:assert/strict';
import {normalizeDiscoveryChannel} from './youtube-video-discovery-offline.mjs';
import {youtubeSearchNames} from './youtube-music-search.mjs';
import {youtubeChannelReviews} from './youtube-channel-review-decisions.mjs';

const norm=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function triageVideoUploader(artist,result,{reviews=youtubeChannelReviews,shared=false}={}){
  assert.equal(String(artist.profileId),String(result.profileId));
  assert.equal(String(artist.cmArtist),String(result.cmArtist));
  const url=normalizeDiscoveryChannel(result.url);
  assert.ok(url&&/^https:\/\/www\.youtube\.com\/channel\/UC[A-Za-z0-9_-]{22}$/.test(url));
  const base={policy:'uploader-not-artist-v1',ownershipAccepted:false,importEligible:false,
    independentlyVerified:false,automaticDownstreamEligible:false};
  const rejected=reviews.find(r=>r.status==='rejected'&&r.source==='user_review'
    &&r.profileId===String(artist.profileId)&&r.cmArtist===String(artist.cmArtist)&&r.url===url);
  if(rejected)return {...base,category:'user_rejected',candidate:false,
    reason:rejected.reason,reviewSource:'user_review',channelLabel:'User-rejected uploader'};
  const name=String(result.uploaderName??'').trim();
  const topic=/\s*[-–—]\s*topic\s*$/i.test(name);
  const identity=topic?name.replace(/\s*[-–—]\s*topic\s*$/i,''):name;
  const matched=youtubeSearchNames(artist).find(n=>norm(n.name)===norm(identity));
  const channelLabel=topic?'Topic — auto-generated lead, association unverified':'Uploader — ownership unverified';
  if(shared)return {...base,category:'shared_channel_hold',candidate:false,
    reason:'Same uploader observed for multiple catalog artists; ownership unresolved',channelLabel};
  if(!matched)return {...base,category:topic?'unbound_topic_hold':'unbound_uploader_hold',candidate:false,
    reason:'Uploader name has no exact catalog-bound artist or alias match; retain evidence, do not infer ownership',channelLabel};
  return {...base,category:topic?'topic_identity_check_candidate':'identity_check_candidate',candidate:true,
    reason:topic?'Topic name matches; artist association still needs independent evidence'
      :'Catalog-bound name matches only; artist ownership still needs independent evidence',
    nameSource:matched.source,channelLabel};
}
