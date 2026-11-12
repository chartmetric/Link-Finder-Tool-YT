// Offline review only: no transport, credentials, database, approval writer or CLI.
import assert from 'node:assert/strict';
import {TextDecoder} from 'node:util';
import {digest, normalizeDiscoveryChannel, normalizeDiscoveryVideo, proposedUploaderRequest,
  proposedVideoAllocation, resolveSavedUploader} from './youtube-video-discovery-offline.mjs';

const sha = /^[a-f0-9]{64}$/;
const channelId = /^UC[A-Za-z0-9_-]{22}$/;
const kinds = ['search', 'video_uploader', 'metadata', 'model'];
const pair = value => JSON.stringify([value.profileId, value.cmArtist]);
const copy = value => JSON.parse(JSON.stringify(value));
function artistIdentity(artist) {
  assert.match(artist.profileId, /^\d+$/);
  assert.match(artist.cmArtist, /^\d+$/);
  assert.ok(typeof artist.name === 'string' && artist.name.trim());
  return {profileId: artist.profileId, cmArtist: artist.cmArtist, name: artist.name};
}
function archivePath(value) {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value)
    && !value.startsWith('/') && !value.split('/').some(p => ['', '.', '..'].includes(p)),
  'An immutable workspace-relative receipt path is required');
  return value;
}
function reviewContext(context) {
  assert.match(context.runId, /^youtube-video-review-[a-z0-9][a-z0-9-]{3,80}$/);
  assert.match(context.planSha256, sha);
}

// Bytes must have been saved before this pure mapper is called. Returning base64
// preserves the exact bytes, not a JSON reserialization. This does not persist them.
export function mapSavedVideoUploader(artist, clue, receipt, context) {
  reviewContext(context);
  const bound = artistIdentity(artist), op = clue.operation;
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.planSha256, context.planSha256);
  assert.equal(receipt.profileId, bound.profileId);
  assert.equal(receipt.cmArtist, bound.cmArtist);
  assert.equal(receipt.videoId, clue.videoId);
  assert.equal(receipt.operationKey, op.key);
  assert.equal(receipt.kind, 'video_uploader');
  assert.deepEqual(receipt.request, proposedUploaderRequest(clue.url));
  assert.equal(receipt.inputSha256, digest(receipt.request));
  assert.equal(receipt.status, 200, 'Provider failure is unresolved, never no-match');
  assert.ok(Buffer.isBuffer(receipt.rawBody), 'Original raw response bytes required');
  assert.ok(receipt.rawBody.length > 0 && receipt.rawBody.length <= 2 * 1024 * 1024,
    'Empty or oversized receipt blocks mapping');
  assert.equal(receipt.rawBodySha256, digest(receipt.rawBody));
  const rawPath = archivePath(receipt.rawPath);
  assert.ok(typeof receipt.capturedAt === 'string' && Number.isFinite(Date.parse(receipt.capturedAt)));
  const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(receipt.rawBody));
  assert.equal(body.success, true);
  assert.equal(body.id, clue.videoId, 'Provider returned a different video');
  assert.equal(normalizeDiscoveryVideo(body.url)?.videoId, clue.videoId);
  assert.ok(channelId.test(body.channel?.id ?? ''), 'Missing documented channel.id');
  // Never fall back to related-video channels, collaborators, snippets or titles.
  for (const identity of [body.uploader, body.ownerByline]) {
    if (identity != null) assert.equal(identity.channelId, body.channel.id,
      'Conflicting or incomplete provider uploader identity');
  }
  assert.ok(typeof body.channel.title === 'string');
  // Keep provider handle/legacy/HTTP URLs as observations, never as ID aliases.
  const aliases = [];
  for (const [field, raw] of [['channel.url', body.channel.url],
    ['uploader.url', body.uploader?.url], ['ownerByline.url', body.ownerByline?.url]]) {
    if (raw == null) continue;
    assert.equal(typeof raw, 'string');
    const normalized = normalizeDiscoveryChannel(raw);
    // The docs explicitly show an HTTP uploader URL. It is retained, not followed.
    const inspected = normalized ?? (raw.startsWith('http://')
      ? normalizeDiscoveryChannel('https://' + raw.slice(7)) : null);
    assert.ok(inspected, 'Unsafe provider channel URL');
    if (inspected.includes('/channel/'))
      assert.equal(inspected, 'https://www.youtube.com/channel/' + body.channel.id);
    aliases.push({field, raw, equivalenceEstablished: false, dispatchable: false});
  }
  assert.ok(Number.isInteger(body.credits_charged) && body.credits_charged >= 0
    && body.credits_charged <= 1, 'Unknown or increased provider price blocks mapping');
  const canonical = {videoId: body.id, uploader: {
    channelId: body.channel.id, displayName: body.channel.title}};
  const mapped = resolveSavedUploader(artist, clue, {...bound, operationKey: op.key,
    inputSha256: digest(op.request), status: 200, body: canonical, bodySha256: digest(canonical)});
  return {...mapped, executable: false, providerAliases: aliases,
    uploaderReceipt: {...mapped.uploaderReceipt, receiptKind: 'canonical_mapping_not_provider_receipt',
      rawBodySha256: receipt.rawBodySha256, rawPath,
      runId: context.runId, planSha256: context.planSha256},
    rawReceipt: {runId: context.runId, planSha256: context.planSha256,
      rawPath, capturedAt: receipt.capturedAt, status: receipt.status,
      rawBodySha256: receipt.rawBodySha256, rawBodyBase64: receipt.rawBody.toString('base64'),
      inputSha256: receipt.inputSha256, operationKey: op.key,
      profileId: bound.profileId, cmArtist: bound.cmArtist, videoId: body.id,
      kind: 'video_uploader', request: copy(receipt.request), creditsCharged: body.credits_charged},
    canonicalMapping: canonical, canonicalMappingSha256: digest(canonical)};
}

