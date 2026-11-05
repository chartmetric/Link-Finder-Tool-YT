// This gate supports research candidates only. Live links must still be recorded
// as claims and processed by the external resolver; nothing here writes claims.
export const MATCHING_POLICY = 'catalog-reference-identity-v1';

export function instagramProfileUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(url.hostname)
      || parts.length !== 1 || !/^[a-z0-9._]{1,30}$/i.test(parts[0])
      || ['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'about', 'direct', 'popular'].includes(parts[0].toLowerCase())) return null;
    return `https://www.instagram.com/${parts[0].toLowerCase()}/`;
  } catch { return null; }
}

export function referenceUrl(value, platform) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (platform === 'spotify' && url.hostname === 'open.spotify.com' && /^\/artist\/[A-Za-z0-9]{22}$/.test(path)) {
      return `https://open.spotify.com${path}`;
    }
    if (platform === 'youtube' && ['youtube.com', 'www.youtube.com', 'music.youtube.com'].includes(url.hostname)
      && /^\/(@[A-Za-z0-9._-]+|channel\/[A-Za-z0-9_-]+)$/.test(path)) {
      return `https://www.youtube.com${path.startsWith('/@') ? path.toLowerCase() : path}`;
    }
    if (platform === 'tiktok' && ['tiktok.com', 'www.tiktok.com'].includes(url.hostname) && /^\/@[A-Za-z0-9._]+$/.test(path)) {
      return `https://www.tiktok.com${path.toLowerCase()}`;
    }
    return null;
  } catch { return null; }
}

export function catalogReferences(player = {}) {
  const ids = new Set((player.account_ids ?? []).map(String));
  const references = (player.accounts ?? []).flatMap(account => {
    if (!ids.has(String(account.account_id))
      || (account.profile_id !== undefined && String(account.profile_id) !== String(player.profile_id))
      || account.disconnected_at) return [];
    const platform = String(account.platform ?? '').toLowerCase();
    const url = referenceUrl(account.account_url, platform);
    return url ? [{ platform, url }] : [];
  });
  const priority = { spotify: 0, youtube: 1, tiktok: 2 };
  return references.sort((a, b) => priority[a.platform] - priority[b.platform] || a.url.localeCompare(b.url));
}

export function instagramSearchRequest(player) {
  const reference = catalogReferences(player)[0];
  return {
    ...(reference ? { knownProfileUrl: reference.url } : { subject: `${player.artist}, musician` }),
    targetPlatforms: ['instagram'],
    methods: ['serper'],
  };
}

const words = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .match(/[\p{L}\p{N}]+/gu) ?? [];
const fullNamePresent = (artist, text) => {
  const name = words(artist).join(' ');
  return name.length > 0 && ` ${words(text).join(' ')} `.includes(` ${name} `);
};

function metadataMatches(metadata, url, normalize) {
  return [metadata?.url, ...(metadata?.urlAliases ?? [])].some(value => normalize(value) === url);
}

export function hasCatalogCrossLink(reference, candidate, url, catalog) {
  // Compare parsed URL identities, never partial handles or substrings of IDs.
  const urls = text => String(text ?? '').match(/https:\/\/[^\s<>"']+/g) ?? [];
  return [...urls(reference.bio), ...(reference.externalUrls ?? [])]
    .some(value => instagramProfileUrl(value.replace(/[),;]+$/, '')) === url)
    || [...urls(candidate.bio), ...(candidate.externalUrls ?? [])]
      .some(value => referenceUrl(value.replace(/[),;]+$/, ''), catalog.platform) === catalog.url);
}

function assess(profile, player, references) {
  const url = instagramProfileUrl(profile.url);
  if (!url) return { url: String(profile.url ?? ''), status: 'rejected', reason: 'Not a safe direct Instagram account URL.' };
  const comparison = profile.identityComparison;
  const jev = profile.jevVerification;
  if (comparison?.status === 'mismatch' || jev?.verdict === 'mismatch') {
    return { url, status: 'rejected', reason: 'Identity verification reported a mismatch.' };
  }
  const catalog = references.find(reference => metadataMatches(comparison?.reference, reference.url,
    value => referenceUrl(value, reference.platform)));
  const candidateBound = metadataMatches(comparison?.candidate, url, instagramProfileUrl);
  const text = `${profile.title ?? ''} ${comparison?.candidate?.displayName ?? ''}`;
  // Related labels/festivals/fan accounts are not artist-owned identities.
  const relatedEntity = /\b(festival|record label|fan ?page|fan account|tribute)\b/i.test(
    `${text} ${comparison?.candidate?.bio ?? ''}`);
  if (relatedEntity) return { url, status: 'needs_review', reason: 'Possible label, festival, fan or related account; artist ownership is not established.' };
  const linked = catalog && candidateBound && hasCatalogCrossLink(comparison.reference, comparison.candidate, url, catalog);
  if (!fullNamePresent(player.artist, text) && !linked) {
    return { url, status: 'rejected', reason: 'The account name does not identify this artist and no catalog-bound cross-link supports it.' };
  }
  if (!catalog || !candidateBound) {
    return { url, status: 'needs_review', reason: 'Missing identity metadata bound to both this Instagram account and a linked catalog reference.' };
  }
  if (!linked) return { url, status: 'needs_review', reason: 'No exact cross-link between the candidate and the linked catalog reference; name similarity is insufficient.' };
  if (comparison.status !== 'likely' || jev?.verdict !== 'verified'
    || !Number.isFinite(jev.sameIdentityProbability) || jev.sameIdentityProbability < 0.9 || jev.sameIdentityProbability > 1) {
    return { url, status: 'needs_review', reason: 'A catalog-bound cross-link exists, but high-confidence identity verification is missing or inconclusive.' };
  }
  return { url, status: 'supported', reason: 'Exact catalog-reference cross-link plus a high-confidence verified identity comparison; still requires claim resolution.' };
}

export function assessInstagramCandidates(result, player = {}) {
  if (!result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used')) {
    throw new Error('Required Serper search did not complete; stopped without fallback or automatic retry.');
  }
  if (!Array.isArray(result.profiles)) throw new Error('Search did not return a candidate list; absence cannot be assessed.');
  const references = catalogReferences(player);
  const candidates = result.profiles.map(profile => assess(profile, player, references));
  // Duplicate occurrences must all pass. A verified occurrence cannot conceal a
  // conflicting mismatch for the same normalized account.
  const urls = [...new Set(candidates.filter(candidate => candidate.status === 'supported').map(candidate => candidate.url))]
    .filter(url => candidates.filter(candidate => candidate.url === url).every(candidate => candidate.status === 'supported'));
  const status = urls.length ? 'candidates_found' : candidates.length ? 'needs_review' : 'no_candidates';
  return {
    policy: MATCHING_POLICY,
    profileId: String(player.profile_id ?? ''),
    cmArtist: String(player.cm_artist ?? ''),
    status,
    urls,
    catalogReferences: references,
    candidates,
    approvedCatalogLinks: false,
    noAccountConfirmed: false,
  };
}
