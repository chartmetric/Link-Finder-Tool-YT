// Offline impact analysis only. Deliberately imports no provider, DB or live runner.
import {createHash} from 'node:crypto';
import {assessInstagramCandidates, instagramProfileUrl} from './musician-instagram-matching.mjs';
import {assessOfflineSourcePolicy, OFFLINE_SOURCE_POLICY} from './instagram-source-policy-offline.mjs';

export const IMPACT_SCHEMA = 'instagram-source-policy-impact-v1';
export const WARNING = 'OFFLINE SIMULATION: every simulated URL is NON-IMPORTABLE and PRODUCTION-UNAPPROVED. No claims, activation, accuracy benchmark or population inference.';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const hashPattern = /^[a-f0-9]{64}$/;
const gradingKeys = new Set(['expectedArtistOwned', 'labelEvidence', 'labelTier',
  'adjudication', 'stratum', 'expected', 'grading', 'groundTruth']);
function check(condition, message) { if (!condition) throw new Error(message); }
function noGrading(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    check(!gradingKeys.has(key), `Grading field ${key} is not allowed in impact inputs.`);
    noGrading(child);
  }
}
function onlyKeys(value, keys, where) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${where} must be an object.`);
  check(Object.keys(value).every(k => keys.includes(k)), `Unknown ${where} field.`);
}
const hasId = value => (typeof value === 'string' && value.trim().length > 0)
  || (Number.isSafeInteger(value) && value >= 0);

export function validateImpactSettings({config, evaluationTime}) {
  onlyKeys(config, ['mode', 'minimumSourceIdentityScore', 'maxEvidenceAgeMs', 'maxVerifierAgeMs'], 'config');
  check(config.mode === 'offline', 'Explicit offline mode required.');
  check(Number.isFinite(config.minimumSourceIdentityScore)
    && config.minimumSourceIdentityScore >= 0 && config.minimumSourceIdentityScore <= 1,
  'Explicit experimental minimumSourceIdentityScore in [0,1] required.');
  for (const key of ['maxEvidenceAgeMs', 'maxVerifierAgeMs']) {
    check(Number.isSafeInteger(config[key]) && config[key] > 0, `Explicit positive integer ${key} required.`);
  }
  check(typeof evaluationTime === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(evaluationTime)
    && Number.isFinite(Date.parse(evaluationTime))
    && new Date(Date.parse(evaluationTime)).toISOString() === evaluationTime.replace(/Z$/, evaluationTime.includes('.') ? 'Z' : '.000Z'),
  'Explicit valid UTC evaluationTime required (ISO timestamp).');
  return Date.parse(evaluationTime);
}

function timeState(at, now, maxAge) {
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return 'missing_or_invalid';
  if (Date.parse(at) > now) return 'future';
  return now - Date.parse(at) > maxAge ? 'stale' : 'fresh';
}
function snapshotDiagnostics(packet, now, maxAge) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return {missing: true};
  const {packetSha256, ...content} = packet;
  return {missing: false, sourceUrl: packet.sourceUrl ?? null, observedAt: packet.observedAt ?? null,
    bodySha256: packet.bodySha256 ?? null, packetSha256: packetSha256 ?? null,
    computedPacketSha256: jsonHash(content), packetHashValid: packetSha256 === jsonHash(content),
    bodyHashPresent: hashPattern.test(packet.bodySha256 ?? ''),
    freshness: timeState(packet.observedAt, now, maxAge),
    linksPresent: Array.isArray(packet.links) && packet.links.length > 0};
}

function historicalBinding(c, candidate, candidateIndex) {
  const records = c.historicalVerifiers.filter(v => v.candidateIndex === candidateIndex);
  const decision = candidate.jevVerification;
  if (decision === undefined || decision === null) {
    check(records.length === 0, `${c.caseId}: verifier record without original candidate decision.`);
    return {kind: 'no_historical_verifier', originalRequestSha256: null,
      warning: 'No verifier decision supplied; no model result is inferred.'};
  }
  check(records.length === 1, `${c.caseId}: one original verifier binding required for candidate ${candidateIndex}.`);
  const record = records[0];
  onlyKeys(record, ['candidateIndex', 'requestProvenance', 'requestBody', 'requestSha256', 'decision', 'decisionSha256'], 'historical verifier');
  check(record.requestProvenance === 'original_captured',
    `${c.caseId}: explicitly declare original_captured request provenance; reconstruction is not historical replay.`);
  check(typeof record.requestBody === 'string' && record.requestBody.length > 0,
    `${c.caseId}: original serialized requestBody required; reconstructed requests are not accepted.`);
  check(hashPattern.test(record.requestSha256) && digest(record.requestBody) === record.requestSha256,
    `${c.caseId}: original request hash mismatch.`);
  let parsedRequest;
  try { parsedRequest = JSON.parse(record.requestBody); }
  catch { throw new Error(`${c.caseId}: original requestBody must contain serialized JSON.`); }
  noGrading(parsedRequest);
  // Preserve the archived decision verbatim, not a relabeled/re-scored substitute.
  check(hashPattern.test(record.decisionSha256)
    && jsonHash(record.decision) === record.decisionSha256
    && jsonHash(decision) === record.decisionSha256,
  `${c.caseId}: original decision hash mismatch.`);
  check(decision.requestSha256 === record.requestSha256
    && hasId(decision.profileId) && String(decision.profileId) === String(c.player.profile_id)
    && instagramProfileUrl(decision.accountUrl) !== null
    && instagramProfileUrl(decision.accountUrl) === instagramProfileUrl(candidate.url),
  `${c.caseId}: original decision is not bound to this request, artist and account.`);
  check(typeof decision.model === 'string' && decision.model.trim().length > 0,
    `${c.caseId}: original model identifier required.`);
  return {kind: 'historical_model_replay', originalRequestSha256: record.requestSha256,
    originalRequestBytes: Buffer.byteLength(record.requestBody), originalDecisionSha256: record.decisionSha256,
    model: decision.model, observedAt: decision.observedAt ?? null,
    verdict: decision.verdict, sameIdentityProbability: decision.sameIdentityProbability,
    bindingAssurance: 'Caller-supplied archived binding; hashes detect changes, not provenance authenticity.',
    sourceFactsSeenByHistoricalModel: 'not_asserted',
    warning: 'Historical decision replay only. Newly supplied website facts are not added to, or attributed to, the original model request.'};
}

/** Grading answers are not accepted, read or used to construct policy inputs. */
export function buildSourcePolicyImpact(input, settings) {
  const now = validateImpactSettings(settings);
  onlyKeys(input, ['schemaVersion', 'cases'], 'input');
  check(input.schemaVersion === IMPACT_SCHEMA, `schemaVersion must be ${IMPACT_SCHEMA}.`);
  check(Array.isArray(input.cases) && input.cases.length > 0, 'At least one captured case required.');
  noGrading(input);
  const ids = new Set(), occurrences = [], cases = [];
  for (const c of input.cases) {
    onlyKeys(c, ['caseId', 'player', 'result', 'websiteEvidence', 'historicalVerifiers'], 'case');
    check(typeof c.caseId === 'string' && c.caseId.trim() && !ids.has(c.caseId), 'Unique nonempty caseId required.');
    ids.add(c.caseId);
    check(hasId(c.player?.profile_id), `${c.caseId}: stable artist profile_id required.`);
    check(Array.isArray(c.result?.profiles), `${c.caseId}: original result.profiles required.`);
    check(c.result.profiles.every(p => p && typeof p === 'object' && !Array.isArray(p)),
      `${c.caseId}: malformed candidate.`);
    check(Array.isArray(c.websiteEvidence), `${c.caseId}: explicit supplied websiteEvidence array required (may be empty).`);
    check(Array.isArray(c.historicalVerifiers), `${c.caseId}: explicit historicalVerifiers array required (may be empty).`);
    check(c.historicalVerifiers.every(v => v && Number.isSafeInteger(v.candidateIndex)
      && v.candidateIndex >= 0 && v.candidateIndex < c.result.profiles.length),
    `${c.caseId}: invalid historical candidate index.`);
    const replay = c.result.profiles.map((p, i) => historicalBinding(c, p, i));
    // Both gates receive the exact same original player/result. Never augment
    // metadata, ownership context, cross-links or trust from labels/new pages.
    let baseline;
    try { baseline = assessInstagramCandidates(c.result, c.player); }
    catch (error) { baseline = {status: 'blocked', reason: error.message, urls: [], candidates: []}; }
    const proposed = {...assessOfflineSourcePolicy({player: c.player, result: c.result,
      websiteEvidence: c.websiteEvidence, config: settings.config, now}),
      nonImportable: true, simulatedUrlUsage: 'NON-IMPORTABLE / PRODUCTION-UNAPPROVED'};
    const sourceObservations = c.websiteEvidence.map((e, index) => ({
      index, suppliedObservationSha256: jsonHash(e), profileId: e?.profileId ?? null,
      kind: 'newly_supplied_policy_facts_not_historical_model_input',
      page: snapshotDiagnostics(e?.page, now, settings.config.maxEvidenceAgeMs),
      catalogDeclaration: snapshotDiagnostics(e?.catalogDeclaration, now, settings.config.maxEvidenceAgeMs),
    }));
    cases.push({caseId: c.caseId, profileId: String(c.player.profile_id),
      originalPlayerSha256: jsonHash(c.player), originalResultSha256: jsonHash(c.result),
      suppliedEvidenceSha256: jsonHash(c.websiteEvidence), baseline, proposed,
      sourceObservations, noCandidatesDoesNotConfirmAbsence: c.result.profiles.length === 0});
    c.result.profiles.forEach((p, index) => {
      const accountUrl = instagramProfileUrl(p.url), b = baseline.candidates[index],
        s = proposed.candidates[index];
      const boundEvidence = c.websiteEvidence.filter(e => e && String(e.profileId) === String(c.player.profile_id));
      occurrences.push({caseId: c.caseId, candidateIndex: index,
        profileId: String(c.player.profile_id), artist: c.player.artist ?? null,
        // An invalid URL is not silently grouped with another invalid account.
        accountUrl, suppliedAccountUrl: String(p.url ?? ''),
        baseline: {status: b?.status ?? 'blocked', reason: b?.reason ?? baseline.reason,
          accepted: accountUrl !== null && baseline.urls.includes(accountUrl)},
        proposed: {status: s?.route ?? 'blocked', reason: s?.reason ?? proposed.reason,
          accepted: s?.simulationAccepted === true, nonImportable: true, productionApproved: false,
          selectedSourcePacketSha256: s?.sourcePacketSha256 ?? null,
          selectedTrustPacketSha256: s?.trustPacketSha256 ?? null},
        replay: {...replay[index], freshness: timeState(p.jevVerification?.observedAt, now, settings.config.maxVerifierAgeMs)},
        conflicts: {contradictions: p.contradictions ?? [], conflictingProfileIds: p.conflictingProfileIds ?? [],
          identityMismatch: p.identityComparison?.status === 'mismatch' || p.jevVerification?.verdict === 'mismatch'},
        proof: {sourceObservationIndices: sourceObservations.filter(e => String(e.profileId) === String(c.player.profile_id)).map(e => e.index),
          missingWebsiteEvidence: !boundEvidence.some(e => e?.page),
          missingTrustDeclaration: !boundEvidence.some(e => e?.catalogDeclaration),
          ownershipContext: p.ownershipContext ?? 'missing',
          verifierMissing: replay[index].kind === 'no_historical_verifier'}});
    });
  }
  const grouped = new Map(), accounts = new Map();
  for (const row of occurrences) {
    const key = JSON.stringify([row.profileId, row.accountUrl ?? ['invalid', row.caseId, row.candidateIndex]]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
    if (row.accountUrl) {
      if (!accounts.has(row.accountUrl)) accounts.set(row.accountUrl, new Set());
      accounts.get(row.accountUrl).add(row.profileId);
    }
  }
  const pairs = [...grouped.values()].map(rows => {
    const aggregate = key => {
      const accepted = rows.every(r => r[key].accepted);
      return {accepted, occurrenceStatuses: [...new Set(rows.map(r => r[key].status))],
        reasons: [...new Set(rows.map(r => r[key].reason))],
        repeatedDecisionConflict: new Set(rows.map(r => r[key].accepted)).size > 1};
    };
    const first = rows[0], baseline = aggregate('baseline'), proposed = aggregate('proposed');
    return {profileId: first.profileId, artist: first.artist, accountUrl: first.accountUrl,
      occurrenceCount: rows.length, caseIds: [...new Set(rows.map(r => r.caseId))],
      baseline, proposed: {...proposed, nonImportable: true, productionApproved: false},
      change: baseline.accepted === proposed.accepted ? 'unchanged' : proposed.accepted ? 'new_simulated_acceptance' : 'new_simulated_hold',
      sharedAccountProfileIds: first.accountUrl ? [...accounts.get(first.accountUrl)].sort() : [],
      occurrences: rows};
  });
  const sharedAccounts = [...accounts].filter(([, artists]) => artists.size > 1)
    .map(([accountUrl, artists]) => ({accountUrl, profileIds: [...artists].sort(),
      warning: 'Account reused across artists; unresolved ownership risk, not resolved by a simulated acceptance.'}));
  return {schemaVersion: IMPACT_SCHEMA, policy: OFFLINE_SOURCE_POLICY, warning: WARNING,
    offlineOnly: true, nonImportable: true, productionApproved: false, claimsAllowed: false,
    defaultPolicyChanged: false, providerRequests: 0, databaseWrites: 0, noAccountConfirmed: false,
    settings: structuredClone(settings), inputObjectSha256: jsonHash(input),
    interpretation: [
      'Source-policy impact, not verifier accuracy or the live CSV outcome filter.',
      'Current gate is rerun unchanged on original captured metadata; this is not a saved historical gate result.',
      'Original model decisions are replayed, not re-evaluated. Newly supplied source facts are used only by the policy simulation.',
      'Repeated pairs use all-occurrences-pass aggregation; occurrence-level raw gate outputs are retained.',
      'Cross-artist shared accounts are flagged, not automatically adjudicated or silently removed.',
      'Missing trust remains missing. Hashes bind supplied bytes but do not authenticate capture provenance.',
      'No threshold calibration, held-out evaluation, population accuracy or production readiness claim.',
    ],
    counts: {cases: cases.length, candidateOccurrences: occurrences.length,
      distinctArtists: new Set(cases.map(c => c.profileId)).size, distinctAccounts: accounts.size,
      distinctPairs: pairs.filter(p => p.accountUrl).length,
      invalidAccountOccurrences: occurrences.filter(r => !r.accountUrl).length,
      repeatedPairs: pairs.filter(p => p.occurrenceCount > 1).length,
      repeatedOccurrences: pairs.reduce((n, p) => n + p.occurrenceCount - 1, 0),
      sharedAccounts: sharedAccounts.length, emptyCases: cases.filter(c => c.noCandidatesDoesNotConfirmAbsence).length,
      blockedCases: cases.filter(c => c.baseline.status === 'blocked' || c.proposed.status === 'blocked').length,
      baselineAcceptedPairs: pairs.filter(p => p.baseline.accepted).length,
      simulatedAcceptedPairs: pairs.filter(p => p.proposed.accepted).length,
      newSimulatedAcceptances: pairs.filter(p => p.change === 'new_simulated_acceptance').length,
      newSimulatedHolds: pairs.filter(p => p.change === 'new_simulated_hold').length},
    sharedAccounts, cases, pairs};
}

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\r\n]/g, ' ');
export function renderSourcePolicyImpact(report) {
  const lines = ['# Offline source-policy impact', '', report.warning, '',
    ...report.interpretation.map(s => `- ${s}`), '', '## Explicit experimental settings', '',
    '```json', JSON.stringify(report.settings, null, 2), '```', '', '## Counts', '',
    ...Object.entries(report.counts).map(([k, v]) => `- ${k}: ${v}`), '', '## Artist/account pairs', '',
    '| Artist ID | Artist | Simulated URL — NON-IMPORTABLE / PRODUCTION-UNAPPROVED | Current gate | Simulation | Change | Occurrences |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const p of report.pairs) {
    lines.push(`| ${escape(p.profileId)} | ${escape(p.artist)} | ${escape(p.accountUrl ?? 'invalid URL')} | ${p.baseline.accepted ? 'accept' : 'hold'} | ${p.proposed.accepted ? 'simulated accept' : 'hold'} | ${p.change} | ${p.occurrenceCount} |`);
  }
  lines.push('', '## Per-pair reasons and bindings', '');
  for (const p of report.pairs) {
    lines.push(`### ${escape(p.profileId)} / ${escape(p.accountUrl ?? 'invalid URL')}`, '',
      '- Simulated URL is NON-IMPORTABLE and PRODUCTION-UNAPPROVED.',
      `- Current reasons: ${escape(p.baseline.reasons.join('; '))}`,
      `- Proposed reasons: ${escape(p.proposed.reasons.join('; '))}`,
      `- Repeated decision conflict: current=${p.baseline.repeatedDecisionConflict}, proposed=${p.proposed.repeatedDecisionConflict}`,
      `- Shared account artist IDs: ${escape(p.sharedAccountProfileIds.join(', '))}`, '');
    for (const row of p.occurrences) {
      lines.push(`#### ${escape(row.caseId)} / candidate ${row.candidateIndex}`, '',
        '```json', JSON.stringify(row, null, 2), '```', '');
    }
  }
  lines.push('## Supplied source observations and case gate outputs', '',
    'Newly supplied policy facts are NOT asserted to have been seen by the historical model.',
    'The JSON report includes original-result hashes and complete gate outputs, including blocked and empty cases.', '');
  for (const c of report.cases) {
    lines.push(`### ${escape(c.caseId)}`, '', '```json', JSON.stringify(c, null, 2), '```', '');
  }
  return lines.join('\n');
}
