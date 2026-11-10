// Local, read-only launch gate. No credentials, HTTP, database or claim writer.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {assessInstagramCandidates, MATCHING_POLICY} from './musician-instagram-matching.mjs';

export const CORRECTION_PURPOSE = 'musician_instagram_attribution_correction';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(JSON.stringify(value));
const digest = value => assert.match(value, /^[a-f0-9]{64}$/, 'Missing SHA-256 binding.');
const nonempty = value => assert.ok(typeof value === 'string' && value.trim(), 'Missing approval/provenance.');
const timestamp = value => {
  assert.ok(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value), 'Missing UTC timestamp.');
  const n = Date.parse(value);
  assert.ok(Number.isFinite(n), 'Invalid timestamp.');
  return n;
};
const scope = {purpose:CORRECTION_PURPOSE, profileType:'musician', platform:'instagram', tiers:[1,2,3,4,5]};
const sourceFiles = [
  'instagram-pilot-live-transport.mjs', 'instagram-ownership-rubric.mjs',
  'musician-instagram-matching.mjs', 'musician-instagram-identity-verification.mjs',
  'instagram-search-clues.mjs', 'public-music-links.mjs', 'catalog-album-evidence.mjs',
  'safe-music-fetch.mjs', 'instagram-pilot-runner.mjs',
  'instagram-pilot-live.mjs', 'instagram-pilot-budget.mjs', 'musician-instagram-research.mjs',
  'instagram-correction-readiness.mjs',
];

// Hash the actual serializer/instructions and evidence/gate code, not a caller's
// asserted version string. Code/prompt changes invalidate prior approvals.
export async function correctionContract() {
  const implementation = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
    [file, sha256(await fs.readFile(new URL(file, import.meta.url)))])));
  return {
    requestedModel:jevRequest({artist:'schema', catalogReference:{url:'schema'}, profiles:[]}).model,
    requestSchemaSha256:implementation['instagram-pilot-live-transport.mjs'],
    implementation,
    acceptanceRules:{policy:MATCHING_POLICY, verdict:'verified', minimumIdentityProbability:0.9,
      exactCatalogCrossLinkRequired:true, likelyComparisonRequired:true,
      relatedEntityAndMismatchSafeguards:true, ingestion:'account_links/claims.record/resolve-only'},
  };
}

export function refuseCorrectionInResearch(manifest) {
  if (manifest?.purpose === CORRECTION_PURPOSE || manifest?.runPurpose === CORRECTION_PURPOSE) {
    throw new Error('Attribution corrections cannot use a discovery or pilot executor. Use the guarded run-correction entrypoint.');
  }
}

// File references are relative to their containing document. Every byte is
// pinned; a missing/unreadable/changed file is a hold, never an empty result.
async function boundFile(parent, ref, json = true) {
  nonempty(ref?.file); digest(ref?.sha256);
  const file = path.resolve(path.dirname(parent), ref.file);
  const bytes = await fs.readFile(file);
  assert.equal(sha256(bytes), ref.sha256, 'Changed benchmark artifact.');
  return {file, value:json ? JSON.parse(bytes.toString('utf8')) : bytes};
}

/** Approval is a trusted operator-authored local artifact, not a client flag.
 * Freshness and expected case outcomes MUST be selected by the approving user;
 * this module supplies no default benchmark rates, sample size or age limits.
 */
