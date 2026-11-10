// Parse explicitly declared Instagram destinations, not arbitrary @mentions.
// NFKC expands compatibility characters such as the "ffi" ligature.
export function declaredInstagramLinks(value) {
  const text = String(value ?? '').normalize('NFKC');
  const links = [];
  const add = (handle, kind) => {
    if (!/^[a-z0-9._]{1,30}$/i.test(handle)
      || ['p','reel','reels','stories','explore','accounts','tv'].includes(handle.toLowerCase())) return;
    const url = `https://www.instagram.com/${handle.toLowerCase()}/`;
    if (!links.some(x => x.url === url)) links.push({url, kind});
  };
  for (const m of text.matchAll(/(?:^|[\s(])(?:https:\/\/)?(?:www\.|m\.)?instagram\.com\/([a-z0-9._]{1,30})(?=[/?#\s<>"')]|$)/gi)) {
    // An account path, not a post, nested path or deceptive hostname.
    const rest = text.slice(m.index + m[0].length);
    if (/^\/[^\s?#<>"']/.test(rest)) continue;
    add(m[1], 'profile_url');
  }
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_]|公式)(?:instagram|insta|ig)(?:[ \t]*(?:official|公式|公式アカウント))?[ \t]*[:：→⇒\-]?[ \t]*@([a-z0-9._]{1,30})(?![a-z0-9._])/gimu)) {
    add(m[1], 'platform_labeled_handle');
  }
  return links;
}
