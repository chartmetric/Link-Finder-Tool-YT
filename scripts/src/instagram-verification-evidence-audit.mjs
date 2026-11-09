// Read-only audit: no live mode, transport dispatch, database, claims or journal writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jevRequest } from './instagram-pilot-live-transport.mjs';
import { evidenceMatrix, runEvidenceFixture } from './instagram-verification-evidence-matrix.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const defaultAuditSource = 'generated-artifacts/musician-instagram-verification-pilot-2026-11-05/live-updated-remaining-989/complete-unsent-frankelly-jev';

export async function auditSavedVerification(source = defaultAuditSource) {
  const summaryBytes = await fs.readFile(path.join(source, 'summary.json'));
  const summary = JSON.parse(summaryBytes);
  const files = (await fs.readdir(path.join(source, 'responses'))).filter(f => f.endsWith('.json'));
  const packets = await Promise.all(files.map(async name => {
    const bytes = await fs.readFile(path.join(source, 'responses', name));
    return { name, sha256: hash(bytes), packet: JSON.parse(bytes) };
  }));
  // Bind to the completion's own response rather than prior results carried in
  // the summary; never select by a supplied artist name or known account URL.
  const matches = packets.filter(p => p.packet.kind === 'jev');
  if (matches.length !== 1 || matches[0].packet.status !== 200) throw new Error('Missing unique successful saved JEV packet.');
  const { packet } = matches[0];
  const results = summary.results.filter(r => r.profileId === packet.profileId && r.rawResult?.profiles);
  if (results.length !== 1) throw new Error('Missing unique summary result bound to the completion response.');
  const result = results[0];
  if (result.catalogReferences.length !== 1) throw new Error('Expected one bound catalog reference.');
  const payload = { artist: result.rawResult.profiles[0].identityComparison.reference.displayName,
    catalogReference: result.catalogReferences[0], profiles: result.rawResult.profiles };
  const request = jevRequest(payload);
  const serialized = JSON.stringify(request);
  return {
    mode: 'offline-only', providerRequests: 0, claimsSubmitted: 0, databaseWrites: 0,
    sourceSummarySha256: hash(summaryBytes),
    sourceResponse: { file: matches[0].name, sha256: matches[0].sha256, status: packet.status, model: packet.data.model },
    historicalRequestAvailable: Boolean(packet.decisionRequest),
    currentReconstruction: { bytes: Buffer.byteLength(serialized), sha256: hash(serialized),
      withinUnchanged6000ByteLimit: Buffer.byteLength(serialized) <= 6000,
      warning: 'Current serializer applied to historical saved metadata, not proof of the historical outgoing bytes or a new model result.' },
    candidates: payload.profiles.map((profile, i) => {
      const answer = packet.data.answers[`candidate_${i}_same_identity`];
      const verdict = packet.data.answers[`candidate_${i}_verdict`];
      if (answer?.noul !== profile.jevVerification.sameIdentityProbability
        || verdict?.choice !== profile.jevVerification.verdict) throw new Error('Saved decision and summary disagree.');
      const savedGate = result.candidates.find(c => c.url === profile.url);
      if (!savedGate) throw new Error('Missing gate assessment bound to the candidate URL.');
      const originalPath = profile.identityComparison.candidate.externalLinkEvidence;
      return { url: profile.url,
        savedDecision: { identityScore: answer.noul, verdict: verdict.choice,
          verdictLabelConfidence: verdict.confidence },
        savedGate,
        directLinkProvenance: profile.identityComparison.candidate.directExternalUrls
          ? 'explicit' : originalPath ? 'legacy enriched; not asserted direct' : 'legacy metadata',
        savedMusicPath: originalPath ?? null,
        serializedMusicPath: request.state.candidates[i].candidate.musicLinkPath ?? null,
        serializedExactDirectLinks: request.state.candidates[i].observedExactCatalogLinks };
    }),
    matrix: await Promise.all(evidenceMatrix.map(async fixture => {
      const row = await runEvidenceFixture(fixture);
      return { ...fixture, observed: row.observed, passed: row.observed === fixture.expected,
        syntheticModelResponse: true, publicFixtureReads: row.reads.length };
    })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('--')) {
    throw new Error('Usage: node scripts/src/instagram-verification-evidence-audit.mjs [completion-archive-directory]; no live mode.');
  }
  const audit = await auditSavedVerification(process.argv[2]);
  console.log(JSON.stringify(audit, null, 2));
  if (audit.matrix.some(row => !row.passed)) process.exitCode = 1;
}
