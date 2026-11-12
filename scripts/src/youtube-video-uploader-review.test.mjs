import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest, planVideoDiscovery, proposedUploaderRequest}
  from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader, prepareOfflineVideoEvaluation, simulateOfflineVideoReservation}
  from './youtube-video-uploader-review.mjs';

const artist = {profileId: '1', cmArtist: '2', name: 'Fixture Artist'};
const url = 'https://www.youtube.com/watch?v=Y2Ah_DFr8cw';
const id = 'UCWH3hing1Qb4LnkRfQdxsxQ', otherId = 'UCabcdefghijklmnopqrstuv';
const clone = value => JSON.parse(JSON.stringify(value));
const clue = planVideoDiscovery(artist, [{link: url, title: 'Fixture Artist video'}],
  {archivePath: 'receipts/search.json', receiptSha256: 'a'.repeat(64)}).resolutionQueue[0];
// Synthetic values in the documented provider shape, not a paid observation.
const provider = () => ({success: true, credits_charged: 1, id: clue.videoId, url,
  channel: {id, url: 'https://www.youtube.com/@fixture', handle: 'fixture', title: 'Fixture Artist'},
  ownerByline: {channelId: id, name: 'Fixture Artist', url: 'https://www.youtube.com/@fixture'},
  uploader: {channelId: id, author: 'Fixture Artist', url: 'http://www.youtube.com/@fixture'},
  watchNextVideos: [{channel: {id: otherId}}]});
