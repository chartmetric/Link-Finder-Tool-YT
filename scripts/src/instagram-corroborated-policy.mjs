// Versioned research policy. No provider, persistence, claims or grading inputs.
import {contextSignals} from './instagram-context-signals.mjs';
import {declaredInstagramLinks} from './instagram-reference-links.mjs';

export const CORROBORATED_POLICY = 'corroborated-artist-evidence-v2';
const norm = value => String(value ?? '').normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
  .normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// JavaScript \b is ASCII-oriented, including in /u mode. Use Unicode boundaries.
const artistRole = text => /(?<![\p{L}\p{N}])(artist|musician|singer|songwriter|producer|rapper|band|duo|trio|cantante|cantor|cantora|artista|compositor|musico|певица|певец|музыкант|группа)(?![\p{L}\p{N}])|歌手|アーティスト|가수|싱어/u.test(norm(text));
const releaseAnnouncement = text => /(?<![\p{L}\p{N}])(new single|new album|new song|new track|single out|album out|новый трек|новая песня)(?![\p{L}\p{N}])/u.test(norm(text));
const official = text => /(?<![\p{L}\p{N}])(official|oficial|officiel|offiziell|официальный|официальная)(?![\p{L}\p{N}])|公式|공식/u.test(norm(text));
const related = text => /(?<![\p{L}\p{N}])(record label|label|festival|venue|fan page|fan account|fan club|fanclub|fankonto|fanowski|tribute|manufacturer|кавер|фан аккаунт|фан страница)(?![\p{L}\p{N}])|非公式|粉丝|粉絲|팬계정|팬 계정|レーベル|레이블/u.test(norm(text));
const web = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u.href : null; }
  catch { return null; }
};
const profileBound = (metadata, url, normalize) => [metadata?.url, ...(metadata?.urlAliases ?? [])]
  .some(value => normalize(value) === url);
