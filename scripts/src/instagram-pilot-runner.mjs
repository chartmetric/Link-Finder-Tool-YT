import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogReferences, referenceUrl, instagramProfileUrl, hasCatalogCrossLink, assessInstagramCandidates } from './musician-instagram-matching.mjs';
import { createPilotBudget } from './instagram-pilot-budget.mjs';
import { isMusicLandingUrl, resolveMusicEvidence } from './public-music-links.mjs';

export function pilotPreflight(manifest) {
  if (!Number.isInteger(manifest.proposed_limits.artist_workers) || manifest.proposed_limits.artist_workers < 1
    || manifest.proposed_limits.artist_workers > 5) throw new Error('Pilot requires 1–5 artist workers.');
  const seen = new Set();
  const artists = manifest.artists.map(a => {
    if (![a.profile_id, a.cm_artist].every(value => /^\d+$/.test(String(value)))) throw new Error('Invalid pilot identity.');
    if (seen.has(String(a.profile_id))) throw new Error('Duplicate pilot profile.');
    seen.add(String(a.profile_id));
    const catalog = a.catalog_profile;
    const identityMatches = a.source_identity_matches === true && catalog?.cm_source === 'cm_artist'
      && String(catalog.profile_id) === String(a.profile_id) && String(catalog.cm_artist) === String(a.cm_artist);
    const reference = catalogReferences(a)[0];
    const originallyEligible = a.reference_preflight?.readiness === 'reference_usable';
    return { profileId: String(a.profile_id), reference, eligible: !!reference && originallyEligible && identityMatches,
      reason: !identityMatches ? 'catalog_identity_conflict' : !reference ? 'reference_unresolved'
        : !originallyEligible ? 'reference_repaired_but_scope_reapproval_required' : 'reference_usable' };
  });
  if (artists.filter(a => a.eligible).length > manifest.proposed_limits.eligible_artists_before_prerequisite_fixes) {
    throw new Error('Eligible artists exceed the frozen execution scope.');
  }
  return { dryRun: true, networkCalls: 0, claimsSubmitted: 0, databaseWrites: 0, artists };
}

/** All stages use the same budget/journal. CLI here remains zero-network.
 * Live execution is exclusively exposed by the separately authorized live CLI. */
