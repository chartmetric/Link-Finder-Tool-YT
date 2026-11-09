import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evidenceMatrix, runEvidenceFixture } from './instagram-verification-evidence-matrix.mjs';
import { auditSavedVerification } from './instagram-verification-evidence-audit.mjs';

// Guard the entire offline suite, including imports' runtime behavior, from HTTP.
globalThis.fetch = async () => { throw new Error('Network forbidden in offline evidence fixtures'); };

for (const fixture of evidenceMatrix) {
  test(`${fixture.category}: ${fixture.id}`, async () => {
    const row = await runEvidenceFixture(fixture);
    assert.equal(row.observed, fixture.expected);
    assert.equal(row.unchanged, true, 'serializer and gate must not mutate input evidence');
    assert.ok(Buffer.byteLength(row.serialized) <= 6000);
    assert.equal(row.assessment.approvedCatalogLinks, false);
    assert.equal(row.assessment.noAccountConfirmed, false);
    assert.equal(row.assessment.urls.length, fixture.expected === 'supported' ? 1 : 0);
    assert.doesNotMatch(row.serialized, /positive_contract|model_disagreement|expected|syntheticModelResponse/);
    const item = row.request.state.candidates[0];
    if (row.reads.length) {
      const music = item.candidate.musicLinkPath;
      assert.equal(music.ownershipAssessment, 'unassessed');
      assert.equal(Object.hasOwn(music, 'ownershipConfirmed'), false);
      assert.equal(row.payload.profiles[0].identityComparison.candidate.externalLinkEvidence.ownershipConfirmed, false);
      assert.deepEqual(item.observedExactCatalogLinks, [], 'derived music link must not become a direct bio observation');
      if (!['unavailable', 'multi_artist', 'wrong_artist'].includes(fixture.evidence)) {
        assert.equal(music.status, 'exact_catalog_music_identity');
        assert.equal(music.pages.length, 3);
        assert.ok(music.pages[0].musicTargets.includes(music.pages[1].contentUrl));
        assert.ok(music.pages[1].musicTargets.includes(music.pages[2].contentUrl));
        assert.deepEqual(music.pages[2].creditedArtistUrls, [row.payload.catalogReference.url]);
      }
    }
    if (fixture.evidence === 'multi_artist' || fixture.evidence === 'wrong_artist') {
      assert.equal(item.candidate.musicLinkPath.status, 'unresolved');
    }
    if (fixture.evidence === 'direct') assert.equal(item.observedExactCatalogLinks[0].source, 'instagram_profile_bio_link');
    if (fixture.evidence === 'reciprocal') assert.equal(item.observedExactCatalogLinks[0].source, 'catalog_profile_link_to_instagram');
    if (fixture.evidence === 'unbound') assert.deepEqual(item.observedExactCatalogLinks, []);
    const question = row.request.questions.candidate_0_same_identity;
    assert.equal(question.type, 'noul');
    assert.doesNotMatch(question.criteria.false, /missing|insufficient/i);
    assert.match(question.instructions, /uncertainty, not mismatch/);
  });
}

test('missing archives fail explicitly rather than retrieving fresh evidence', async () => {
  await assert.rejects(auditSavedVerification('/nonexistent-offline-archive'), /ENOENT/);
});

test('audit binds the saved response, reports oversize reconstruction, and never changes source files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-evidence-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'responses'));
  const row = await runEvidenceFixture(evidenceMatrix[0]);
  const profile = structuredClone(row.payload.profiles[0]);
  // Exercise the report's size failure without dispatch or loss of source data.
  profile.identityComparison.reference.displayName = 'x'.repeat(7000);
  const summary = { results: [
    { profileId: 'prior', rawResult: { profiles: [profile] } },
    { profileId: 'fixture', catalogReferences: [row.payload.catalogReference],
      candidates: row.assessment.candidates, rawResult: { profiles: [profile] } },
  ] };
  const packet = { kind: 'jev', profileId: 'fixture', status: 200, data: { model: 'fixture-model',
    answers: { candidate_0_same_identity: { noul: 0.95 }, candidate_0_verdict: { choice: 'verified', confidence: 0.8 } } } };
  const sources = {
    'summary.json': JSON.stringify(summary),
    'responses/fixture.json': JSON.stringify(packet),
    'admissions.jsonl': '{"preserved":"no-replay"}\n',
  };
  for (const [name, value] of Object.entries(sources)) await fs.writeFile(path.join(dir, name), value);
  const report = await auditSavedVerification(dir);
  assert.equal(report.providerRequests, 0);
  assert.equal(report.historicalRequestAvailable, false);
  assert.equal(report.currentReconstruction.withinUnchanged6000ByteLimit, false);
  assert.equal(report.candidates[0].savedDecision.identityScore, 0.95);
  assert.equal(report.candidates[0].savedDecision.verdictLabelConfidence, 0.8);
  assert.equal(report.matrix.every(row => row.passed), true);
  for (const [name, value] of Object.entries(sources)) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), value);
  packet.data.answers.candidate_0_same_identity.noul = 0.1;
  await fs.writeFile(path.join(dir, 'responses/fixture.json'), JSON.stringify(packet));
  await assert.rejects(auditSavedVerification(dir), /summary disagree/);
});
