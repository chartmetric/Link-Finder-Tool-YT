const spotifyHosts = new Set(['open.spotify.com', 'play.spotify.com', 'spotify.com', 'www.spotify.com']);
const appleMusicHosts = new Set(['music.apple.com']);
const linktreeHosts = new Set(['linktr.ee', 'www.linktr.ee', 'linktree.com', 'www.linktree.com']);

function platformFamily(platform) {
  const value = String(platform ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (value.includes('spotify')) return 'spotify';
  if (value.includes('applemusic') || value === 'itunes') return 'apple_music';
  return null;
}

function musicDestination(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (spotifyHosts.has(url.hostname.toLowerCase())) {
    const match = url.pathname.match(/^\/artist\/([A-Za-z0-9]{22})\/?$/);
    return match ? { platform: 'spotify', id: match[1], url: url.href } : null;
  }
  if (appleMusicHosts.has(url.hostname.toLowerCase())) {
    const parts = url.pathname.split('/').filter(Boolean);
    const artistIndex = parts.indexOf('artist');
    const id = parts.at(-1)?.replace(/^id/i, '');
    return artistIndex >= 0 && /^\d+$/.test(id ?? '')
      ? { platform: 'apple_music', id, url: url.href }
      : null;
  }
  return null;
}

export function catalogMusicIdentity(platform, accountUrl) {
  const family = platformFamily(platform);
  if (!family) return null;
  const destination = musicDestination(String(accountUrl ?? ''));
  return destination?.platform === family ? destination : null;
}

function decodedText(html) {
  return String(html ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/gi, '/')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003[dD]/g, '=')
    .replace(/\\u003[aA]/g, ':');
}

export function bioMusicLinks(html) {
  const text = decodedText(html).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  const urls = new Set();
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    const value = match[0].replace(/[),.;\]}]+$/g, '');
    let url;
    try { url = new URL(value); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if (musicDestination(url.href) || linktreeHosts.has(host)) urls.add(url.href);
  }
  return [...urls];
}

export function verifyMusicLinkEvidence({ links, catalogAccounts }) {
  const expected = new Map();
  for (const account of catalogAccounts) {
    const identity = catalogMusicIdentity(account.platform, account.account_url);
    if (!identity) continue;
    const records = expected.get(identity.platform) ?? [];
    records.push({ id: identity.id, accountId: String(account.account_id), url: identity.url });
    expected.set(identity.platform, records);
  }

  const evidence = links.map(link => {
    const destination = musicDestination(link.url);
    if (!destination) return null;
    const catalog = expected.get(destination.platform) ?? [];
    const matched = catalog.filter(account => account.id === destination.id);
    return {
      sourceUrl: link.sourceUrl,
      destinationUrl: destination.url,
      platform: destination.platform,
      destinationId: destination.id,
      outcome: matched.length ? 'exact_match' : catalog.length ? 'conflict' : 'no_catalog_account',
      catalogAccounts: matched.length ? matched : catalog,
    };
  }).filter(Boolean);

  const hasConflict = evidence.some(item => item.outcome === 'conflict');
  const hasMatch = evidence.some(item => item.outcome === 'exact_match');
  const identityStatus = hasConflict ? 'conflicting'
    : hasMatch ? 'verified'
      : 'insufficient';
  return { identityStatus, evidence };
}

export function isAllowedPublicProfileUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      ['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname.toLowerCase())
      || linktreeHosts.has(url.hostname.toLowerCase())
    );
  } catch { return false; }
}

export function linktreeUrls(links) {
  return links.filter(value => {
    try { return linktreeHosts.has(new URL(value).hostname.toLowerCase()); }
    catch { return false; }
  });
}

export function directMusicLinks(links) {
  return links.filter(value => musicDestination(value) !== null);
}