export async function runPilot({ manifest, journalPath, transport, evaluateRegressions, onResult, mode = 'fixture' }) {
  const preflight = pilotPreflight(manifest);
  const eligible = new Map(preflight.artists.filter(a => a.eligible).map(a => [a.profileId, a]));
  const scopeManifest = { ...manifest, artists: manifest.artists.filter(a => eligible.has(String(a.profile_id))) };
  const budget = await createPilotBudget({ manifest: scopeManifest, journalPath, transport, mode });
  const results = [];
  const record = async result => {
    result.fixtureOnly = mode === 'fixture';
    result.cmArtist = String(manifest.artists.find(a => String(a.profile_id) === result.profileId)?.cm_artist ?? '');
    results.push(result);
    if (onResult) {
      try { await onResult(result); }
      catch (error) { budget.stop('Result persistence failed.'); throw error; }
    }
  };
  let cursor = 0, stage = [];
  const deadline = Date.now() + manifest.proposed_limits.job_wall_time_minutes * 60000;
  async function worker() {
    while (cursor < stage.length) {
      const artist = stage[cursor++];
      const id = String(artist.profile_id), scope = eligible.get(id);
      if (!scope) { await record({ profileId: id, status: 'needs_review', reason: preflight.artists.find(a => a.profileId === id).reason }); continue; }
      const started = Date.now();
      const evidence = { reference: undefined, discoveryAttempts: [], profiles: [] };
      let sequence = 0;
      const call = (kind, payload) => {
        if (Date.now() >= deadline || Date.now() - started >= manifest.proposed_limits.per_artist_wall_time_seconds * 1000) {
          throw new Error('Pilot time budget exceeded; identity remains unresolved.');
        }
        return budget.request({ profileId: id, kind, key: `${id}:${kind}:${sequence++}`, payload,
          deadlineAt: Math.min(deadline, started + manifest.proposed_limits.per_artist_wall_time_seconds * 1000) });
      };
      try {
        const reference = await call(scope.reference.platform === 'spotify' ? 'spotify_oembed' : 'scrapecreators_reference', { url: scope.reference.url });
        evidence.reference = reference;
        if (![reference.url, ...(reference.urlAliases ?? [])].some(url => referenceUrl(url, scope.reference.platform) === scope.reference.url)) {
          throw new Error('Reference metadata does not identify the catalog account.');
        }
        let discovery;
        const discoveryAttempts = evidence.discoveryAttempts;
        for (let query = 0; query < manifest.proposed_limits.serper_requests_per_artist; query++) {
          discovery = await call('serper', { artist: artist.artist, reference: scope.reference, queryIndex: query, targetPlatform: 'instagram' });
          discoveryAttempts.push(discovery);
          // Failure/incomplete discovery is never an empty successful search.
          assessInstagramCandidates(discovery, artist);
          // Clues alone must not suppress the second allowed search. Fixture
          // profiles without provenance retain their existing direct-profile behavior.
          if (discovery.profiles?.some(p=>!p.discoveryEvidence
            || p.discoveryEvidence.some(e=>e.kind==='direct_profile'))) break;
        }
        if (!Array.isArray(discovery?.profiles)) throw new Error('Discovery response is incomplete.');
        const unique = [...new Map(discoveryAttempts.flatMap(attempt=>attempt.profiles).flatMap(p => {
          const url = instagramProfileUrl(p.url);
          return url ? [[url, { ...p, url }]] : [];
        })).values()];
        unique.sort((a, b) => Number(hasCatalogCrossLink(reference, { url: b.url }, b.url, scope.reference))
          - Number(hasCatalogCrossLink(reference, { url: a.url }, a.url, scope.reference))
          || (b.discoveryPriority ?? 0)-(a.discoveryPriority ?? 0));
        const selected = unique.slice(0, manifest.proposed_limits.instagram_candidate_metadata_per_artist);
        const profiles = evidence.profiles;
        for (const p of selected) {
          const candidate = await call('scrapecreators_candidate', { url: p.url });
          if (instagramProfileUrl(candidate.url)===p.url && candidate.externalUrls?.some(isMusicLandingUrl)
            && !evidence.linkHubAttempted) {
            evidence.linkHubAttempted = true;
            const hub = await resolveMusicEvidence({candidate,catalog:scope.reference,
              readPage:url=>call('public_page',{url})});
            candidate.externalLinkEvidence = hub;
            candidate.externalUrls = [...new Set([...candidate.externalUrls,...hub.externalUrls])];
          }
          const linked = hasCatalogCrossLink(reference, candidate, p.url, scope.reference);
          profiles.push({ ...p, identityComparison: { reference, candidate, status: linked ? 'likely' : 'uncertain',
            score: linked ? 60 : 0, reasons: linked ? ['Exact catalog account cross-link'] : ['No exact cross-link'] } });
        }
        if (profiles.length) {
          const decisions = await call('jev', { artist: artist.artist, catalogReference: scope.reference, profiles });
          for (const p of profiles) p.jevVerification = decisions.find(d => instagramProfileUrl(d.url) === p.url)?.jevVerification;
        }
        const assessment = assessInstagramCandidates({ ...discovery, profiles }, artist);
        // Invalid or truncated candidates cannot turn into a completed absence.
        if (!profiles.length && discoveryAttempts.some(a=>a.profiles.length)) assessment.status = 'needs_review';
        await record({ profileId: id, ...assessment, uninspectedCandidates: Math.max(0, unique.length - selected.length),
          rawResult: { ...discovery, profiles }, discoveryAttempts, fixtureOnly: true, approvedCatalogLinks: false });
      } catch (error) { await record({ profileId: id, status: 'needs_review', reason: error.message,
        partialEvidence: evidence, fixtureOnly: true }); }
    }
  }
  try {
    const regressions = manifest.artists.filter(a => a.bucket === 'regression');
    const remaining = manifest.artists.filter(a => a.bucket !== 'regression');
    let regressionStagePassed = regressions.length === 0;
    for (const work of [regressions, remaining]) {
      if (!work.length) continue;
      if (work === remaining && !regressionStagePassed) {
        budget.stop('Regression-stage approval missing or failed.');
        for (const a of remaining) await record({ profileId: String(a.profile_id), status: 'needs_review',
          reason: 'Regression-stage approval missing or failed; no requests dispatched.', fixtureOnly: true });
        break;
      }
      stage = work; cursor = 0;
      await Promise.all(Array.from({ length: Math.min(manifest.proposed_limits.artist_workers, 5) }, worker));
      if (work === regressions) {
        // Evaluation runs after blind results, outside discovery payloads.
        regressionStagePassed = !!evaluateRegressions && await evaluateRegressions(structuredClone(results)) === true;
      }
    }
    return { fixtureOnly: mode === 'fixture', results, regressionStagePassed, budget: budget.snapshot(), claimsSubmitted: 0, databaseWrites: 0 };
  } finally { await budget.close(); }
}

export function runFixturePilot(options) {
  return runPilot({ ...options, mode: 'fixture' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--dry-run') throw new Error('Only --dry-run <manifest.json> is supported. Paid execution is disabled.');
  const manifest = JSON.parse(await fs.readFile(args[1], 'utf8'));
  console.log(JSON.stringify(pilotPreflight(manifest), null, 2));
}
