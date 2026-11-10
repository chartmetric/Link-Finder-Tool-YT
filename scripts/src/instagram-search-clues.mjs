import { instagramProfileUrl } from './musician-instagram-matching.mjs';
import {instagramPostOwnerClues} from './instagram-post-attribution.mjs';

const fold = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Search-result mentions are candidate clues, never ownership evidence. No guessed handles. */
export function instagramSearchCandidates(hits, artist) {
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
  return [...candidates.values()].sort((a,b)=>b.discoveryPriority-a.discoveryPriority);
}
