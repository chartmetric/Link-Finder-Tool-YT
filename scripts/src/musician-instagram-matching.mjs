// This gate supports research candidates only. Live links must still be recorded
// as claims and processed by the external resolver; nothing here writes claims.
export const MATCHING_POLICY = 'catalog-reference-identity-v1';
import { declaredInstagramLinks } from './instagram-reference-links.mjs';
import {CORROBORATED_POLICY, corroboratedCandidate, assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
export {CORROBORATED_POLICY} from './instagram-corroborated-policy.mjs';

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
  return declaredInstagramLinks(reference.bio).some(link => link.url === url)
    || [...urls(reference.bio), ...(reference.externalUrls ?? [])]
    .some(value => instagramProfileUrl(value.replace(/[),;]+$/, '')) === url)
    || [...urls(candidate.bio), ...(candidate.externalUrls ?? [])]
      .some(value => referenceUrl(value.replace(/[),;]+$/, ''), catalog.platform) === catalog.url);
}

/** Candidate-declared links to ANY frozen, current catalog account. These
 * establish a source path, not artist ownership; the model gate still applies.
 * Never promote profile/platform snapshots to account-bound ownership evidence. */
export function catalogConnectionEvidence(candidate, player = {}) {
  const sourceUrl = instagramProfileUrl(candidate?.url);
  if (!sourceUrl) return [];
  const ids = new Set((player.account_ids ?? []).map(String));
  const canonical = (value, platform) => {
    if (platform !== 'twitter') return referenceUrl(value, platform);
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port
        || !['twitter.com','www.twitter.com','x.com','www.x.com'].includes(u.hostname)
        || !/^\/[a-z0-9_]{1,15}\/?$/i.test(u.pathname)) return null;
      return `https://x.com/${u.pathname.split('/')[1].toLowerCase()}`;
    } catch { return null; }
  };
  const direct = candidate.directExternalUrls
    ?? (candidate.externalLinkEvidence ? [] : candidate.externalUrls ?? []);
  const observed = [...direct, ...(String(candidate.bio ?? '').match(/https:\/\/[^\s<>"']+/g) ?? [])];
  const edges = [];
  for (const account of player.accounts ?? []) {
    if (!ids.has(String(account.account_id)) || account.disconnected_at || account.is_active === false || account.is_active === 0
      || (account.profile_id !== undefined && String(account.profile_id) !== String(player.profile_id))) continue;
    const platform = String(account.platform ?? '').toLowerCase();
    const target = canonical(account.account_url, platform);
    if (!target || !observed.some(value => canonical(value.replace(/[),;]+$/, ''), platform) === target)) continue;
    if (!edges.some(e => e.targetUrl === target)) edges.push({
      sourceUrl, targetUrl:target, platform, accountId:String(account.account_id),
      source:'instagram_declared_link_to_frozen_catalog_account',
    });
  }
  return edges;
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
  const linked = catalog && candidateBound && (hasCatalogCrossLink(comparison.reference, comparison.candidate, url, catalog)
    || catalogConnectionEvidence(comparison.candidate, player).length > 0);
  if (!fullNamePresent(player.artist, text) && !linked) {
    return { url, status: 'rejected', reason: 'The account name does not identify this artist and no catalog-bound cross-link supports it.' };
  }
  if (!catalog || !candidateBound) {
    return { url, status: 'needs_review', reason: 'Missing identity metadata bound to both this Instagram account and a linked catalog reference.' };
  }
  if (!linked) return { url, status: 'needs_review', reason: 'No exact cross-link between the candidate and the linked catalog reference; name similarity is insufficient.'
    + (comparison.candidate.unresolvedExternalLinks?.length
      ? ` ${comparison.candidate.unresolvedExternalLinks.length} external link(s) are unsupported by the bounded resolver; this is missing evidence, not a mismatch.` : '') };
  if (comparison.status !== 'likely' || jev?.verdict !== 'verified'
    || !Number.isFinite(jev.sameIdentityProbability) || jev.sameIdentityProbability < 0.9 || jev.sameIdentityProbability > 1) {
    return { url, status: 'needs_review', reason: 'A catalog-bound cross-link exists, but high-confidence identity verification is missing or inconclusive.' };
  }
  return { url, status: 'supported', reason: 'Exact catalog-reference cross-link plus a high-confidence verified identity comparison; still requires claim resolution.' };
}

export function assessInstagramCandidates(result, player = {}, options = {}) {
  if (options.policy !== undefined && ![MATCHING_POLICY, CORROBORATED_POLICY].includes(options.policy)) {
    throw Error('Unknown matching policy.');
  }
  if (options.policy === CORROBORATED_POLICY && options.mode !== 'offline') {
    throw Error('The corroborated policy requires explicit offline mode; live activation is not approved.');
  }
  if (!result.methodsUsed?.some(method => method.method === 'serper' && method.status === 'used')) {
    throw new Error('Required Serper search did not complete; stopped without fallback or automatic retry.');
  }
  if (!Array.isArray(result.profiles)) throw new Error('Search did not return a candidate list; absence cannot be assessed.');
  const references = catalogReferences(player);
  if (options.policy === CORROBORATED_POLICY) {
    assertNoGradingInputs({result, player, context:options.context});
    const currentReferences = catalogReferences({...player, accounts:(player.accounts ?? [])
      .filter(a => a.is_active !== false && a.is_active !== 0)});
    const candidates = result.profiles.map(profile => corroboratedCandidate({
      profile, player, references:currentReferences, context:options.context,
      tools:{instagramProfileUrl, referenceUrl, fullNamePresent, catalogConnectionEvidence},
    }));
    const proposed = [...new Set(candidates.filter(c => c.status === 'supported').map(c => c.url))]
      .filter(url => candidates.filter(c => c.url === url).every(c => c.status === 'supported'));
    for (const c of candidates) if (c.status === 'supported' && !proposed.includes(c.url)) {
      c.status = 'needs_review'; c.route = 'hold'; c.reason = 'conflicting_duplicate_occurrence';
    }
    return {policy:CORROBORATED_POLICY, profileId:String(player.profile_id ?? ''),
      cmArtist:String(player.cm_artist ?? ''), status:'offline_simulation', candidates,
      simulationUrls:proposed, urls:[], offlineOnly:true, productionApproved:false,
      approvedCatalogLinks:false, noAccountConfirmed:false, thresholdCalibrated:false,
      newModelCalls:0};
  }
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