const urlsIn = value => String(value ?? '').match(/https:\/\/[^\s<>"']+/g)?.map(u => u.replace(/[),;]+$/, '')) ?? [];

function capturedMusicPath(candidate, reference, tools) {
  const path = candidate.externalLinkEvidence;
  const targets = new Set();
  if (!path || !Array.isArray(path.pages)) return targets;
  const seeds = new Set((candidate.directExternalUrls ?? []).map(web).filter(Boolean));
  // Recompute the path. Do not trust "exact_catalog_music_identity", copied
  // catalogConnections, flattened derived URLs or an ownershipAssessment flag.
  const reachable = new Set(seeds);
  for (let step = 0; step < 8; step++) {
    let changed = false;
    for (const page of path.pages.slice(0, 16)) {
      if (!reachable.has(web(page.sourceUrl)) || page.status !== 200
        || !/^[a-f0-9]{64}$/.test(page.bodySha256 ?? '')) continue;
      for (const edge of page.linkEvidence ?? []) {
        if (edge.kind !== 'declared_profile_link' || web(edge.sourceUrl) !== web(page.sourceUrl)) continue;
        const target = tools.referenceUrl(edge.targetUrl, reference.platform);
        if (target) targets.add(target);
        const next = web(edge.targetUrl);
        if (next && !reachable.has(next)) { reachable.add(next); changed = true; }
      }
    }
    if (!changed) break;
  }
  return targets;
}

export function corroboratedCandidate({profile, player, references, context, tools}) {
  const url = tools.instagramProfileUrl(profile.url);
  const hold = reason => ({url: url ?? String(profile.url ?? ''), status:'needs_review', route:'hold', reason});
  const support = (route, evidence) => ({url, status:'supported', route,
    reason:'Corroborated research evidence; not a new model verdict or a catalog approval.', evidence});
  if (!url) return hold('invalid_instagram_url');
  const comparison = profile.identityComparison, decision = profile.jevVerification;
  if (comparison?.status === 'mismatch' || decision?.verdict === 'mismatch') return hold('identity_mismatch');
  for (const key of ['contradictions', 'conflictingProfileIds']) {
    if (profile[key] !== undefined && (!Array.isArray(profile[key]) || profile[key].length)) return hold('unresolved_or_malformed_conflict');
  }
  if (!['verified', 'likely'].includes(decision?.verdict)
    || !Number.isFinite(decision.sameIdentityProbability)
    || decision.sameIdentityProbability < 0 || decision.sameIdentityProbability > 1) return hold('missing_invalid_or_inconclusive_model_assessment');
  const reference = references.find(r => profileBound(comparison?.reference, r.url, u => tools.referenceUrl(u, r.platform)));
  const candidate = comparison?.candidate;
  if (!reference || !profileBound(candidate, url, tools.instagramProfileUrl)) return hold('unbound_reference_or_candidate');
  const display = candidate.displayName ?? '';
  const bio = candidate.bio ?? '';
  // Search result titles are not account self-identification.
  if (!tools.fullNamePresent(player.artist, display)) return hold('account_self_identification_missing');
  if (related(`${display} ${bio}`)) return hold('related_entity_or_fan');
  const ref = comparison.reference;
  const direct = candidate.directExternalUrls ?? (candidate.externalLinkEvidence ? [] : candidate.externalUrls ?? []);
  const pathTargets = capturedMusicPath(candidate, reference, tools);
  const directTargets = [...direct, ...urlsIn(bio)].map(u => tools.referenceUrl(u, reference.platform)).filter(Boolean);
  const known = new Set(references.filter(r => r.platform === reference.platform).map(r => r.url));
  if ([...pathTargets, ...directTargets].some(target => !known.has(target))) return hold('competing_catalog_music_identity');
  const inbound = declaredInstagramLinks(ref.bio).some(l => l.url === url)
    || [...(ref.externalUrls ?? []), ...urlsIn(ref.bio)].some(u => tools.instagramProfileUrl(u) === url);
  if (inbound) return support('catalog_account_declares_instagram', ['bound_catalog_reference', 'exact_instagram_declaration', 'matching_account_name']);

  const connections = tools.catalogConnectionEvidence(candidate, player);
  const platforms = new Set(connections.map(c => c.platform));
  if (platforms.size >= 2 && official(bio)) return support('multiple_catalog_accounts_and_self_identification',
    [...connections.map(c => c.targetUrl), 'official_self_description']);

  const directTarget = directTargets.includes(reference.url);
  if ((directTarget || pathTargets.has(reference.url)) && (artistRole(bio) || releaseAnnouncement(bio))) {
    return support('catalog_music_path_and_artist_self_identification', [reference.url, 'artist_role_or_release_announcement']);
  }
  // Catalog metadata is separately scoped by the caller. A caller cannot use
  // another profile's releases, synthetic expected answers or precomputed signals.
  if (String(context?.profileId ?? '') !== String(player.profile_id ?? '')
    || !context?.metadata || context.metadata.ownershipConfirmed !== false
    || !Array.isArray(context.metadata.items)) return hold('insufficient_bound_corroboration');
  const metadata = {ownershipConfirmed:false, items:context.metadata.items.filter(i =>
    i && i.stale !== true && i.source && typeof i.text === 'string').slice(0, 16)};
  const signals = contextSignals(metadata, candidate, player.artist, profile.discoveryEvidence ?? []);
  const bioTitles = new Set((signals.songTitlesInCandidateProfile.titles ?? []).map(norm));
  const ownReleasePosts = (signals.songTitlesInCandidatePosts?.matches ?? []).filter(p =>
    p.attribution === 'candidate_owned_post_search_snippet' && !p.cautions.length
    && /(?<![\p{L}\p{N}])(my|our|мой|моя|наш|наша|mi|nuestro|meu|minha)(?![\p{L}\p{N}])/u.test(norm(p.snippet))
    && /(?<![\p{L}\p{N}])(single|album|song|track|трек|песню|песня|cancion|musica)(?![\p{L}\p{N}])/u.test(norm(p.snippet)));
  if (artistRole(bio) && bioTitles.size >= 2 && ownReleasePosts.length) return support('catalog_releases_and_self_attributed_release_post',
    [...bioTitles, ...ownReleasePosts.map(p => p.sourceUrl)]);
  return hold('insufficient_distinctive_ownership_corroboration');
}

export function assertNoGradingInputs(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(expectedArtistOwned|expected|groundTruth|grading|adjudication|labelEvidence|labelTier|stratum)$/.test(key)) {
      throw Error(`Grading field ${key} is not verification evidence.`);
    }
    assertNoGradingInputs(child);
  }
}
