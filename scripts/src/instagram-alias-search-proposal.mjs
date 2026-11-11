// Compatibility entry for the offline comparison. Future runs explicitly opt
// into the same parser logic; alias clues never become ownership judgments.
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
export {explicitArtistAliasClues} from './instagram-search-clues.mjs';
export function proposedInstagramSearchCandidates(hits,artist){
  return instagramSearchCandidates(hits,artist,{explicitAliases:true});
}
