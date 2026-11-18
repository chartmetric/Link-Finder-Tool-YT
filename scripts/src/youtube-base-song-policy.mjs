import assert from 'node:assert/strict';

export const BASE_SONG_POLICY='distinct_base_songs_v1';
const normalize=s=>String(s??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const key=s=>normalize(s).replace(/[^\p{L}\p{N}]/gu,'');
const descriptor=(s,allowNamed=true)=>{
  const value=normalize(s).replace(/[()[\]{}–—-]/g,' ').replace(/\s+/g,' ').trim();
  return /^(?:(?:super|ultra|extra|extreme|mega|very)\s+)*(?:slowed|slow(?:ed)?\s+down|sped\s*up|speed\s*up|nightcore|daycore)(?:\b.*)?$/u.test(value)||
    /^(?:slowed\s*(?:\+|&|and)\s*reverb|reverb(?:ed)?|instrumental|karaoke|a\s*capp?ella|vocals?\s+only|no\s+vocals?)(?:\b.*)?$/u.test(value)||
    /^(?:extended|radio|original|club|dub|vip|dance|single|album|alternate|alternative|demo)(?:\s+(?:mix|version|edit|cut|instrumental|extended))*$/u.test(value)||
    /^(?:acoustic|unplugged|piano|orchestral|orchestra|string|strings|guitar|instrumental)(?:\s+(?:acoustic|piano|guitar|instrumental|version|edit|mix|session|sessions|live))*$/u.test(value)||
    /^(?:clean|explicit|mono|stereo|8d|bass\s+boosted)(?:\s+(?:version|edit|mix|audio))*$/u.test(value)||
    /^(?:remaster(?:ed)?)(?:\s+(?:\d{4}|version|edition|audio))*$/u.test(value)||
    /^(?:remix(?:ed)?|rework(?:ed)?|bootleg|edit|mix|version)(?:\s+(?:version|edit|mix|\d+)|\s+by\s+.+)*$/u.test(value)||
    /^(?:chopped(?:\s+(?:and|&)\s+screwed)?|lo[- ]?fi|pitch(?:ed)?[- ]+(?:up|down|shifted))(?:\s+(?:version|edit|mix|audio))*$/u.test(value)||
    /^(?:psytrance|hardstyle|phonk|jersey\s+club|techno|hypertechno|trance|house|deep\s+house|slap\s+house|drum\s+and\s+bass|dnb|dubstep)(?:\s+(?:version|edit|mix|remix))*$/u.test(value)||
    /^live(?:\s+(?:at|in|from|on|version|session|sessions|recording|performance|19\d{2}|20\d{2})\b.*)?$/u.test(value)||
    /^(?:19\d{2}|20\d{2})\s+(?:remaster(?:ed)?|mix|edit|version|recording)\b.*$/u.test(value)||
    /^(?:\d+(?:\.\d+)?\s*x(?:\s*speed)?|\d{3}\s*hz)$/u.test(value)||
    allowNamed&&/^.{1,100}\s+(?:remix|mix|edit|rework|bootleg|version)(?:\s+(?:version|edit|mix))?$/u.test(value);
};

function trailingGroup(text){
  const pairs={')':'(',']':'[','}':'{'},end=text.at(-1);
  if(!pairs[end])return null;
  const stack=[];
  for(let i=text.length-1;i>=0;i--){
    const c=text[i];
    if(pairs[c])stack.push(pairs[c]);
    else if('([{'.includes(c)){
      if(stack.pop()!==c)return null;
      if(!stack.length)return {base:text.slice(0,i).trim(),suffix:text.slice(i+1,-1)};
    }
  }
  return null;
}

export function baseSong(value){
  let base=String(value??'').normalize('NFKC').trim();
  const suffixes=[];
  for(let pass=0;pass<32;pass++){
    let found=null;
    const group=trailingGroup(base);
    if(group?.base&&descriptor(group.suffix))found=group;
    if(!found){
      const separators=[...base.matchAll(/\s+[-–—|:/]\s*|[-–—|:/]\s+/gu)].reverse();
      for(const match of separators){
        const before=base.slice(0,match.index).trim(),after=base.slice(match.index+match[0].length).trim();
        if(before&&descriptor(after)){found={base:before,suffix:after};break;}
      }
      if(!found)for(const match of base.matchAll(/[-–—|:/]/gu)){
        const before=base.slice(0,match.index).trim(),after=base.slice(match.index+1).trim();
        if(before&&descriptor(after,false)){found={base:before,suffix:after};break;}
      }
    }
    if(!found){
      // Bare suffixes are allowed, but never erase a standalone song title.
      const suffix=/\s+((?:(?:super|ultra|extra|extreme|mega|very)\s+)*(?:slowed(?:\s*(?:\+|and|&)\s*reverb)?|slowed\s+down|sped\s*up|speed\s*up|nightcore|daycore|remix|instrumental|extended(?:\s+(?:mix|version))?|radio\s+(?:edit|mix)|live|acoustic|unplugged|remaster(?:ed)?(?:\s+\d{4})?|reverb|karaoke|acapella|clean|explicit))\s*$/iu.exec(base);
      if(suffix&&base.slice(0,suffix.index).trim())found={base:base.slice(0,suffix.index).trim(),suffix:suffix[1]};
    }
    if(!found||!key(found.base))break;
    suffixes.push(found.suffix);base=found.base;
  }
  return {base,key:key(base),suffixes};
}
export const baseSongKey=value=>baseSong(value).key;

export function groupBaseSongs(titles){
  assert.ok(Array.isArray(titles)&&titles.every(t=>typeof t==='string'&&baseSongKey(t)),
    'Matched song titles must be a nonempty-string array');
  const groups=new Map();
  for(const title of titles){
    const song=baseSong(title),group=groups.get(song.key)??{key:song.key,base:song.base,titles:[]};
    if(!group.titles.includes(title))group.titles.push(title);
    groups.set(song.key,group);
  }
  return [...groups.values()];
}

export function applyBaseSongCounting(result){
  assert.ok(Array.isArray(result.matchedTracks),'Detailed saved matches are required for future count qualification');
  const titleGroups=groupBaseSongs(result.matchedTracks.map(m=>m.catalogTitle));
  const releaseGroups=groupBaseSongs(result.matchedTracks.filter(m=>
    m.matchedBy?.some(x=>x==='date_within_one_day'||x==='label_phonographic_line')).map(m=>m.catalogTitle));
  const titleCount=titleGroups.length,releaseCount=releaseGroups.length;
  const strongLink=['artist_declared','catalog_channel','youtube_for_artist'].includes(result.evidenceLevel);
  const evidenceLevel=strongLink?result.evidenceLevel:releaseCount>=2?'releases':titleCount>=3?'titles':
    releaseCount?'releases':titleCount?'titles':'name_only';
  const drops=result.confidence==='high'&&!strongLink&&releaseCount<2&&titleCount<3;
  const confidence=drops?(releaseCount>=1||titleCount>=2?'medium':'low'):result.confidence;
  return {...result,evidenceLevel,titleCount,releaseCount,matchedTitles:titleGroups.map(g=>g.titles[0]),
    baseSongPolicy:{id:BASE_SONG_POLICY,titleCount,releaseCount,titleGroups,releaseGroups},
    confidence,status:drops?'review':result.status,
    reviewReason:drops?[result.reviewReason,'insufficient_distinct_base_songs'].filter(Boolean).join(';'):result.reviewReason,
    confidenceReasons:[...(result.confidenceReasons??[]),
      'base_song_policy = '+BASE_SONG_POLICY,
      'distinct_base_title_songs = '+titleCount,'distinct_base_release_songs = '+releaseCount],
  };
}

export function baseSongSubmissionExclusion(row){
  if(row.confidence!=='high')return null;
  const level=row.evidence_level;
  if(!['titles','releases','releases_multi','releases_single_exact'].includes(level))return null;
  const titles=Array.isArray(row.matched_titles)?row.matched_titles:JSON.parse(row.matched_titles);
  const count=groupBaseSongs(titles).length;
  if(count<(level==='titles'?3:['releases','releases_multi'].includes(level)?2:1))return 'insufficient_distinct_base_songs';
  if(['releases','releases_multi'].includes(level)){
    const reasons=String(row.confidence_reasons??'');
    if(!reasons.includes('base_song_policy = '+BASE_SONG_POLICY))return 'missing_base_song_release_count_proof';
    const proof=reasons.match(/distinct_base_release_songs = (\d+)/);
    if(!proof||Number(proof[1])<2)return 'insufficient_distinct_base_release_songs';
  }
  return null;
}
