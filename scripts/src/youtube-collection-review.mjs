// Offline review proposal only. Deliberately not imported by workers or live policy.
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {parseArtistRepresentationResponse} from './youtube-artist-representation.mjs';

export const COLLECTION_REVIEW_VERSION='youtube-collection-ambiguity-review-v1';
const normalizedName=value=>String(value??'').normalize('NFKC').toLowerCase()
  .replace(/\s*[-–—]\s*topic\s*$/iu,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

function collectionHelpLink(value){
  try{
    const u=new URL(value);
    return u.protocol==='https:'&&u.hostname==='support.google.com'
      &&!u.username&&!u.password&&!u.port&&/^\/youtube\/answer\/2579942\/?$/.test(u.pathname);
  }catch{return false;}
}

// The help article concerns auto-generated channels; it does NOT by itself
// distinguish an artist Topic page from a release collection. Search wording,
// generic verification and absent badge fields cannot supply that distinction.
export function collectionChannelEvidence(artist,candidateUrl,capture){
  const bound=boundYoutubeCapture(candidateUrl,capture);
  if(!bound)return {status:'unbound_capture',ambiguous:true,evidence:[]};
  const body=bound.body,evidence=[];
  for(const [i,url] of (body.externalUrls??[]).entries())
    if(collectionHelpLink(url))evidence.push({
      sourcePath:`candidate.channelCapture.body.externalUrls[${i}]`,value:url,
      meaning:'auto_generated_channel_help_not_artist_identity',
    });
  const channelName=normalizedName(body.displayName);
  const artistNameMatches=[artist.name,...(artist.aliases??[])]
    .some(value=>normalizedName(value)&&normalizedName(value)===channelName);
  const releaseMatches=(artist.releases??[]).flatMap((release,i)=>
    channelName&&normalizedName(release.track_name)===channelName
      ?[{sourcePath:`artist.releases[${i}].track_name`,value:release.track_name,
        meaning:'release_title_match_not_artist_identity'}]:[]);
  const ambiguous=evidence.length>0&&!artistNameMatches;
  return {
    status:ambiguous?'release_collection_or_unresolved_auto_generated_channel':
      artistNameMatches?'artist_name_consistent_not_identity_proof':'channel_type_unresolved',
    ambiguous,artistNameMatches,
    evidence:[{sourcePath:'candidate.channelCapture.body.displayName',value:body.displayName,
      meaning:'captured_channel_title'},...evidence,...releaseMatches],
    bodySha256:bound.bodySha256,aliases:bound.aliases,
    searchEvidenceUsedForChannelIdentity:false,
    establishesIdentity:false,establishesOwnership:false,
  };
}

// Parse the original bound answer first. This is a separate derived review, not
// a rewrite of the receipt, request, existing parser, or historical suggestion.
export function reviewCollectionRepresentation(proposal,packet,safetyOptions={}){
  const result=parseArtistRepresentationResponse(proposal,packet,safetyOptions);
  const state=proposal.request.body.state;
  const collectionReview=collectionChannelEvidence(state.artist,state.candidate.url,
    proposal.originalCapture);
  const hold=collectionReview.ambiguous;
  const suppress=hold&&result.decision.reviewSuggestion;
  return {...result,collectionReview:{version:COLLECTION_REVIEW_VERSION,...collectionReview},
    decision:suppress?{...result.decision,status:'experimental_safety_hold',
      reason:'release_collection_channel_identity_unresolved',reviewSuggestion:false}:result.decision,
    channelTypeLabel:hold?'Unresolved — release collection or artist channel':result.channelTypeLabel,
    reviewOnly:true,executionEnabled:false,requiresFreshSpendingApproval:true,
    policyActivated:false,ownershipAccepted:false,importEligible:false,catalogWritten:false};
}
