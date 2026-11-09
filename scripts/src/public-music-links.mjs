import { createHash } from 'node:crypto';
import { referenceUrl } from './musician-instagram-matching.mjs';
import {albumCreditEvidence} from './catalog-album-evidence.mjs';

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
    // URL normalizes dot segments before pathname validation. Reject the raw
    // traversal syntax instead of allowing it to become an innocent-looking slug.
    const rawPath=/^https:\/\/[^/?#]+([^?#]*)/i.exec(String(value))?.[1] ?? '';
    if(String(value).includes('\\') || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)) return null;
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const spotify = spotifyContent(u.href);
    if (spotify) return spotify.embedUrl;
    const parts = u.pathname.split('/').filter(Boolean);
    const slug = /^[A-Za-z0-9._-]{1,120}$/;
    const oneOrTwo = parts.length >= 1 && parts.length <= 2 && parts.every(part => slug.test(part));
    if (['onerpm.link','linktr.ee','hyperfollow.com','bfan.link','lnk.to'].includes(u.hostname)
      && oneOrTwo) return `${u.origin}/${parts.join('/')}`;
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lnk\.to$/.test(u.hostname)
      && oneOrTwo) return `${u.origin}/${parts.join('/')}`;
    if (u.hostname === 'distrokid.com' && parts.length >= 2 && parts.length <= 4
      && parts[0].toLowerCase() === 'hyperfollow' && parts.slice(1).every(part => slug.test(part))) {
      return `${u.origin}/${parts.join('/')}`;
    }
    if (u.hostname === 'paa.ge' && oneOrTwo) return `${u.origin}/${parts.join('/')}`;
    if ((u.hostname === 'komi.io' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.komi\.io$/.test(u.hostname))
      && parts.length <= 1 && parts.every(part => slug.test(part))) return `${u.origin}/${parts.join('/')}`;
    if (['youtube.com','www.youtube.com','music.youtube.com'].includes(u.hostname)) {
      if (parts.length === 1 && parts[0] === 'watch') {
        const id = u.searchParams.get('v');
        if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
      }
      if (parts.length === 2 && ['embed','shorts'].includes(parts[0])
        && /^[A-Za-z0-9_-]{11}$/.test(parts[1])) return `https://www.youtube.com/watch?v=${parts[1]}`;
    }
    if (u.hostname === 'youtu.be' && parts.length === 1 && /^[A-Za-z0-9_-]{11}$/.test(parts[0])) {
      return `https://www.youtube.com/watch?v=${parts[0]}`;
    }
  } catch { /* Untrusted URL: no request. */ }
  return null;
}

export function isMusicLandingUrl(value) {
  const url = musicPageUrl(value);
  if (!url) return false;
  const content = spotifyContent(url);
  return !content || content.type !== 'artist';
}

/** Only observed bio links may seed a path, never previously derived artist URLs.
 * Spotify album/track shares use the same canonical embed reads as hub targets. */
