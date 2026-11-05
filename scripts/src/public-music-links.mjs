import { createHash } from 'node:crypto';
import { referenceUrl } from './musician-instagram-matching.mjs';

const idPattern = /^[A-Za-z0-9]{22}$/;
const decodeEntities = text => text.replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'")
  .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=> {
    const code = n[0].toLowerCase()==='x' ? parseInt(n.slice(1),16) : Number(n);
    return code>0 && code<=0x10ffff ? String.fromCodePoint(code) : '';
  });
const attr = (tag,name) => {
  const match = new RegExp(`(?:\\s|^)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2]) : undefined;
};

export function spotifyContent(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'open.spotify.com' || u.username || u.password || u.port) return null;
    const m = /^\/(?:(?:intl-[a-z]{2}|embed)\/)?(artist|track|album)\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname);
    return m ? {type:m[1],id:m[2],url:`https://open.spotify.com/${m[1]}/${m[2]}`,
      embedUrl:`https://open.spotify.com/embed/${m[1]}/${m[2]}`} : null;
  } catch { return null; }
}

export function musicPageUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || u.search) return null;
    if (['onerpm.link','linktr.ee'].includes(u.hostname) && /^\/[A-Za-z0-9._-]+\/?$/.test(u.pathname)) return u.href;
    if (u.hostname === 'open.spotify.com' && /^\/embed\/(?:artist|track|album)\/[A-Za-z0-9]{22}$/.test(u.pathname)) return u.href;
  } catch { /* Untrusted URL: no request. */ }
  return null;
}

export function isMusicLandingUrl(value) {
  const url = musicPageUrl(value);
  return !!url && new URL(url).hostname !== 'open.spotify.com';
}

function spotifyButtonTarget(href,service) {
  const direct = spotifyContent(href);
  if (direct) return direct.url;
  // OneRPM uses a Feature.fm click wrapper. Decode ONLY its declared Spotify
  // destination; don't execute page JavaScript or call the analytics endpoint.
  if (service !== 'spotify') return null;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' || u.hostname !== 'api.ffm.to' || u.username || u.password || u.port
      || !/^\/sl\/e\/c\/[A-Za-z0-9_-]+$/.test(u.pathname)) return null;
    const encoded = u.searchParams.get('cd');
    if (!encoded || encoded.length>16000 || !/^[A-Za-z0-9_+/=-]+$/.test(encoded)) return null;
    const data = JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
    return spotifyContent(data.destUrl)?.url ?? null;
  } catch { return null; }
}

function scripts(html, match) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap(m => {
    if (!match(m[1])) return [];
    try { return [JSON.parse(m[2])]; } catch { return []; }
  });
}

