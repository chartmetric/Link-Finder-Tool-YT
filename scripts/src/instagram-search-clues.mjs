import { instagramProfileUrl } from './musician-instagram-matching.mjs';
import {instagramPostOwnerClues} from './instagram-post-attribution.mjs';

const fold = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Search-result mentions are candidate clues, never ownership evidence. No guessed handles. */
export function instagramSearchCandidates(hits, artist, {explicitAliases=false,savedCandidates=null}={}) {
  const candidates = new Map();
  for (const hit of hits) {
    let source;
    try {
      source = new URL(hit.link);
      if (source.protocol !== 'https:' || source.username || source.password || source.port
        || !['instagram.com','www.instagram.com','m.instagram.com'].includes(source.hostname)) continue;
    } catch { continue; }
    const direct = instagramProfileUrl(source.href);
    const text = `${hit.title ?? ''} ${hit.snippet ?? ''}`;
    const found = [];
    if (direct) found.push([direct, 'direct_profile']);
    else {
      const parts = source.pathname.split('/').filter(Boolean);
      const ownerClues=instagramPostOwnerClues(source.href,hit.snippet);
      if (ownerClues.urlOwner) {
        found.push([instagramProfileUrl(`https://www.instagram.com/${ownerClues.urlOwner}/`), 'post_url_owner']);
      }
      if (['p','reel','reels','tv','popular'].includes(parts[0]) || ownerClues.isPost) {
        for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}._@])@([a-z0-9._]{1,30})(?![a-z0-9._])/giu)) {
          const handle = m[1].replace(/[.]+$/, '');
          if (!/^www\./i.test(handle)) found.push([instagramProfileUrl(`https://www.instagram.com/${handle}/`), 'post_mention']);
        }
        for (const m of text.matchAll(/(?:https:\/\/)?(?:www\.)?instagram\.com\/([a-z0-9._]{1,30})(?=[/?#\s"'<>]|$)/gi)) {
          found.push([instagramProfileUrl(`https://www.instagram.com/${m[1]}/`), 'post_profile_link']);
        }
        if (ownerClues.captionOwner) found.push([instagramProfileUrl(`https://www.instagram.com/${ownerClues.captionOwner}/`), 'post_caption_owner']);
      }
    }
    for (const [url,kind] of found) {
      if (!url) continue;
      const handle = new URL(url).pathname.split('/')[1];
      // Retrieval priority only: this does NOT change identityComparison or verification scores.
      const nameMatchesHandle = fold(handle) === fold(artist) && fold(artist).length > 3;
      const priority = (kind === 'direct_profile' ? 20 : 0) + (nameMatchesHandle ? 100 : 0);
      const evidence = {kind,sourceUrl:source.href,title:hit.title,snippet:hit.snippet,
        ...(hit.date?{date:hit.date}:{}),...(hit.observedAt?{observedAt:hit.observedAt}:{}),ownershipConfirmed:false};
      const existing = candidates.get(url);
      if (existing) {
        existing.discoveryEvidence.push(evidence);
        existing.discoveryPriority = Math.max(existing.discoveryPriority,priority);
      } else candidates.set(url,{url,title:kind === 'direct_profile' ? hit.title : `Unverified search clue: @${handle}`,
        snippet:hit.snippet,methods:['serper'],discoveryEvidence:[evidence],discoveryPriority:priority});
    }
  }
  if(explicitAliases){
    const aliasHits=[...hits];
    if(savedCandidates!==null){
      if(!Array.isArray(savedCandidates))throw Error('Invalid saved alias-candidate pool');
      const seenHits=new Set();
      const kinds=new Set(['direct_profile','post_mention','post_profile_link','post_caption_owner','post_url_owner']);
      for(const candidate of savedCandidates){
        const url=instagramProfileUrl(candidate.url);if(!url)continue;
        if(candidate.discoveryEvidence!=null&&!Array.isArray(candidate.discoveryEvidence))
          throw Error('Invalid saved search provenance');
        const evidence=candidate.discoveryEvidence??[];
        const existing=candidates.get(url);
        if(existing)existing.discoveryEvidence.push(...evidence);
        else candidates.set(url,{...candidate,url,discoveryEvidence:[...evidence]});
        // Reuse only retained search-result provenance; never invent a source
        // by pairing a candidate URL with an unrelated snippet.
        for(const e of evidence){
          if(!kinds.has(e.kind)||!e.sourceUrl)continue;
          const hit={link:e.sourceUrl,title:e.title,snippet:e.snippet,date:e.date,observedAt:e.observedAt};
          const key=JSON.stringify(hit);
          if(!seenHits.has(key)){seenHits.add(key);aliasHits.push(hit);}
        }
      }
    }
    for(const hit of aliasHits)for(const evidence of explicitArtistAliasClues(hit,artist)){
      const existing=candidates.get(evidence.url);
      if(existing){
        if(!existing.discoveryEvidence.some(e=>e.kind===evidence.kind&&e.sourceUrl===evidence.sourceUrl
          &&e.sourceField===evidence.sourceField&&e.snippet===evidence.snippet))
          existing.discoveryEvidence.push(evidence);
        existing.discoveryPriority=Math.max(existing.discoveryPriority??0,60);
      }else{
        candidates.set(evidence.url,{url:evidence.url,
          title:`Unverified explicit alias clue: @${new URL(evidence.url).pathname.split('/')[1]}`,
          snippet:hit.snippet,methods:['serper'],discoveryEvidence:[evidence],discoveryPriority:60});
      }
    }
  }
  return [...candidates.values()].sort((a,b)=>(b.discoveryPriority??0)-(a.discoveryPriority??0));
}