function proposal(artists = [artist], operations) {
  return prepareOfflineVideoEvaluation({runId: 'youtube-video-review-fixture-only', parentId: 'paused-parent',
    runtimeSha256: 'a'.repeat(64), evidenceSha256: 'b'.repeat(64), artists,
    operations: operations ?? [{...clue.operation, ...artist, videoId: clue.videoId, videoUrl: url}]});
}
const context = () => ({runId: proposal().plan.runId, planSha256: proposal().planSha256});
function receipt(body = provider()) {
  const rawBody = Buffer.from('  ' + JSON.stringify(body) + '\n');
  return {...context(), ...artist, kind: 'video_uploader', operationKey: clue.operation.key,
    videoId: clue.videoId, request: proposedUploaderRequest(url),
    inputSha256: digest(clue.operation.request), status: 200,
    capturedAt: '2026-11-12T00:00:00Z', rawPath: 'receipts/video.raw.json',
    rawBody, rawBodySha256: digest(rawBody)};
}
const map = r => mapSavedVideoUploader(artist, clue, r, context());
function state(bundle = proposal()) {
  return {runId: bundle.plan.runId, parentId: bundle.plan.parentId, planSha256: bundle.planSha256,
    parentStatus: 'stopped', status: 'offline_review', owner: 'fixture-owner', expectedOwner: 'fixture-owner',
    revision: 0, reservedCents: 0, admissions: []};
}
test('documented provider fields map without confusing recommendations, aliases or ownership', () => {
  const r = receipt(), result = map(r);
  assert.equal(result.url, 'https://www.youtube.com/channel/' + id);
  assert.equal(result.uploaderName, artist.name);
  assert.equal(result.artistNameAgreement, 'name_only_not_ownership');
  assert.equal(result.verified, false); assert.equal(result.ownershipEvidence, false);
  assert.equal(result.executable, false); assert.equal(result.requiresIndependentOwnershipCheck, true);
  assert.equal(result.rawReceipt.rawBodySha256, digest(r.rawBody));
  assert.deepEqual(Buffer.from(result.rawReceipt.rawBodyBase64, 'base64'), r.rawBody);
  assert.notEqual(digest(JSON.stringify(provider())), result.rawReceipt.rawBodySha256);
  assert.equal(result.rawReceipt.creditsCharged, 1);
  assert.equal(result.canonicalMappingSha256, digest(result.canonicalMapping));
  assert.equal(result.providerAliases.length, 3);
  assert.ok(result.providerAliases.every(a => !a.equivalenceEstablished && !a.dispatchable));
});
test('exact artist, run, plan, video, request and raw receipt identities are mandatory', () => {
  for (const mutation of [{runId: 'historical-completed-test'}, {planSha256: '0'.repeat(64)},
    {profileId: '3'}, {cmArtist: '4'}, {videoId: 'abcdefghijk'}, {operationKey: 'wrong'},
    {kind: 'metadata'}, {status: 403}, {status: 404}, {status: 500},
    {inputSha256: '0'.repeat(64)}, {rawBodySha256: '0'.repeat(64)}, {rawBody: '{}'},
    {capturedAt: 'invalid'}, {rawPath: '../receipt.json'}, {rawPath: '/tmp/receipt.json'},
    {request: {...clue.operation.request, redirect: 'follow'}},
    {request: {...clue.operation.request, body: ''}}])
    assert.throws(() => map({...receipt(), ...mutation}), JSON.stringify(mutation));
  assert.throws(() => mapSavedVideoUploader({...artist, cmArtist: '9'}, clue, receipt(), context()));
  for (const rawBody of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(0),
    Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => map({...receipt(), rawBody, rawBodySha256: digest(rawBody)}));
  }
});
test('missing optional video URL still requires exact returned ID and frozen request', () => {
  const body=provider();delete body.url;
  assert.equal(map(receipt(body)).url,'https://www.youtube.com/channel/'+id);
  assert.throws(()=>map(receipt({...body,id:'abcdefghijk'})));
  assert.throws(()=>map(receipt({...body,url:null})));
  assert.throws(()=>map(receipt({...body,url:'https://www.youtube.com/watch?v=abcdefghijk'})));
  const r=receipt(body);
  assert.throws(()=>map({...r,request:proposedUploaderRequest('https://www.youtube.com/watch?v=abcdefghijk')}));
});
test('display names may come from the same ID-bound uploader or owner only', () => {
  const body=provider();delete body.channel.title;
  body.uploader.author='Fixture Artist - Topic';
  body.ownerByline.name='Fixture Artist - Topic';
  const result=map(receipt(body));
  assert.equal(result.uploaderName,'Fixture Artist - Topic');
  assert.equal(result.ownershipEvidence,false);
  delete body.uploader.author;
  assert.equal(map(receipt(body)).uploaderName,'Fixture Artist - Topic');
  delete body.ownerByline.name;
  assert.throws(()=>map(receipt(body)));
  body.uploader.author='Fixture Artist';
  body.uploader.channelId=otherId;
  assert.throws(()=>map(receipt(body)));
});
test('schema uncertainty, conflicts and increased billing fail closed rather than inventing an uploader', () => {
  for (const mutation of [{success: false}, {id: 'abcdefghijk'},
    {url: 'https://youtu.be/abcdefghijk'}, {channel: null},
    {channel: {title: artist.name}}, {uploader: {channelId: otherId}},
    {ownerByline: {channelId: otherId}}, {uploader: {}},
    {uploader: {channelId: id, url: 'https://evil.test/@fixture'}},
    {uploader: {channelId: id, url: 'https://www.youtube.com/channel/' + otherId}},
    {credits_charged: 2}, {credits_charged: undefined}, {credits_charged: -1}])
    assert.throws(() => map(receipt({...provider(), ...mutation})));
  // Optional cache hits never refund or release a two-cent reservation.
  assert.equal(map(receipt({...provider(), credits_charged: 0})).rawReceipt.creditsCharged, 0);
  const body = provider(); delete body.uploader; delete body.ownerByline;
  assert.equal(map(receipt(body)).url, 'https://www.youtube.com/channel/' + id);
});
test('fresh immutable saved-case proposal cannot inherit an approval or exceed per-kind replacement slots', () => {
  const bundle = proposal(), plan = bundle.plan;
  assert.deepEqual(prepareOfflineVideoEvaluation(plan), bundle);
  assert.equal(plan.explicitApproval, false); assert.equal(plan.executable, false);
  assert.equal(plan.inheritsApproval, false);
  assert.equal(plan.allocation.maxCalls, 5); assert.equal(plan.allocation.capCents, 10);
  assert.deepEqual(plan.allocation.perArtist, {search: 1, video_uploader: 2, metadata: 1, model: 1});
  assert.equal(plan.operations[0].inputSha256, digest(clue.operation.request));
  assert.throws(() => prepareOfflineVideoEvaluation({...plan, runId: 'youtube-test-20-usd5-2026-11-11'}));
  assert.throws(() => proposal([artist, artist]));
  assert.throws(() => proposal([artist], [{...plan.operations[0], cmArtist: '999'}]));
  assert.throws(() => proposal([artist], [{...plan.operations[0], kind: 'unplanned'}]));
  assert.throws(() => proposal([artist], [...plan.operations, ...plan.operations]));
  assert.throws(() => proposal([artist], [{...plan.operations[0], videoId: 'abcdefghijk'}]));
  assert.throws(() => proposal([artist], [{...plan.operations[0], key: 'wrong'}]));
  assert.throws(() => proposal([artist], [{...plan.operations[0], request: {
    ...clue.operation.request, url: clue.operation.request.url + '&cache_max_age=7d'}}]));
});
test('simulated locked reservation checks exact scope and uncertainty without admitting real work', () => {
  const bundle = proposal(), initial = state(bundle), key = clue.operation.key;
  const result = simulateOfflineVideoReservation(bundle, initial, key, 0);
  assert.equal(result.admitted, false); assert.equal(result.executable, false);
  assert.equal(initial.reservedCents, 0); assert.equal(initial.admissions.length, 0);
  assert.equal(result.nextState.reservedCents, 2); assert.equal(result.nextState.revision, 1);
  assert.throws(() => simulateOfflineVideoReservation(bundle, result.nextState, key, 0), /Stale/);
  assert.throws(() => simulateOfflineVideoReservation(bundle, result.nextState, key, 1), /Uncertain/);
  for (const mutation of [{owner: 'lost'}, {parentStatus: 'running'}, {status: 'running'},
    {parentId: 'different'}, {runId: 'different'}, {planSha256: '0'.repeat(64)}, {reservedCents: 2}])
    assert.throws(() => simulateOfflineVideoReservation(bundle, {...initial, ...mutation}, key, 0));
  assert.throws(() => simulateOfflineVideoReservation(bundle, initial, 'unplanned', 0));
  const changed = clone(bundle); changed.plan.explicitApproval = true;
  changed.planSha256 = digest(changed.plan);
  assert.throws(() => simulateOfflineVideoReservation(changed, {
    ...initial, planSha256: changed.planSha256}, key, 0));
});
test('all 100 slots reserve 200 cents with no replays, kind transfers or error refunds', () => {
  const artists = Array.from({length: 20}, (_, i) => ({
    profileId: String(i + 1), cmArtist: String(i + 101), name: `Fixture ${i}`}));
  const operations = artists.flatMap(a => [
    ...['Y2Ah_DFr8cw', 'abcdefghijk'].map(videoId => ({...a, kind: 'video_uploader',
      key: `video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`, videoId,
      videoUrl: 'https://www.youtube.com/watch?v=' + videoId,
      request: proposedUploaderRequest('https://www.youtube.com/watch?v=' + videoId)})),
    ...['search', 'metadata', 'model'].map(kind => ({...a, kind, key: `${kind}-${a.profileId}`,
      request: {method: kind === 'model' ? 'POST' : 'GET', url: `https://fixture.invalid/${kind}/${a.profileId}`}})),
  ]);
  const bundle = proposal(artists, operations);
  assert.equal(bundle.plan.proposedCalls, 100); assert.equal(bundle.plan.proposedReservationCents, 200);
  let current = state(bundle);
  for (const operation of bundle.plan.operations) {
    current = simulateOfflineVideoReservation(bundle, current, operation.key, current.revision).nextState;
    // Synthetic acknowledgment only; a real coordinator must bind immutable raw bytes.
    Object.assign(current.admissions.at(-1), {status: 'returned', httpStatus: 200,
      rawReceiptSha256: 'c'.repeat(64)});
  }
  assert.equal(current.reservedCents, 200);
  assert.throws(() => simulateOfflineVideoReservation(bundle, current, operations[0].key, 100), /replay/);
  assert.throws(() => proposal(artists, [...operations, {...operations[2], key: 'extra-search',
    request: {method: 'GET', url: 'https://fixture.invalid/extra'}}]), /slots/);
  const dirty = clone(current); dirty.admissions[0].httpStatus = 500;
  assert.throws(() => simulateOfflineVideoReservation(bundle, dirty, 'anything', 100), /failure/);
  const duplicate = clone(current); duplicate.admissions.push(duplicate.admissions[0]);
  duplicate.reservedCents += 2;
  assert.throws(() => simulateOfflineVideoReservation(bundle, duplicate, 'anything', 100), /Duplicate/);
  const unbound = clone(current); unbound.admissions[0].operation.cmArtist = '999';
  assert.throws(() => simulateOfflineVideoReservation(bundle, unbound, 'anything', 100), /Unbound/);
});