export async function checkCorrectionReadiness(launchFile, {now = Date.now()} = {}) {
  assert.ok(Number.isFinite(now), 'Invalid readiness clock.');
  const launch = JSON.parse(await fs.readFile(launchFile, 'utf8'));
  assert.equal(launch.version, 1);
  assert.deepEqual(launch.scope, scope, 'Not a Tier 1–5 musician correction launch.');
  const {file:policyFile, value:policy} = await boundFile(launchFile, launch.policy);
  assert.equal(policy.version, 1);
  assert.deepEqual(policy.scope, scope);
  const approval = policy.approval;
  assert.equal(approval?.approved, true, 'Benchmark policy is not explicitly approved.');
  assert.equal(approval.approvedBy, 'user');
  nonempty(approval.reference);
  const approvedAt = timestamp(approval.approvedAt);
  assert.ok(approvedAt <= now && now < timestamp(approval.expiresAt), 'Benchmark approval is stale.');
  for (const age of [policy.maxResultAgeMs, policy.maxEvidenceAgeMs]) {
    assert.ok(Number.isSafeInteger(age) && age > 0, 'An approved freshness policy is required.');
  }
  const contract = await correctionContract();
  assert.deepEqual(policy.contract, {...contract, resolvedModel:policy.contract?.resolvedModel},
    'Model, request schema, evidence implementation or acceptance rules changed.');
  nonempty(policy.contract.resolvedModel);
  const acceptanceRulesSha256 = jsonHash(contract.acceptanceRules);
  const {file:suiteFile, value:suite} = await boundFile(policyFile, policy.suite);
  assert.equal(suite.preparationOnly, false, 'Preparation-only benchmarks cannot authorize a correction.');
  assert.equal(suite.purpose, CORRECTION_PURPOSE);
  assert.equal(suite.labelReview?.approved, true, 'Benchmark labels require independent review.');
  nonempty(suite.labelReview.reference);
  assert.ok(Array.isArray(suite.cases) && suite.cases.length > 0, 'No benchmark cases.');
  // A reject-everything scorecard or provisional/unadjudicated sample cannot pass.
  assert.ok(suite.cases.some(c => c.expectedArtistOwned === true), 'No known-positive recovery checks.');
  assert.ok(suite.cases.some(c => c.expectedArtistOwned === false), 'No known-negative checks.');
  const {file:resultsFile, value:results} = await boundFile(launchFile, launch.results);
  assert.equal(results.status, 'completed', 'Benchmark results are incomplete or failed.');
  assert.equal(results.fixtureOnly, false, 'Fixtures cannot authorize paid runs.');
  assert.equal(results.policySha256, launch.policy.sha256);
  assert.equal(results.suiteSha256, policy.suite.sha256);
  assert.equal(results.acceptanceRulesSha256, acceptanceRulesSha256);
  assert.deepEqual(results.contract, policy.contract);
  const startedAt = timestamp(results.startedAt), completedAt = timestamp(results.completedAt);
  assert.ok(approvedAt <= startedAt && startedAt <= completedAt && completedAt <= now
    && now - completedAt <= policy.maxResultAgeMs, 'Benchmark results are stale or predate approval.');
  assert.ok(Array.isArray(results.cases) && results.cases.length === suite.cases.length,
    'Incomplete benchmark coverage.');
  const seen = new Set(), rows = [];
  for (const c of suite.cases) {
    nonempty(c.id); nonempty(c.labelProvenance);
    assert.ok(!seen.has(c.id), 'Duplicate benchmark case.'); seen.add(c.id);
    assert.equal(typeof c.expectedArtistOwned, 'boolean', 'Unadjudicated benchmark label.');
    // These outcomes are explicitly reviewed in the approved suite, not inferred
    // from whichever decisions happened to be returned.
    assert.equal(c.requiredModelAccepted, c.expectedArtistOwned);
    assert.equal(c.requiredApplicationAccepted, c.expectedArtistOwned);
    const matches = results.cases.filter(r => r.id === c.id);
    assert.equal(matches.length, 1, 'Missing or duplicate benchmark result.');
    const r = matches[0];
    assert.equal(r.status, 'completed', 'Failed benchmark case.');
    assert.equal(r.stage, 'blind_discovery_and_verification', 'Verifier-only diagnostics are not full readiness.');
    const {value:input} = await boundFile(suiteFile, c.input);
    assert.equal(input.player.profile_id, c.profileId);
    assert.equal(input.payload.artist, input.player.artist);
    // Compare the actual JSON wire representation; undefined optional metadata
    // properties are not serialized by the transport.
    const request = JSON.parse(JSON.stringify(jevRequest(input.payload)));
    assert.equal(request.model, contract.requestedModel);
    assert.equal(r.inputSha256, c.input.sha256);
    assert.equal(r.requestSha256, jsonHash(request), 'Changed exact verifier request.');
    assert.equal(r.evidenceSha256, jsonHash(input.payload), 'Changed evidence payload.');
    assert.ok(input.payload.profiles.length > 0 && input.payload.profiles.every(p =>
      suite.cases.some(peer => peer.input.sha256 === c.input.sha256 && peer.url === p.url)),
    'Every evaluated candidate needs an approved expected outcome.');
    assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 6000, 'Request exceeds the unchanged input ceiling.');
    assert.ok(Array.isArray(c.sources) && c.sources.length > 0, 'Missing source evidence hashes.');
    for (const source of c.sources) {
      const observedAt = timestamp(source.observedAt);
      assert.ok(observedAt <= completedAt && now - observedAt <= policy.maxEvidenceAgeMs,
        'Source evidence is stale or has an unknown observation date.');
      await boundFile(suiteFile, source, false);
    }
    const {value:packet} = await boundFile(resultsFile, r.response);
    const {value:journal} = await boundFile(resultsFile, r.journal);
    nonempty(r.admissionKey);
    assert.ok(Array.isArray(journal), 'Missing admission reconciliation.');
    const admissions = journal.filter(e => e.key === r.admissionKey);
    assert.deepEqual(admissions.map(e => e.phase), ['admitted','returned'],
      'Failed, uncertain or replayed benchmark admission.');
    assert.equal(admissions[0].profileId, c.profileId);
    assert.equal(admissions[0].kind, 'jev');
    const observedAt = timestamp(packet.at);
    assert.ok(observedAt >= startedAt && observedAt <= completedAt, 'Response is outside the approved benchmark.');
    assert.equal(packet.status, 200, 'Failed verifier request.');
    assert.ok(!packet.data?.error, 'Verifier error.');
    assert.equal(packet.data?.model, policy.contract.resolvedModel, 'Resolved model changed.');
    assert.equal(packet.requestBodySha256, r.requestSha256);
    assert.deepEqual(packet.decisionRequest, request);
    assert.ok(input.payload.profiles.some(p => p.url === c.url), 'Expected account was not independently recovered.');
    assert.ok(input.discovery.profiles.some(p => p.url === c.url), 'Known answer missing from blind discovery.');
    // The reviewed input includes blind-discovery provenance. No supplied-label
    // recovery may be rebranded as independent discovery.
    assert.equal(input.discovery.knownAnswerUsedAsInput, false);
    const profiles = input.payload.profiles.map((p, i) => {
      const probability = packet.data.answers?.[`candidate_${i}_same_identity`]?.noul;
      const verdict = packet.data.answers?.[`candidate_${i}_verdict`]?.choice;
      assert.ok(Number.isFinite(probability) && probability >= 0 && probability <= 1, 'Missing/invalid identity score.');
      assert.ok(['verified','likely','uncertain','mismatch'].includes(verdict), 'Missing/invalid verdict.');
      return {...p, jevVerification:{verdict, sameIdentityProbability:probability}};
    });
    const target = profiles.find(p => p.url === c.url);
    const modelAccepted = target.jevVerification.verdict === 'verified'
      && target.jevVerification.sameIdentityProbability >= contract.acceptanceRules.minimumIdentityProbability;
    const assessed = assessInstagramCandidates({...input.discovery, profiles}, input.player);
    const applicationAccepted = assessed.urls.includes(c.url);
    assert.equal(modelAccepted, c.requiredModelAccepted, 'Known-account model check failed.');
    assert.equal(applicationAccepted, c.requiredApplicationAccepted, 'Known-account evidence/acceptance check failed.');
    rows.push({id:c.id, modelAccepted, applicationAccepted});
  }
  // Readiness is not paid-run approval. Both must be present and bound.
  const paid = launch.paidApproval;
  assert.equal(paid?.approved, true, 'Separate explicit paid-run approval required.');
  assert.equal(paid.approvedBy, 'user'); nonempty(paid.reference);
  assert.equal(paid.policySha256, launch.policy.sha256);
  assert.equal(paid.resultsSha256, launch.results.sha256);
  const paidAt = timestamp(paid.approvedAt);
  assert.ok(paidAt >= completedAt && paidAt <= now && now < timestamp(paid.expiresAt), 'Paid approval is stale.');
  assert.ok(Number.isSafeInteger(paid.maxSpendCents) && paid.maxSpendCents > 0 && paid.maxSpendCents <= 1000,
    'Conservative $10 ceiling must not be increased by this guard.');
  assert.ok(Number.isSafeInteger(paid.priorReservedCents) && paid.priorReservedCents >= 0
    && paid.priorReservedCents + paid.maxSpendCents <= 1000, 'Original conservative budget exceeded.');
  assert.equal(launch.automaticRetries, 0);
  assert.equal(launch.ingestion, 'account_links/claims.record/resolve-only');
  return {ready:true, policySha256:launch.policy.sha256, resultsSha256:launch.results.sha256,
    contractSha256:jsonHash(policy.contract), rows, maxSpendCents:paid.maxSpendCents,
    paidRequestsStarted:0, claimsSubmitted:0};
}

/** The repository has discovery/no-match launchers, but no correction executor.
 * Never hand a ready receipt to those incompatible executors or uncap a pilot.
 * A future executor must recheck this gate at launch/admission, journal and
 * reserve every provider call, and implement only claims.record/resolve ingestion.
 */
export async function launchCorrection(launchFile) {
  await checkCorrectionReadiness(launchFile);
  throw new Error('Correction execution remains disabled: no budgeted attribution-correction executor is installed. Readiness is not execution.');
}
