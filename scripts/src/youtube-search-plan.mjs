// Pure discovery preparation/ranking. No providers, approval changes or ownership decisions.
import {youtubeSearchNames} from './youtube-music-search.mjs';
const same=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
const text=v=>typeof v==='string'?v.normalize('NFC').trim().replace(/\s+/gu,' '):'';
const folded=v=>text(v).toLocaleLowerCase('und');
const quote=v=>'"'+text(v).replace(/["\\]/gu,' ').replace(/\s+/gu,' ')+'"';
const bound=(a,r)=>same(a.profileId,r?.profile_id)&&same(a.cmArtist,r?.cm_artist);
function contains(haystack,needle){
  const h=folded(haystack),n=folded(needle);
  if(!n)return false;
  let at=h.indexOf(n);
  while(at!==-1){
    const before=[...h.slice(0,at)].at(-1)??'',after=[...h.slice(at+n.length)][0]??'';
    if(!/[\p{L}\p{N}]/u.test(before)&&!/[\p{L}\p{N}]/u.test(after))return true;
    at=h.indexOf(n,at+1);
  }
  return false;
}
export function youtubeSearchPlan(artist){
  if(!text(artist.name)||!bound(artist,artist.catalogProfile))
    throw Error('Search context must match the exact catalog profile and cm_artist.');
  const provenance={profileId:String(artist.profileId),cmArtist:String(artist.cmArtist)};
  const names=[{value:text(artist.name),kind:'catalog_name',source:'new_vertical.profile',...provenance}];
  function addName(value,kind,source,extra={}){
    value=text(value);
    if(value&&value.length<=120&&!names.some(n=>folded(n.value)===folded(value)))
      names.push({value,kind,source,...provenance,...extra});
  }
  const cm=artist.context?.chartmetric;
  if(same(artist.cmArtist,cm?.cm_artist))
    addName(cm.name,'catalog_alternate_name','new_vertical.cm_artist');
  // Preserve incoming bound Spotify display-name context and its source hash.
  for(const row of youtubeSearchNames(artist)){
    if(row.source==='bound_catalog_spotify_name')
      addName(row.name,'catalog_alternate_name',row.source,
        {accountId:row.accountId,sourceRecordSha256:row.sourceRecordSha256});
  }
  // Explicit, sourced aliases only. Never derive translations, spelling corrections,
  // or aliases from provider suggestions, snippets or similar-looking names.
  for(const alias of artist.aliases??[]){
    if(bound(artist,alias)&&text(alias.source)&&text(alias.sourceRecordId))
      addName(alias.value,'declared_alias',alias.source,{sourceRecordId:alias.sourceRecordId});
  }
  const accounts=(artist.accounts??[]).filter(a=>bound(artist,a));
  for(const a of accounts){
    // Opaque Spotify IDs and other platform usernames are not artist aliases.
    if(a.platform==='lastfm'&&/^https:\/\/www\.last\.fm\/music\//u.test(a.account_url??''))
      addName(a.handle,'catalog_account_handle_not_confirmed_alias',a.source??'catalog_account',
        {accountId:a.account_id,sourceUrl:a.account_url});
  }
  const context=[];
  const addContext=(value,kind,source)=>{
    if(text(value)&&!context.some(c=>c.kind===kind&&folded(c.value)===folded(value)))
      context.push({value:text(value),kind,source,...provenance});
  };
  if(same(artist.cmArtist,cm?.cm_artist)){
    addContext(cm.label,'label','new_vertical.cm_artist');
    addContext(cm.record_label,'label','new_vertical.cm_artist');
    addContext(cm.code2,'country','new_vertical.cm_artist');
  }
  // Flat discovery metadata is already bound to both catalog identifiers.
  for(const key of ['country','label','record_label'])
    addContext(artist.catalogProfile[key],key==='country'?'country':'label','bound_catalog_metadata');
  const spotifyIds=new Set(accounts.filter(a=>a.platform==='spotify').flatMap(a=>{
    try{const u=new URL(a.account_url);return u.origin==='https://open.spotify.com'&&
      /^\/artist\/[A-Za-z0-9]{22}\/?$/u.test(u.pathname)?[u.pathname.split('/')[2]]:[];}catch{return [];}
  }));
  for(const r of artist.releases??[]){
    if(same(artist.cmArtist,r.cm_artist)||spotifyIds.has(r.spotify_artist_id)){
      addContext(r.track_name,'release',r.source??'bound_catalog_release');
      addContext(r.album_name,'release',r.source??'bound_catalog_release');
    }
  }
  // One request, ten organic results, with at most two sourced alternate names.
  // Context is a ranking hint rather than a mandatory term that hides sparse artists.
  const queryNames=names.slice(0,3);
  const exact=queryNames.length===1?quote(queryNames[0].value):
    '('+queryNames.map(n=>quote(n.value)).join(' OR ')+')';
  return {version:1,...provenance,names,queryNames,context,
    request:{q:`${exact} (music OR musician OR songs OR band) YouTube channel site:youtube.com`,num:10},
    ownershipWarning:'Search relevance is not ownership evidence; aliases and translations may remain ambiguous.'};
}
export function rankYoutubeSearchCandidates(candidates,plan,{limit=10}={}){
  if(!Number.isInteger(limit)||limit<0||limit>10)throw Error('Candidate limit must remain within ten search results.');
  const ranked=candidates.map((candidate,index)=>{
    const haystack=`${candidate.title} ${candidate.snippet}`;
    const header=String(candidate.title??'').replace(/\s*[-|]\s*YouTube\s*$/iu,'')
      .replace(/\s*[-|]?\s*(official(?: channel)?|topic)\s*$/iu,'').trim();
    const compact=v=>folded(v).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'');
    const matches=plan.names.filter(n=>contains(haystack,n.value)||
      (compact(n.value)&&compact(header)===compact(n.value)));
    const canonical=matches.some(n=>n.kind==='catalog_name');
    const music=/\b(music|musician|songs?|singer|band|album|records?|rapper|audio|vevo)\b/iu.test(haystack);
    const visualArt=/\b(painting|painter|drawing|drawings|sketching|art instruction|art instructor|portrait artist|how to draw|how to paint|paint along)\b/iu.test(haystack);
    const topic=/[-–—]\s*Topic(?:\s*[-|]\s*YouTube)?\s*$/iu.test(candidate.title)||
      /auto[- ]generated by youtube/iu.test(candidate.snippet);
    const contextMatches=plan.context.filter(c=>contains(haystack,c.value));
    // Do not reject unmatched foreign-language names or possible aliases. Only
    // clear non-music visual-art results without any name match are off-target.
    const bucket=topic?'topic':visualArt&&!music&&!matches.length?'off_target':
      matches.length?'name_match':'ambiguous';
    const score=(canonical?100:matches.length?70:0)+(music?15:0)+
      Math.min(20,contextMatches.filter(c=>c.kind!=='country').length*5);
    return {...candidate,relevance:{bucket,score,originalRank:index+1,
      matchedNames:matches,contextMatches,musicSignal:music,visualArtSignal:visualArt,
      ambiguity:!matches.length?'Possible alias or translation; identity unresolved.':null,
      ownershipProven:false}};
  }).sort((a,b)=>b.relevance.score-a.relevance.score||a.relevance.originalRank-b.relevance.originalRank);
  const ordinary=ranked.filter(c=>!['topic','off_target'].includes(c.relevance.bucket));
  const topicCandidates=ranked.filter(c=>c.relevance.bucket==='topic');
  const offTargetCandidates=ranked.filter(c=>c.relevance.bucket==='off_target');
  return {allSearchCandidates:ranked,candidates:ordinary.slice(0,limit),topicCandidates,offTargetCandidates,
    searchStatus:ranked.length?'candidates_found':'no_match',
    channelAbsenceProven:false,
    outcome:ordinary.length?'unverified_candidates':topicCandidates.length?'topic_only':
      ranked.length?'off_target_results_only':'no_channel_result_in_recorded_search'};
}