export function musicEvidenceSources(candidate) {
  const direct = candidate.directExternalUrls
    ?? (candidate.externalLinkEvidence ? [] : candidate.externalUrls ?? []);
  return [...new Set(direct.map(value => isMusicLandingUrl(value) ? musicPageUrl(value) : null).filter(Boolean))];
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

function youtubeChannelIds(html) {
  const found = new Set();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (/itemprop\s*=\s*["']channelId["']/i.test(tag)) {
      const id = attr(tag, 'content');
      if (/^UC[A-Za-z0-9_-]{22}$/.test(id ?? '')) found.add(`https://www.youtube.com/channel/${id}`);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/itemprop\s*=\s*["']url["']/i.test(tag)) continue;
    const href = attr(tag, 'href');
    const channel = referenceUrl(href, 'youtube');
    if (channel) found.add(channel);
  }
  return [...found];
}

/** Parse narrowly scoped public evidence. Never return embedded sessions/tokens. */
export function parsePublicMusicPage(sourceUrl, html, {status=200,location}={}) {
  if (!musicPageUrl(sourceUrl)) throw new Error('Unsafe or unsupported music page URL.');
  const base = {sourceUrl,status,bodySha256:createHash('sha256').update(html).digest('hex'),
    externalUrls:[],musicTargets:[],linkEvidence:[]};
  if ([301,302,303,307,308].includes(status)) {
    let target;
    try { target = new URL(location,sourceUrl).href; } catch { /* invalid redirect */ }
    const content = spotifyContent(target);
    const redirectUrl = content ? content.embedUrl : musicPageUrl(target);
    if (!redirectUrl) throw new Error('Unsafe music-page redirect; not followed.');
    return {...base,redirectUrl,linkEvidence:[{sourceUrl,targetUrl:redirectUrl,kind:'http_redirect'}]};
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
      : Array.isArray(entity.artists) ? entity.artists.map(a=>artistUri(a?.uri)) : [];
    const artistUrls = artists.length && artists.every(Boolean) ? [...new Set(artists)] : [];
    // Album embeds can omit `artists` yet explicitly declare the artist URI
    // related to this exact album. Keep this relation distinct from credits and
    // never let it override explicit multiple/invalid artist credits.
    const relatedArtist=entity.type==='album'&&(!Array.isArray(entity.artists)||entity.artists.length===0)
      ? artistUri(entity.relatedEntityUri):null;
    const relatedArtistUrls=relatedArtist?[relatedArtist]:[];
    const singleTrack = entity.type==='album' && entity.trackList?.length===1
      ? /^spotify:track:([A-Za-z0-9]{22})$/.exec(entity.trackList[0].uri)?.[1] : undefined;
    return {...base,contentUrl:expected.url,contentType:entity.type,
      creditedArtistUrls:artistUrls,
      relatedArtistUrls,
      // A multi-artist recording is association, not sufficient sole-ownership evidence.
      // A generic "related" artist is association, not a sole credited artist.
      // Retain it for diagnostics without satisfying the exact-link gate.
      externalUrls:artistUrls.length===1 ? artistUrls : [],
      musicTargets:artists.length===0 && singleTrack && idPattern.test(singleTrack)
        ? [`https://open.spotify.com/track/${singleTrack}`] : [],
      reason:artistUrls.length>1 ? 'Multiple credited artists; ownership remains ambiguous.'
        : relatedArtist ? 'Exact album declares a related artist ID; account ownership remains unassessed.'
        : !artistUrls.length && !singleTrack ? 'No exact credited artist identity in bounded public metadata.' : undefined};
  }
  const targets = [];
  const host=new URL(sourceUrl).hostname;
  const linktree=host==='linktr.ee';
  const landingHost=['komi.io','lnk.to','hyperfollow.com','distrokid.com','paa.ge','bfan.link'].includes(host)
    || host.endsWith('.komi.io') || host.endsWith('.lnk.to');
  const addTarget=(value,kind,service)=>{
    if(!value || value.startsWith('#')) return;
    let href;
    try { href=new URL(value,sourceUrl).href; } catch { return; }
    const target=spotifyButtonTarget(href,service) ?? musicPageUrl(href);
    const youtube=referenceUrl(href,'youtube');
    if(target) targets.push(target);
    if(youtube) base.externalUrls.push(youtube);
    for(const targetUrl of new Set([target,youtube].filter(Boolean))) {
      if(!base.linkEvidence.some(edge=>edge.targetUrl===targetUrl&&edge.kind===kind)) {
        base.linkEvidence.push({sourceUrl,targetUrl,kind});
      }
    }
  };
  // Inert content is not a rendered profile link. In particular, JSON strings,
  // comments and script templates must not masquerade as source-linked anchors.
  const markup=html.replace(/<!--[\s\S]*?(?:-->|$)/g,'')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  // Whole-page Linktree anchors include navigation and promoted OTHER profiles.
  // Only its declared profile-link records below can seed identity paths.
  for (const m of linktree?[]:markup.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0],'href');
    if (href) addTarget(href,'anchor',attr(m[0],'service'));
    // Linkfire service buttons can declare their outbound URL in data-link.
    // Only an explicit Spotify button is eligible; never decode click scripts,
    // arbitrary JSON, analytics endpoints or generic redirect query strings.
    if(landingHost && attr(m[0],'data-service')==='spotify') {
      const destination=attr(m[0],'data-link');
      const spotify=spotifyContent(destination);
      if(spotify) addTarget(spotify.url,'spotify_service_button');
    }
  }
  if(landingHost) {
    for(const m of markup.matchAll(/<iframe\b[^>]*>/gi)) {
      const src=attr(m[0],'src');
      const content=spotifyContent(src);
      if(content && new URL(src).pathname.startsWith('/embed/')) {
        addTarget(content.url,'spotify_embed');
      }
    }
  }
  if (linktree) {
    for (const data of scripts(html,tag=>attr(tag,'id')==='__NEXT_DATA__')) {
      // Linktree groups can contain another declared links array. Inspect only
      // these link records, not unrelated recommendation/session JSON.
      const pending=[...(Array.isArray(data.props?.pageProps?.links)?data.props.pageProps.links:[])];
      let inspected=0;
      while(pending.length&&inspected++<100) {
        const link=pending.shift();
        if(!link||typeof link!=='object') continue;
        if(typeof link.url==='string') addTarget(link.url,'declared_profile_link');
        if(Array.isArray(link.links)) pending.push(...link.links.slice(0,100-inspected));
      }
    }
  }
  const youtubeVideo = ['youtube.com','www.youtube.com','music.youtube.com'].includes(new URL(sourceUrl).hostname)
    && /\/watch\?v=/.test(sourceUrl);
  if (youtubeVideo) base.externalUrls.push(...youtubeChannelIds(html));
  const uniqueTargets = [...new Set(targets)];
  return {...base,musicTargets:uniqueTargets,
    creditedArtistUrls:youtubeVideo ? youtubeChannelIds(html) : [],
    externalUrls:[...new Set([...base.externalUrls,
      ...uniqueTargets.filter(u=>spotifyContent(u)?.type==='artist')])]};
}

/** Each readPage call is ONE separately admitted HTTP request, including redirects.
 * Existing one-page manifests are not expanded; a further read can fail its budget. */
export async function resolveMusicEvidence({candidate,catalog,readPage,lookupAlbum,maxPages=4}) {
  if (!Number.isInteger(maxPages) || maxPages<0 || maxPages>4 || (maxPages===0&&!lookupAlbum)) {
    throw new Error('Music evidence path must allow 1–4 pages, or zero public pages for catalog-only work.');
  }
  // Previously derived artist URLs cannot become independent starting evidence.
  const sourceUrls = musicEvidenceSources(candidate);
  const sourceUrl = sourceUrls[0];
  const evidence = {sourceUrl,sourceUrls,pages:[],attempts:[],externalUrls:[],status:'unresolved',ownershipConfirmed:false};
  if (!sourceUrl) return {...evidence,reason:'No supported source-linked music landing page or release.'};
  const seen = new Set();
  const queue = sourceUrls.map(url => ({url,linkedFrom:null}));
  let catalogAttempts=0,pageLimitReached=false;
  try {
    while (queue.length) {
      const {url,linkedFrom} = queue.shift();
      if (!musicPageUrl(url) || seen.has(url)) continue;
      seen.add(url);
      if(lookupAlbum&&spotifyContent(url)?.type==='album'&&catalogAttempts<4) {
        catalogAttempts++;
        try {
          const credit=albumCreditEvidence(url,await lookupAlbum(url),catalog);
          (evidence.catalogAlbums??=[]).push({...credit,linkedFrom});
          if(credit.status==='exact_catalog_music_identity') {
            evidence.externalUrls=[catalog.url];
            evidence.status='exact_catalog_music_identity';
            return evidence;
          }
          evidence.reason=credit.reason;
          // A conflicting/missing catalog relationship cannot be filtered away
          // or replaced by names or a conveniently selected album track.
          continue;
        }catch {
          (evidence.catalogLookupErrors??=[]).push({albumUrl:spotifyContent(url).url,
            reason:'Catalog lookup unavailable; no account-absence inference.'});
          // Existing separately bounded public evidence remains an alternative.
        }
      }
      if(evidence.attempts.length>=maxPages) {pageLimitReached=true;continue;}
      const attempt={sourceUrl:url,linkedFrom,status:'started'};
      evidence.attempts.push(attempt);
      let page;
      try {page=await readPage(url);}
      catch(error) {
        attempt.status='failed';
        attempt.reason=error.message;
        continue; // An unavailable branch must not hide other source-linked paths.
      }
      if (page.sourceUrl !== url) throw new Error('Public page evidence is not bound to the requested source.');
      attempt.status='returned';
      evidence.pages.push({...page,linkedFrom});
      const exactTarget = [...(page.externalUrls ?? []),...(page.musicTargets ?? [])]
        .some(value => referenceUrl(value,catalog.platform) === catalog.url);
      const credited = (page.creditedArtistUrls ?? []).map(value => referenceUrl(value,catalog.platform)).filter(Boolean);
      if (exactTarget) {
        evidence.externalUrls = [catalog.url];
        evidence.status = 'exact_catalog_music_identity';
        return evidence; // Still requires independent ownership/JEV assessment.
      }
      if (credited.length) {
        if (credited.length>1) evidence.reason = 'Multiple credited music artists; not sole ownership.';
        else evidence.reason ??= 'Credited music artist differs from the catalog reference.';
      }
      const targets = [...(page.redirectUrl ? [page.redirectUrl] : []),...(page.musicTargets ?? [])]
        .map(value => musicPageUrl(value)).filter(Boolean)
        .sort((a,b)=>Number(referenceUrl(b,catalog.platform)===catalog.url)-Number(referenceUrl(a,catalog.platform)===catalog.url));
      for (const target of targets) if (!seen.has(target)) queue.push({url:target,linkedFrom:url});
    }
    evidence.reason ??= pageLimitReached ? 'Public music-page limit reached before all supported links were checked.'
      : evidence.attempts.some(a=>a.status==='failed') ? 'Some source-linked music pages were unavailable; identity remains unresolved.'
      : 'No exact catalog artist ID in the checked music path.';
  } catch (error) { evidence.reason = error.message; }
  return evidence;
}
