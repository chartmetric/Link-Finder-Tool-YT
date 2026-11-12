import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {digest, normalizeDiscoveryChannel as channel, normalizeDiscoveryVideo as video,
  planVideoDiscovery as plan, resolveSavedUploader, deduplicateArtistChannelClues as dedup,
  proposedVideoAllocation as allocation, assertProposedAllocationSlot as slot}
  from './youtube-video-discovery-offline.mjs';
import {assertBoundedYoutubeAdmission} from './youtube-bounded-test-gate.mjs';
import {validateRequest, campaignTransport} from './youtube-campaign-core.mjs';

const id = 'UCabcdefghijklmnopqrstuv', id2 = 'UCzyxwvutsrqponmlkjihgfed';
const artist = {profileId: '1', cmArtist: '2', name: 'Bee Blackwell'};
const other = {profileId: '3', cmArtist: '4', name: 'Another Artist'};
const provenance = {archivePath: 'receipts/search.json', receiptSha256: 'a'.repeat(64),
  originalRequestSha256: 'b'.repeat(64), capturedAt: '2026-11-11T00:00:00Z'};
const hit = (link, title = 'Bee Blackwell official music video', snippet = '') => ({link, title, snippet});
const watch = 'https://www.youtube.com/watch?v=abcdefghijk';
const clue = () => plan(artist, [hit(watch)], provenance).resolutionQueue[0];
function saved(clue, uploader = {channelId: id, displayName: artist.name}) {
  const body = {videoId: clue.videoId, uploader};
  return {profileId: clue.profileId, cmArtist: clue.cmArtist, operationKey: clue.operation.key,
    inputSha256: digest(clue.operation.request), status: 200, body, bodySha256: digest(body)};
}
test('network is disabled across fetch, HTTP, sockets and DNS', () => {
  for (const fn of [() => fetch(watch), () => http.get(watch), () => net.connect(443, 'youtube.com'),
    () => dns.lookup('youtube.com')]) assert.throws(fn, /Network forbidden/);
});
test('watch, shorts, live and short-link aliases normalize to the same video, not a channel', () => {
  for (const url of [watch, watch + '&t=42&vl=en', 'https://youtu.be/abcdefghijk?si=test',
    'https://m.youtube.com/shorts/abcdefghijk', 'https://music.youtube.com/live/abcdefghijk/']) {
    assert.deepEqual(video(url), {videoId: 'abcdefghijk', url: watch});
    assert.equal(channel(url), null);
  }
});
test('exact-host channel tabs normalize with ID/handle/legacy channel provenance intact', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])
    for (const suffix of ['', '/', '/about', '/videos/', '/shorts', '/streams', '/playlists',
      '/featured', '/community', '/releases'])
      for (const stem of ['@beeblackwellmusic', 'channel/' + id, 'c/Bee', 'user/Bee'])
        assert.equal(channel(`https://${host}/${stem}${suffix}?view=0`), 'https://www.youtube.com/' + stem);
  const p = plan(artist, [hit('https://youtube.com/channel/' + id + '/about'),
    hit('https://www.youtube.com/channel/' + id + '/videos')], provenance);
  assert.equal(p.channelClues.length, 1); assert.equal(p.channelClues[0].sources.length, 2);
  assert.equal(p.channelClues[0].sources[0].sourceUrl, 'https://youtube.com/channel/' + id + '/about');
  assert.equal(p.channelClues[0].sources[0].resultSha256,
    digest(hit('https://youtube.com/channel/' + id + '/about')));
  assert.equal(p.channelClues[0].ownershipEvidence, false);
});
test('unsafe and ambiguous URLs never become provider targets', () => {
  for (const url of ['http://youtube.com/@bee', 'https://youtube.com.evil.test/@bee',
    'https://evilyoutube.com/@bee', 'https://youtube.com@evil.test/@bee',
    'https://user:pass@youtube.com/@bee', 'https://youtube.com:8443/@bee',
    'https://youtube.com/redirect?q=https://youtube.com/@bee',
    'https://youtube.com/@bee/unknown', 'https://youtube.com/@bee/videos/extra',
    'https://youtube.com/a/../@bee', 'https://youtube.com/%40bee/about',
    'https://youtube.com/@bee%2fother', 'https://youtube.com\\@evil.test/@bee',
    'https://youtube.com/watch?v=abcdefghijk&v=12345678901', 'https://youtu.be/short',
    'https://youtu.be/abcdefghijk/extra', 'https://127.0.0.1/@bee',
    'javascript:alert(1)', '//youtube.com/@bee', 'https://youtube.com/@bee\n']) {
    assert.equal(channel(url), null, url); assert.equal(video(url), null, url);
  }
});
test('relevant videos are bounded, aliases deduped, and snippet mentions never become channels', () => {
  const p = plan(artist, [hit(watch, undefined, '@beeblackwellmusic103 Go to channel Other'),
    hit('https://youtu.be/abcdefghijk', undefined, '@notTheUploader'),
    hit('https://youtube.com/watch?v=12345678901'),
    hit('https://youtube.com/watch?v=98765432109'),
    hit('https://youtube.com/watch?v=xxxxxxxxxxx', 'Unrelated music', 'No bound artist name')],
  provenance);
  assert.equal(p.videoClues.length, 4); assert.equal(p.resolutionQueue.length, 2);
  assert.equal(p.resolutionQueue[0].sources.length, 2); assert.equal(p.deferredVideos.length, 1);
  assert.equal(p.snippetHandles.length, 2); assert.equal(p.channelClues.length, 0);
  assert.equal(p.videoClues.at(-1).eligible, false);
  assert.equal(p.resolutionQueue[0].sources[0].receiptSha256, provenance.receiptSha256);
  assert.equal(p.verifiedMatches, 0); assert.equal(p.executable, false);
});
test('Topic and organizational/third-party video results stay flagged clues, not ownership', () => {
  const p = plan(artist, [hit(watch, 'Bee Blackwell - Topic', 'Provided to YouTube by Distributor'),
    hit('https://youtube.com/watch?v=12345678901', 'Bee Blackwell official video'),
    hit('https://youtube.com/watch?v=98765432109', 'Bee Blackwell Nightcore Lyrics')], provenance);
  assert.equal(p.resolutionQueue[0].videoId, '12345678901');
  assert.equal(p.videoClues[0].sources[0].roleHint, 'topic_or_distribution');
  assert.equal(p.videoClues[2].sources[0].roleHint, 'organization_or_third_party_possible');
  assert.equal(p.deferredVideos.length, 1);
  for (const displayName of ['Bee Blackwell - Topic', 'Other Records', 'Cover Fans', 'Another Artist', artist.name]) {
    const c = clue(), r = resolveSavedUploader(artist, c, saved(c, {channelId: id, displayName}));
    assert.equal(r.verified, false); assert.equal(r.ownershipEvidence, false);
    assert.equal(r.requiresIndependentOwnershipCheck, true);
    assert.equal(r.artistNameAgreement, displayName === artist.name
      ? 'name_only_not_ownership' : 'different_or_unknown_uploader');
  }
});
test('saved uploader contract fails closed on wrong video, artist, request, receipt or channel', () => {
  const c = JSON.parse(JSON.stringify(clue())), s = JSON.parse(JSON.stringify(saved(c)));
  assert.equal(resolveSavedUploader(artist, c, s).url, 'https://www.youtube.com/channel/' + id);
  const mutations = [{profileId: '3'}, {cmArtist: '4'}, {operationKey: 'wrong'},
    {inputSha256: '0'.repeat(64)}, {bodySha256: '0'.repeat(64)}, {status: 404}];
  for (const mutation of mutations) assert.throws(() => resolveSavedUploader(artist, c, {...s, ...mutation}));
  for (const body of [{...s.body, videoId: '98765432109'},
    {...s.body, uploader: {displayName: artist.name}},
    {...s.body, uploader: {channelId: id, channelUrl: 'https://youtube.com/channel/' + id2}},
    {...s.body, uploader: {channelId: id, channelUrl: 'https://evil.test/channel/' + id}}])
    assert.throws(() => resolveSavedUploader(artist, c, {...s, body, bodySha256: digest(body)}));
  assert.throws(() => resolveSavedUploader(other, c, s));
  assert.throws(() => resolveSavedUploader(artist, {...c, videoId: '98765432109'},
    saved({...c, videoId: '98765432109'})));
  assert.throws(() => resolveSavedUploader(artist, {...c, operation: {...c.operation, key: 'wrong'}},
    {...s, operationKey: 'wrong'}));
  assert.throws(() => resolveSavedUploader(artist, {...c, operation: {...c.operation, kind: 'metadata'}}, s));
  assert.throws(() => plan({...artist, cmArtist: undefined}, [], provenance));
  assert.throws(() => plan(artist, null, provenance));
});
test('same video and channel across artists retain distinct artist-bound observations', () => {
  const a = clue(), b = plan(other, [hit(watch, other.name + ' official music')], provenance).resolutionQueue[0];
  assert.notEqual(a.operation.key, b.operation.key);
  const ra = resolveSavedUploader(artist, a, saved(a));
  const rb = resolveSavedUploader(other, b, saved(b));
  const merged = dedup([ra, {...ra, uploaderReceipt: {...ra.uploaderReceipt, receiptSha256: 'c'.repeat(64)}}, rb]);
  assert.equal(merged.length, 2); assert.equal(merged[0].observations.length, 2);
  assert.equal(merged[1].observations.length, 1);
  assert.equal(merged[0].verified, false);
});
test('allocation replaces slots inside 100 calls/$2; never authorizes or recycles them', () => {
  const p = allocation(), op = {profileId: '1', kind: 'video_uploader', key: 'v1'};
  assert.equal(p.maxCalls, 100); assert.equal(p.capCents, 200);
  assert.equal(p.perArtist.metadata, 1); assert.equal(p.perArtist.model, 1);
  assert.equal(slot(p, op, []).admitted, false);
  for (const bad of [{...p, explicitApproval: true}, {...p, executable: true},
    {...p, capCents: 202}, {...p, maxCalls: 101}]) assert.throws(() => slot(bad, op, []));
  assert.throws(() => allocation(21));
  assert.throws(() => slot(p, {...op, kind: 'anything'}, []));
  assert.throws(() => slot(p, op, [{...op, key: 'pending', status: 'admitted'}]), /Uncertain/);
  const returned = {...op, status: 'returned'};
  assert.throws(() => slot(p, op, [returned]), /replay/);
  assert.throws(() => slot(p, {...op, key: 'v3'}, [returned, {...returned, key: 'v2'}]), /slots/);
  // 20 complete allocations leave no call or spending room, even for a new artist.
  const full = Array.from({length: 20}, (_, i) => Object.entries(p.perArtist).flatMap(([kind, count]) =>
    Array.from({length: count}, (_, j) => ({profileId: String(i + 1), kind, key: `${kind}-${i}-${j}`, status: 'returned'})))).flat();
  assert.equal(full.length, 100);
  assert.throws(() => slot(p, {profileId: '21', kind: 'video_uploader', key: 'extra'}, full));
  assert.throws(() => slot(p, {...op, key: 'extra'}, full));
});
test('current transport and transactional admission reject new operation before dispatch', async () => {
  const c = clue(), p = allocation();
  const scope = {scopeSha256: 'scope', operationalCapCents: 200, userCapCents: 200,
    artists: [{profile_id: '1'}]};
  const run = {owner: 'owner', status: 'running', scope_sha256: 'scope', cap_cents: 200, reserved_cents: 0};
  const op = {profileId: '1', kind: 'video_uploader', key: c.operation.key, inputSha256: digest(c.operation.request)};
  assert.throws(() => assertBoundedYoutubeAdmission(run, scope, op, 0, 'owner'));
  assert.throws(() => validateRequest(op.kind, c.operation.request));
  assert.equal(p.inheritsApproval, false);
  let admissions = 0, requests = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-transport-fence-'));
  try {
    const transport = campaignTransport({root: dir, assertFrozen: async () => {},
      admit: async () => { admissions++; }, returned: async () => {}, credentials: {},
      fetchImpl: async () => { requests++; throw Error('Unexpected dispatch'); }});
    await assert.rejects(() => transport(op.profileId, op.kind, op.key, c.operation.request));
    assert.equal(admissions, 0); assert.equal(requests, 0);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
