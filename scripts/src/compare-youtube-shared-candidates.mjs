// Local files only. Run with youtube-ownership-offline-fence.mjs preloaded.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
import {compareSharedYoutubeCandidates} from './youtube-shared-candidate-offline.mjs';

const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(root, prefix = '') {
  const result = {};
  for (const entry of (await fs.readdir(root, {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name), key = prefix + entry.name;
    if (entry.isSymbolicLink()) result[key] = 'symlink:' + await fs.readlink(file);
    else if (entry.isDirectory()) Object.assign(result, await fingerprint(file, key + '/'));
    else result[key] = byteHash(await fs.readFile(file));
  }
  return result;
}
export async function compareArchive(root, output) {
  root = path.resolve(root); output = path.resolve(output);
  const audit = root + '-offline-review';
  assert.ok(output.startsWith(path.resolve('generated-artifacts') + '/'), 'Use an ignored report directory');
  for (const source of [root, audit])
    assert.ok(output !== source && !output.startsWith(source + '/') && !source.startsWith(output + '/'),
      'Never write inside or over a source archive');
  const before = {archive:await fingerprint(root), offlineReview:await fingerprint(audit)};
  const read = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
  const plan = await read(root, 'plan.json'), approval = await read(root, 'approval.json');
  assert.equal(hash(plan.artists), plan.scopeSha256);
  assert.equal(approval.planSha256, hash(plan));
  assert.equal(approval.scopeSha256, plan.scopeSha256);
  const packets = await read(root, 'supplemental-catalog/packets.json');
  assert.equal(hash(packets), plan.catalogEvidenceSha256);
  // Load the exact frozen assembler, never today's evidence collector.
  for (const [file, expected] of Object.entries(plan.runtimeFiles)) {
    assert.equal(path.basename(file), file);
    assert.equal(hash(await fs.readFile(path.join(root, 'runtime', file), 'utf8')), expected);
  }
  const {assembleYoutubeOwnershipEvidence} = await import(path.join(root, 'runtime/youtube-ownership-evidence.mjs'));
  const summary = await read(audit, 'summary.json'), detail = await read(audit, 'evidence-detail.json');
  const occurrences = [], exactInputs = [];
  for (const selected of plan.artists) {
    const record = await read(root, `artists/${selected.profile_id}.json`);
    assert.equal(String(record.artist.profileId), String(selected.profile_id));
    assert.equal(String(record.artist.cmArtist), String(selected.cm_artist));
    const packet = packets.find(p => String(p.profileId) === String(selected.profile_id));
    const originalPolicy = await import(path.join(root, 'runtime/youtube-ownership-policy.mjs'));
    for (const candidate of record.candidates) {
      const historical = detail.find(d => String(d.profileId) === String(selected.profile_id))
        ?.candidateDecisions.find(c => c.url === candidate.url);
      assert.deepEqual(historical?.decision, candidate.decision);
      assert.deepEqual(historical.recordedAnswer, candidate.recordedAnswer?.answer ?? null);
      const reconstructed = originalPolicy.youtubeVerificationInput({...record.artist,
        ownershipEvidence:assembleYoutubeOwnershipEvidence(record.artist, packet, candidate)}, candidate);
      // Held pairs have no outgoing model input. A reconstructed input is usable
      // here only if its digest exactly equals the archived pre-model decision.
      const input = candidate.metadataActuallyUsed ?? reconstructed;
      assert.equal(input.inputSha256, candidate.decision.inputSha256);
      assert.deepEqual(input, reconstructed);
      if (candidate.recordedAnswer) {
        assert.equal(candidate.recordedAnswer.inputSha256, input.inputSha256);
        const receiptFiles = await fs.readdir(path.join(root, 'receipts'));
        let receipt;
        for (const file of receiptFiles) {
          const bytes = await fs.readFile(path.join(root, 'receipts', file));
          if (byteHash(bytes) === candidate.recordedAnswer.receiptSha256) receipt = JSON.parse(bytes);
        }
        assert.ok(receipt, 'Missing exact model receipt');
        assert.equal(hash(receipt.request), candidate.recordedAnswer.requestSha256);
        assert.deepEqual(receipt.request.body.state, {...input.state, evidenceRules:input.rules});
      }
      exactInputs.push({profileId:record.artist.profileId, url:candidate.url,
        origin:candidate.metadataActuallyUsed ? 'archived_model_input' : 'frozen_reconstruction_matching_archived_pre_model_hash',
        input});
      occurrences.push({input, originalCandidate:candidate, historicalDecision:candidate.decision,
        recordedAnswer:candidate.recordedAnswer ?? null,
        contradictoryPair:candidate.contradictoryPair ?? false,
        channelAliasObservations:candidate.channelAliasObservations ?? []});
    }
  }
  assert.equal(occurrences.length, summary.candidatePairs);
  const comparisons = compareSharedYoutubeCandidates(occurrences);
  const shared = comparisons.filter(r => r.historicalDecision.reason === 'channel_reused_across_catalog_artists');
  assert.equal(shared.length, summary.policyReasons.channel_reused_across_catalog_artists);
  const report = {policyEnabled:false, approvalRequired:true, sourceArchive:root,
    scopeSha256:plan.scopeSha256, originalAudit:summary,
    counts:{artists:plan.artists.length, pairs:comparisons.length, blanketSharedHolds:shared.length,
      proposedArtistSpecificReviews:shared.filter(r => r.proposedRoute === 'artist_specific_identity_review_required').length,
      sourceSupportedCompetingClaimHolds:shared.filter(r => r.proposedRoute === 'hold_competing_source_supported_claims').length,
      accepted:0, newModelChecks:0, paidCalls:0, catalogWrites:0, historicalChanges:0},
    comparisons};
  const after = {archive:await fingerprint(root), offlineReview:await fingerprint(audit)};
  assert.deepEqual(after, before, 'Historical archive changed during comparison');
  // Exclusive directory: rerunning cannot overwrite a previous report either.
  await fs.mkdir(output);
  const write = (name, data) => fs.writeFile(path.join(output, name), JSON.stringify(data, null, 2) + '\n', {flag:'wx'});
  await write('comparison.json', report);
  await write('exact-inputs.json', exactInputs);
  await write('archive-proof.json', {before, after, unchanged:true});
  const lines = shared.map(r => {
    const a = r.reviewState.originalInput.state.artist;
    return `| ${a.name} | ${r.pair.profileId} / ${r.pair.cmArtist} | ${r.proposedRoute} | ${a.accounts.filter(a => a.platform === 'spotify').length} | unknown |`;
  });
  await fs.writeFile(path.join(output, 'review.md'), `# Shared YouTube candidate comparison

Offline proposal only; disabled pending explicit approval. No automatic acceptance.

${report.counts.pairs} original candidate pairs; ${shared.length} blanket shared-channel holds.
${report.counts.proposedArtistSpecificReviews} pairs would instead require separate artist-specific review, not become accepted.
All historical answers and both source directories were preserved byte-for-byte.

| Artist | Exact profile / music catalog ID | Proposed route | Frozen Spotify references | Ownership |
| --- | --- | --- | --- | --- |
${lines.join('\n')}

The repeated Suzi channel is UCVbraeFV_56E1Ygj3zsOXew. Collaborator names in release snippets explain possible discovery overlap, not ownership.
Its Apple artist link is retained, but none of these frozen packets binds it to the catalog artist. The Spotify link is a playlist, not an artist ID.
Suzi has no frozen Spotify reference; its same-name channel is not declared correct.
No owner was established, no model result was predicted, and no acceptance threshold was changed.

comparison.json retains every occurrence, historical decision and answer, source-bound claims, contradictory evidence and per-pair assessment hashes.
exact-inputs.json distinguishes actual outgoing inputs from reconstructions matching the exact frozen pre-model decision hashes.
A proposal assessment includes all peer evidence and must never reuse an original answer or another artist's assessment.
archive-proof.json fingerprints every file before and after in the original archive and its sibling offline review.
`, {flag:'wx'});
  return report.counts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2, 'Usage: compare-youtube-shared-candidates.mjs SOURCE_ARCHIVE NEW_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await compareArchive(...args)));
}