// A saved-case proposal freezes exact requests, including model bodies, before review.
// Requests not yet known require a later separately approved plan, not wildcard slots.
export function prepareOfflineVideoEvaluation(input) {
  const {runId, parentId, runtimeSha256, evidenceSha256} = input;
  reviewContext({runId, planSha256: runtimeSha256});
  assert.ok(typeof parentId === 'string' && parentId.length > 0);
  assert.match(evidenceSha256, sha);
  assert.ok(Array.isArray(input.artists) && input.artists.length > 0 && input.artists.length <= 20);
  const artists = input.artists.map(artistIdentity);
  assert.equal(new Set(artists.map(a => a.profileId)).size, artists.length);
  assert.equal(new Set(artists.map(a => a.cmArtist)).size, artists.length);
  const allocation = proposedVideoAllocation(artists.length);
  assert.ok(Array.isArray(input.operations) && input.operations.length > 0);
  const keys = new Set(), requests = new Set(), counts = new Map();
  const operations = input.operations.map(row => {
    assert.ok(artists.some(a => pair(a) === pair(row)), 'Operation outside exact cohort');
    assert.ok(kinds.includes(row.kind), 'Unplanned operation kind');
    assert.ok(typeof row.key === 'string' && row.key.length > 0 && !keys.has(row.key));
    keys.add(row.key);
    assert.ok(row.request && typeof row.request.url === 'string'
      && ['GET', 'POST'].includes(row.request.method));
    const request = copy(row.request), inputSha256 = digest(request);
    const uniqueRequest = JSON.stringify([row.profileId, row.cmArtist, row.kind, inputSha256]);
    assert.ok(!requests.has(uniqueRequest), 'Duplicate artist-bound request');
    requests.add(uniqueRequest);
    const countKey = JSON.stringify([row.profileId, row.cmArtist, row.kind]);
    counts.set(countKey, (counts.get(countKey) ?? 0) + 1);
    assert.ok(counts.get(countKey) <= allocation.perArtist[row.kind], 'Per-kind slots exhausted');
    const operation = {profileId: row.profileId, cmArtist: row.cmArtist,
      kind: row.kind, key: row.key, request, inputSha256, reservationCents: 2};
    if (row.kind === 'video_uploader') {
      const video = normalizeDiscoveryVideo(row.videoUrl);
      assert.ok(video && video.url === row.videoUrl && video.videoId === row.videoId);
      assert.deepEqual(request, proposedUploaderRequest(video.url));
      assert.equal(row.key, `video_uploader-${row.profileId}-${row.cmArtist}-${video.videoId}`);
      Object.assign(operation, {videoId: video.videoId, videoUrl: video.url});
    }
    return operation;
  });
  assert.ok(operations.length <= allocation.maxCalls);
  const plan = {version: 'offline-video-uploader-review-v1', runId, parentId,
    runtimeSha256, evidenceSha256, artists, operations, allocation,
    proposedCalls: operations.length, proposedReservationCents: operations.length * 2,
    executable: false, explicitApproval: false, inheritsApproval: false,
    approvalStatus: 'requires_fresh_exact_plan_spending_approval',
    fullCampaignRemainsPaused: true, noAutomaticRetries: true, noCatalogWrites: true};
  return {plan, planSha256: digest(plan)};
}

