// Music-presence suggestions are distinct from artist ownership. Future runs only.
import {evaluateYoutubeOwnership,boundYoutubeCapture,youtubeMusicKey,
  youtubeOwnershipUrl,evidenceDigest} from './youtube-ownership-policy.mjs';

export const YOUTUBE_LINK_POLICY='artist-and-supported-topic-links-v1';
const name=value=>String(value??'').normalize('NFKC').toLowerCase()
  .replace(/\s*[-–—]\s*topic\s*$/iu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const safeUrl=value=>{
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:null;}
  catch{return null;}
};
export function evaluateYoutubeLink(artist,candidate,options={}){
  const original=evaluateYoutubeOwnership(artist,candidate,options);
  if(original.channelType!=='topic'||original.status!=='related_catalog_channel')return original;
  const capture=boundYoutubeCapture(candidate.url,candidate.capture);
  if(!capture)return original;
  const result=(status,reason,extra={})=>({...original,policy:YOUTUBE_LINK_POLICY,status,reason,
    channelType:'topic',channelTypeLabel:'Topic — auto-generated',artistOwned:false,
    reviewSuggestion:status==='supported_topic',verified:false,liveLinkAccepted:false,...extra});
  const known=new Set((artist.accounts??[]).map(a=>youtubeMusicKey(a.url??a.account_url)).filter(Boolean));
  const observed=(capture.body.externalUrls??[]).map(youtubeMusicKey).filter(Boolean);
  const spotify=[...known].filter(k=>k.startsWith('spotify:'));
  if(spotify.length&&observed.some(k=>k.startsWith('spotify:')&&!known.has(k)))
    return result('ownership_conflict','different_observed_spotify_artist_id');
  const agrees=[artist.name,...(artist.aliases??[])].some(a=>name(a)&&name(a)===name(capture.body.displayName));
  const matchingMusic=observed.some(k=>k.startsWith('spotify:')&&known.has(k));
  const sources=new Set((artist.accounts??[]).map(a=>safeUrl(a.url??a.account_url)).filter(Boolean));
  const declaration=(artist.declarations??[]).some(p=>p.status===200&&p.body
    &&p.bodySha256===evidenceDigest(p.body)&&Number.isFinite(Date.parse(p.capturedAt))
    &&sources.has(safeUrl(p.requestedUrl))&&safeUrl(p.body.sourceUrl)===safeUrl(p.requestedUrl)
    &&(p.body.declaredLinks??[]).some(link=>capture.aliases.includes(youtubeOwnershipUrl(link))));
  if(agrees&&(matchingMusic||declaration))return result('supported_topic',
    matchingMusic?'topic_exact_catalog_spotify_id_and_consistent_name':'topic_declared_by_captured_catalog_account_and_consistent_name');
  return result('related_catalog_channel','topic_identity_needs_corroboration');
}
