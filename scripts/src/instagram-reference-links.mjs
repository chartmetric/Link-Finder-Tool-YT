import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

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

// Offline, first-party reference auditing only. Not a discovery/import policy.

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 1_000_000;
const MAX_TAGS = 20_000;
const MAX_ANCHORS = 1_000;
const hashPattern = /^[a-f0-9]{64}$/;

export const referenceTargets = Object.freeze({
  '207595': {sources: ['https://aimeecarty.com/', 'https://www.aimeecarty.com/'],
    instagram: 'aimee.carty_music', spotify: '4LkmOQU5KA6vZgvJHnpQDl'},
  '226788': {sources: ['https://ernestofficial.com/'],
    instagram: 'ernest', spotify: '4GGfAshSkqoxpZdoaHm7ky'},
  '35092': {sources: ['https://www.theformat.com/'],
    instagram: 'theformat', spotify: '3ZJC8cLts8Q8s8JbNJKsLf'},
});

function safeUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return u;
  } catch { return null; }
}

function decodeAttribute(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
    const key = entity.slice(1, -1).toLowerCase();
    if (key[0] !== '#') return {amp: '&', quot: '"', apos: "'", lt: '<', gt: '>'}[key];
    const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}

function accountLink(href) {
  const u = safeUrl(href);
  if (!u) return null;
  let match;
  if (['instagram.com', 'www.instagram.com'].includes(u.hostname)
      && (match = /^\/([a-z0-9._]{1,30})\/?$/i.exec(u.pathname))) {
    const id = match[1].toLowerCase();
    if (['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'about',
      'developer', 'legal', 'privacy', 'terms', 'share'].includes(id)) return null;
    return {platform: 'instagram', id, url: `https://www.instagram.com/${id}/`};
  }
  if (u.hostname === 'open.spotify.com'
      && (match = /^\/(?:intl-[a-z]{2}\/)?artist\/([a-zA-Z0-9]{22})\/?$/.exec(u.pathname))) {
    return {platform: 'spotify', id: match[1], url: `https://open.spotify.com/artist/${match[1]}`};
  }
  return null;
}

// Bounded HTML tag scanner: only real anchor href attributes, never visible text,
// JS strings, comments, iframe URLs, data-href, or redirect-wrapper query strings.
// No browser execution, requests, redirect following or recursive page discovery.
export function extractReferenceAnchors(html) {
  assert.equal(typeof html, 'string');
  assert.ok(Buffer.byteLength(html) <= MAX_BYTES, 'HTML byte limit exceeded.');
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][a-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  const links = new Map();
  let count = 0, anchors = 0, raw = null, templates = 0;
  for (const token of html.matchAll(tags)) {
    assert.ok(++count <= MAX_TAGS, 'HTML tag limit exceeded.');
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(token[0]);
    if (!tag) continue;
    const closing = !!tag[1], name = tag[2].toLowerCase();
    if (raw) { if (closing && name === raw) raw = null; continue; }
    if (name === 'plaintext' && !closing) break;
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name) && !closing) {
      raw = name; continue;
    }
    if (name === 'template') { templates = Math.max(0, templates + (closing ? -1 : 1)); continue; }
    if (templates || closing || name !== 'a') continue;
    assert.ok(++anchors <= MAX_ANCHORS, 'Anchor limit exceeded.');
    const attributes = token[0].slice(tag[0].length, -1);
    const attr = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const a of attributes.matchAll(attr)) {
      if (a[1].toLowerCase() !== 'href') continue;
      const href = decodeAttribute(a[2] ?? a[3] ?? a[4] ?? '');
      assert.ok(Buffer.byteLength(href) <= 4096, 'Href byte limit exceeded.');
      const link = accountLink(href);
      if (link) {
        const key = `${link.platform}:${link.id}`;
        if (!links.has(key)) links.set(key, {...link, observedHrefs: []});
        const observed = links.get(key).observedHrefs;
        if (!observed.includes(href)) observed.push(href);
      }
      break; // HTML uses the first href, not a later duplicate attribute.
    }
  }
  return [...links.values()];
}

// The target is separately reviewed reference policy, not inferred from page title,
// readable text, an expected social link, or a caller's "firstParty: true" flag.
export function auditReferenceLinks(snapshot, target) {
  assert.ok(target && Array.isArray(target.sources), 'Reviewed reference target required.');
  assert.equal(typeof snapshot.html, 'string');
  assert.match(snapshot.bodySha256, hashPattern);
  assert.equal(sha256(snapshot.html), snapshot.bodySha256, 'Source HTML hash mismatch.');
  assert.ok(typeof snapshot.at === 'string' && Number.isFinite(Date.parse(snapshot.at)), 'Invalid source timestamp.');
  assert.ok(Buffer.byteLength(snapshot.html) <= MAX_BYTES, 'HTML byte limit exceeded.');
  const source = {url: snapshot.url, at: snapshot.at, status: snapshot.status,
    bodySha256: snapshot.bodySha256};
  const base = {source, absenceEstablished: false,
    readableTextState: snapshot.readableText?.trim() ? 'present_not_authoritative' : 'empty_or_unavailable',
    links: [], expected: {instagram: target.instagram, spotify: target.spotify}};
  const url = safeUrl(snapshot.url);
  if (!url || !target.sources.includes(url.href)) return {...base, state: 'source_not_approved'};
  if (snapshot.status !== 200 || snapshot.truncated === true) return {...base, state: 'source_incomplete'};
  const links = extractReferenceAnchors(snapshot.html);
  const matched = Object.fromEntries(['instagram', 'spotify'].map(platform =>
    [platform, links.some(link => link.platform === platform && link.id === target[platform])]));
  return {...base, links, matched,
    state: matched.instagram && matched.spotify ? 'expected_links_found' : 'needs_source_review'};
}