// Pure transition model of ONE locked transaction. It performs no writes or
// dispatch. A future coordinator must enforce this atomically, not use this
// in-memory snapshot as a distributed gate.
export function simulateOfflineVideoReservation(bundle, state, operationKey, expectedRevision) {
  const {plan, planSha256} = bundle;
  assert.equal(digest(plan), planSha256, 'Review plan changed');
  assert.deepEqual(prepareOfflineVideoEvaluation(plan), bundle, 'Invalid review plan');
  assert.equal(state.runId, plan.runId);
  assert.equal(state.parentId, plan.parentId);
  assert.equal(state.planSha256, planSha256);
  assert.equal(state.parentStatus, 'stopped', 'Parent must remain paused');
  assert.equal(state.owner, state.expectedOwner);
  assert.ok(typeof state.owner === 'string' && state.owner.length > 0);
  assert.equal(state.status, 'offline_review');
  assert.ok(Number.isSafeInteger(state.revision) && state.revision >= 0);
  assert.equal(state.revision, expectedRevision, 'Stale locked snapshot');
  assert.ok(Array.isArray(state.admissions));
  const seen = new Set();
  for (const previous of state.admissions) {
    const exact = plan.operations.find(op => op.key === previous.operation.key);
    assert.deepEqual(previous.operation, exact, 'Unbound historical request');
    assert.ok(!seen.has(exact.key), 'Duplicate reservation history'); seen.add(exact.key);
    assert.equal(previous.status, 'returned', 'Uncertain admission blocks all new work');
    assert.equal(previous.httpStatus, 200, 'Provider failure blocks all new work');
    assert.match(previous.rawReceiptSha256, sha);
  }
  assert.equal(state.reservedCents, state.admissions.length * 2);
  const operation = plan.operations.find(op => op.key === operationKey);
  assert.ok(operation, 'Request not frozen in plan');
  assert.ok(!seen.has(operationKey), 'Never replay an admission');
  const history = state.admissions.map(a => a.operation);
  const allocatedKind = plan.allocation.perArtist[operation.kind];
  assert.ok(history.filter(op => pair(op) === pair(operation) && op.kind === operation.kind).length
    < allocatedKind, 'Per-artist kind cap');
  assert.ok(history.filter(op => op.kind === operation.kind).length
    < allocatedKind * plan.artists.length, 'Run kind cap');
  assert.ok(history.length + 1 <= plan.allocation.maxCalls
    && state.reservedCents + 2 <= plan.allocation.capCents, 'Global spending cap');
  const nextState = copy(state);
  nextState.admissions.push({operation: copy(operation), status: 'admitted'});
  nextState.reservedCents += 2;
  nextState.revision++;
  return {admitted: false, executable: false, simulatedOnly: true, nextState,
    reason: 'No live coordinator or spending approval exists'};
}
