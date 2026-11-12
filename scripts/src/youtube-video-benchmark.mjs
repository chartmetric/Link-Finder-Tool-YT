// Offline measurement only. Labels are curated separately, never inferred from the heuristic.
import assert from 'node:assert/strict';
import {planVideoDiscovery, normalizeDiscoveryVideo} from './youtube-video-discovery-offline.mjs';

const key = (profileId, videoId) => `${profileId}/${videoId}`;
export function parseAdjudications(tsv) {
  const lines = tsv.trim().split(/\r?\n/);
  assert.equal(lines.shift(), 'profileId\tvideoId\trelevance\ttags\trationale');
  const seen = new Set();
  return lines.map(line => {
    const cells = line.split('\t');
    assert.equal(cells.length, 5);
    const [profileId, videoId, relevance, tags, rationale] = cells;
    assert.match(profileId, /^\d+$/);
    assert.ok(normalizeDiscoveryVideo(`https://youtu.be/${videoId}`));
    assert.ok(['relevant', 'unrelated', 'unknown'].includes(relevance));
    assert.ok(tags && rationale);
    const id = key(profileId, videoId);
    assert.ok(!seen.has(id), 'Duplicate adjudication: ' + id); seen.add(id);
    return {profileId, videoId, relevance, tags: tags.split(','), rationale};
  });
}

export function relevanceMetrics(rows, selected = () => true) {
  const population = rows.filter(selected);
  const count = label => population.filter(r => r.relevance === label).length;
  const relevant = count('relevant'), unrelated = count('unrelated'), unknown = count('unknown');
  return {total: population.length, relevant, unrelated, unknown, scored: relevant + unrelated,
    textRelevancePrecision: relevant + unrelated ? relevant / (relevant + unrelated) : null,
    unknownFraction: population.length ? unknown / population.length : null};
}
export function ownershipMetrics(rows) {
  const owned = rows.filter(r => r.artistOwnership === 'owned').length;
  const notOwned = rows.filter(r => r.artistOwnership === 'not_owned').length;
  const unknown = rows.filter(r => r.artistOwnership === 'unknown').length;
  assert.equal(owned + notOwned + unknown, rows.length, 'Missing ownership labels');
  return {total: rows.length, owned, notOwned, unknown, scored: owned + notOwned,
    artistOwnedChannelRate: owned + notOwned ? owned / (owned + notOwned) : null,
    // Identification bounds, NOT a confidence interval or population estimate.
    possibleOwnedFraction: rows.length ? [owned / rows.length, (owned + unknown) / rows.length] : null};
}