/** Parse narrowly scoped public evidence. Never return embedded sessions/tokens. */
export function parsePublicMusicPage(sourceUrl, html, {status=200,location}={}) {
  if (!musicPageUrl(sourceUrl)) throw new Error('Unsafe or unsupported music page URL.');
  const base = {sourceUrl,status,bodySha256:createHash('sha256').update(html).digest('hex'),
    externalUrls:[],musicTargets:[]};
  if ([301,302,303,307,308].includes(status)) {
    let target;
    try { target = new URL(location,sourceUrl).href; } catch { /* invalid redirect */ }
    const content = spotifyContent(target);
    const redirectUrl = content ? content.embedUrl : musicPageUrl(target);
    if (!redirectUrl) throw new Error('Unsafe music-page redirect; not followed.');
    return {...base,redirectUrl};
  }
  if (status<200 || status>=300) throw new Error(`Public music page unavailable (HTTP ${status}).`);
  const expected = spotifyContent(sourceUrl);
  if (expected) {
    const payload = scripts(html,tag=>attr(tag,'id')==='__NEXT_DATA__')[0];
    const entity = payload?.props?.pageProps?.state?.data?.entity;
    if (!entity || entity.uri !== `spotify:${expected.type}:${expected.id}` || entity.type !== expected.type) {
      return {...base,reason:'Spotify response does not bind to requested content identity.'};
    }
    const artistUri = uri => {
      const m = /^spotify:artist:([A-Za-z0-9]{22})$/.exec(String(uri));
      return m ? `https://open.spotify.com/artist/${m[1]}` : null;
    };
    const artists = entity.type==='artist' ? [artistUri(entity.uri)]
      : Array.isArray(entity.artists) ? entity.artists.map(a=>artistUri(a.uri)) : [];
    const artistUrls = artists.length && artists.every(Boolean) ? [...new Set(artists)] : [];
    const singleTrack = entity.type==='album' && entity.trackList?.length===1
      ? /^spotify:track:([A-Za-z0-9]{22})$/.exec(entity.trackList[0].uri)?.[1] : undefined;
    return {...base,contentUrl:expected.url,contentType:entity.type,
      creditedArtistUrls:artistUrls,
      // A multi-artist recording is association, not sufficient sole-ownership evidence.
      externalUrls:artistUrls.length===1 ? artistUrls : [],
      musicTargets:artistUrls.length===0 && singleTrack && idPattern.test(singleTrack)
        ? [`https://open.spotify.com/track/${singleTrack}`] : [],
      reason:artistUrls.length>1 ? 'Multiple credited artists; ownership remains ambiguous.'
        : !artistUrls.length && !singleTrack ? 'No exact credited artist identity in bounded public metadata.' : undefined};
  }
  const targets = [];
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0],'href');
    if (!href) continue;
    const target = spotifyButtonTarget(href,attr(m[0],'service'));
    if (target) targets.push(target);
    const youtube = referenceUrl(href,'youtube');
    if (youtube) base.externalUrls.push(youtube);
  }
  if (new URL(sourceUrl).hostname==='linktr.ee') {
    for (const data of scripts(html,tag=>attr(tag,'id')==='__NEXT_DATA__')) {
      for (const link of data.props?.pageProps?.links ?? []) {
        const target = spotifyContent(link.url);
        if (target) targets.push(target.url);
      }
    }
  }
  return {...base,musicTargets:[...new Set(targets)],
    externalUrls:[...new Set([...base.externalUrls,...targets.filter(u=>spotifyContent(u)?.type==='artist')])]};
}

/** Each readPage call is ONE separately admitted HTTP request, including redirects.
 * Existing one-page manifests are not expanded; a further read can fail its budget. */
export async function resolveMusicEvidence({candidate,catalog,readPage,maxPages=4}) {
  if (!Number.isInteger(maxPages) || maxPages<1 || maxPages>4) throw new Error('Music evidence path must allow 1–4 pages.');
  const sourceUrl = (candidate.externalUrls ?? []).find(isMusicLandingUrl);
  const evidence = {sourceUrl,pages:[],externalUrls:[],status:'unresolved',ownershipConfirmed:false};
  if (!sourceUrl) return {...evidence,reason:'No supported source-linked music landing page.'};
  let next = sourceUrl;
  const seen = new Set();
  try {
    while (next && evidence.pages.length < maxPages) {
      if (!musicPageUrl(next) || seen.has(next)) throw new Error('Unsafe URL or loop in music evidence path.');
      seen.add(next);
      const page = await readPage(next);
      if (page.sourceUrl !== next) throw new Error('Public page evidence is not bound to the requested source.');
      evidence.pages.push(page);
      if (page.externalUrls?.includes(catalog.url)) {
        evidence.externalUrls = [catalog.url];
        evidence.status = 'exact_catalog_music_identity';
        return evidence; // Still requires independent ownership/JEV assessment.
      }
      if (page.creditedArtistUrls?.length) {
        evidence.reason = page.creditedArtistUrls.length>1 ? 'Multiple credited artists; not sole ownership.'
          : 'Credited music artist differs from the catalog reference.';
        return evidence;
      }
      next = page.redirectUrl ?? (page.musicTargets?.[0] ? spotifyContent(page.musicTargets[0])?.embedUrl : undefined);
    }
    evidence.reason = next ? 'Public music-page limit reached.' : 'No exact catalog artist ID in the checked music path.';
  } catch (error) { evidence.reason = error.message; }
  return evidence;
}