const aliasName=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'')
  .toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const escapeAlias=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Explicit search aliases are unverified retrieval clues, never ownership proof. */
export function explicitArtistAliasClues(hit,artist){
  let source;
  try{
    source=new URL(hit.link);
    if(source.protocol!=='https:'||source.username||source.password||source.port
      ||!['instagram.com','www.instagram.com','m.instagram.com'].includes(source.hostname))return [];
  }catch{return [];}
  const name=aliasName(artist);if(!name)return [];
  const forward=new RegExp('(?:^| )'+escapeAlias(name)+'(?: s)? (?:a k a|aka|also known as|alias)$','u');
  const reverse=new RegExp('^(?:a k a|aka|also known as|alias) '+escapeAlias(name)+'(?: |$)','u');
  const clues=[],seen=new Set();
  for(const field of ['title','snippet']){
    const text=String(hit[field]??'');
    for(const match of text.matchAll(/(?:^|[^\p{L}\p{N}._@])@([a-z0-9._]{1,30})(?![a-z0-9._])/giu)){
      const handle=match[1].replace(/[.]+$/,'');
      const at=match.index+match[0].indexOf('@');
      const before=text.slice(Math.max(0,at-200),at);
      const after=text.slice(at+1+match[1].length,at+1+match[1].length+200);
      const direction=forward.test(aliasName(before))?'artist_then_alias':
        reverse.test(aliasName(after))?'alias_then_artist':null;
      const url=instagramProfileUrl(`https://www.instagram.com/${handle}/`);
      if(!direction||!url||seen.has(url+':'+field))continue;
      seen.add(url+':'+field);
      clues.push({url,kind:'explicit_artist_alias',sourceUrl:source.href,sourceField:field,
        title:hit.title,snippet:hit.snippet,artistName:artist,aliasDirection:direction,
        ...(hit.date?{date:hit.date}:{}),...(hit.observedAt?{observedAt:hit.observedAt}:{}),
        ownershipConfirmed:false,
        note:'Unverified search alias relation. Not captured account metadata or ownership proof.'});
    }
  }
  return clues;
}