export function evaluateVideoBenchmark(cohort, annotations) {
  const labels = new Map(annotations.map(r => [key(r.profileId, r.videoId), r]));
  assert.equal(labels.size, annotations.length, 'Duplicate labels');
  const rows = [], breadth = [], used = new Set(), artists = new Set();
  for (const {artist, organic, provenance, originalCandidates} of cohort) {
    assert.ok(!artists.has(artist.profileId), 'Duplicate artist'); artists.add(artist.profileId);
    const planned = planVideoDiscovery(artist, organic, provenance);
    const queued = new Set(planned.resolutionQueue.map(v => v.videoId));
    const candidates = originalCandidates.map(c => ({url: c.url, channelId: c.canonicalChannelId ?? null}));
    assert.ok(candidates.length <= 2, 'Unexpected historical capture allocation');
    // Original channel captures identify direct candidates, not any video uploader.
    const knownIds = new Set(candidates.filter(c => c.channelId).map(c => c.channelId));
    const unresolved = candidates.filter(c => !c.channelId).length;
    const artistRows = [];
    for (const v of planned.videoClues) {
      const id = key(artist.profileId, v.videoId), label = labels.get(id);
      assert.ok(label, 'Missing adjudication: ' + id); used.add(id);
      const row = {...label, cmArtist: artist.cmArtist, artist: artist.name, url: v.url,
        eligible: v.eligible, queued: queued.has(v.videoId),
        deferred: v.eligible && !queued.has(v.videoId),
        actualUploaderIdentity: 'unknown', uploaderChannelId: null,
        uploaderEvidence: 'no_saved_video_to_channel_binding',
        catalogArtistIdentity: 'unknown', artistOwnership: 'unknown',
        ownershipEvidence: 'no_independently_bound_uploader_or_owner_evidence',
        sources: v.sources};
      rows.push(row); artistRows.push(row);
    }
    const eligible = artistRows.filter(r => r.eligible).length;
    const queue = artistRows.filter(r => r.queued).length;
    breadth.push({profileId: artist.profileId, cmArtist: artist.cmArtist, artist: artist.name,
      historicalSelectedAddresses: candidates.length, historicalDistinctKnownChannels: knownIds.size,
      historicalUnknownChannelIds: unresolved, originalCandidates: candidates,
      oneCaptureDirectRetentionCeiling: Math.min(candidates.length, 1),
      directAddressSlotsLost: Math.max(candidates.length - 1, 0),
      // No ranking of direct versus video candidates is specified by the proposal.
      directCandidatesActuallyRetained: null,
      videoClues: artistRows.length, eligibleVideos: eligible, queuedVideos: queue,
      deferredVideos: eligible - queue,
      relevantVideoClues: artistRows.filter(r => r.relevance === 'relevant').length,
      queuedRelevantVideos: artistRows.filter(r => r.queued && r.relevance === 'relevant').length,
      deferredRelevantVideos: artistRows.filter(r => r.deferred && r.relevance === 'relevant').length,
      normalizedDirectClueAddresses: planned.channelClues.length,
      possibleAdditionalUploaderChannels: [0, queue],
      candidateAddressCeilingBeforeCapture: planned.channelClues.length + queue,
      possibleDistinctChannelsLostAtCapture: [0, Math.max(0, planned.channelClues.length + queue - 1)],
      historicalOwnerLoss: null});
  }
  assert.equal(used.size, labels.size, 'Adjudications contain cases outside the cohort');
  const sum = field => breadth.reduce((n, r) => n + r[field], 0);
  const eligible = rows.filter(r => r.eligible), queue = rows.filter(r => r.queued);
  const relevant = rows.filter(r => r.relevance === 'relevant').length;
  const historicalSelected = sum('historicalSelectedAddresses');
  const directLost = sum('directAddressSlotsLost');
  const strata = {};
  for (const tag of [...new Set(rows.flatMap(r => r.tags))].sort()) {
    const group = rows.filter(r => r.tags.includes(tag));
    strata[tag] = {textRelevance: relevanceMetrics(group), queued: relevanceMetrics(group, r => r.queued),
      ownership: ownershipMetrics(group), actualUploaderEvidence: 'unknown'};
  }
  return {rows, breadth, summary: {
    mode: 'saved_evidence_only_not_executable', artists: cohort.length,
    distinctVideoIds: new Set(rows.map(r => r.videoId)).size, artistVideoPairs: rows.length,
    textRelevance: {all: relevanceMetrics(rows), eligible: relevanceMetrics(eligible),
      queued: relevanceMetrics(queue), deferred: relevanceMetrics(rows, r => r.deferred),
      eligibilityRecallAmongTextRelevant: relevant ? eligible.filter(r => r.relevance === 'relevant').length / relevant : null,
      queueRecallAmongTextRelevant: relevant ? queue.filter(r => r.relevance === 'relevant').length / relevant : null,
      // All unknown cases are excluded from these confusion counts, never called negatives.
      eligibilityConfusion: {
        truePositive: rows.filter(r => r.eligible && r.relevance === 'relevant').length,
        falsePositive: rows.filter(r => r.eligible && r.relevance === 'unrelated').length,
        falseNegative: rows.filter(r => !r.eligible && r.relevance === 'relevant').length,
        trueNegative: rows.filter(r => !r.eligible && r.relevance === 'unrelated').length,
        unscored: rows.filter(r => r.relevance === 'unknown').length}},
    uploaderIdentity: {known: 0, unknown: rows.length, queuedUnknown: queue.length},
    ownership: {all: ownershipMetrics(rows), queued: ownershipMetrics(queue),
      conclusion: 'Artist ownership frequency is not identifiable from these saved receipts; null is not zero.'},
    allocation: {historicalSelectedAddresses: historicalSelected,
      oneCaptureDirectRetentionCeiling: sum('oneCaptureDirectRetentionCeiling'),
      directAddressSlotsLost: directLost, directAddressLossFraction: historicalSelected ? directLost / historicalSelected : null,
      artistsLosingSecondDirectSlot: breadth.filter(r => r.directAddressSlotsLost).length,
      maximumCaptureSlotsBefore: cohort.length * 2, maximumCaptureSlotsAfter: cohort.length,
      eligibleVideos: eligible.length, queuedVideos: queue.length, deferredVideos: eligible.length - queue.length,
      videoDeferralFraction: eligible.length ? (eligible.length - queue.length) / eligible.length : null,
      deferredTextRelevantVideos: rows.filter(r => r.deferred && r.relevance === 'relevant').length,
      actualNewUploaderChannels: null, actualOwnedChannelsLost: null,
      interpretation: 'Direct retention is an optimistic ceiling with no video displacement. Video IDs and URL addresses are not distinct uploader channels. No direct-versus-video selection policy is authorized.'},
    strata,
    safety: {providerCalls: 0, catalogWrites: 0, acceptanceChanges: 0, campaignActivations: 0,
      executable: false, approvalInherited: false}
  }};
}
