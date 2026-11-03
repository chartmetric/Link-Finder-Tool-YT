import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlayers, candidateUrls, processQueue, initialState, researchTiers, selectionForTiers, researchWorkers, admittedProfileIds, rerunNoCandidateProfiles } from './musician-instagram-research.mjs';
import { readFileSync } from 'node:fs';

const player = { profile_id: '9007199254740993', cm_artist: '123', account_ids: ['456'], artist: 'Example Artist' };
const success = { methodsUsed: [{ method: 'serper', status: 'used' }], profiles: [{ url: 'https://www.instagram.com/example.artist/' }] };
test('only explicit pre-dispatch cancellations clear an admission, and readmission remains protected', () => {
  assert.deepEqual([...admittedProfileIds([{ profileId: '1' }, { profileId: '2' },
    { profileId: '1', phase: 'cancelled_before_dispatch' }])], ['2']);
  assert.deepEqual([...admittedProfileIds([{ profileId: '1' }, { profileId: '1', phase: 'cancelled_before_dispatch' },
    { profileId: '1' }])], ['1']);
});
test('a stop during admission saves queued state without dispatching a paid search', async () => {
  let stopped = false, requests = 0;
  const states = [];
  await processQueue({ players: [player], workers: 1, shouldStop: () => stopped,
    save: async (p, status) => { states.push(status); if (status === 'running') stopped = true; },
    search: async () => { requests++; return success; } });
  assert.equal(requests, 0);
  assert.deepEqual(states, ['running', 'queued']);
});
test('worker overrides accept five and reject invalid or excessive parallelism', () => {
  assert.equal(researchWorkers(['--workers=5']), 5);
  for (const value of ['0', '21', '2.5', 'invalid']) assert.throws(() => researchWorkers([`--workers=${value}`]), /parallel workers/);
});
test('five requested workers run five searches concurrently without repeating a profile', async () => {
  let active = 0, peak = 0;
  const seen = new Set();
  await processQueue({ workers: 5, players: Array.from({ length: 13 }, (_, i) => ({ ...player, profile_id: String(i + 1) })),
    save: async () => {},
    search: async p => {
      assert.ok(!seen.has(p.profile_id));
      seen.add(p.profile_id);
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return success;
    },
  });
  assert.equal(peak, 5);
  assert.equal(seen.size, 13);
});
test('Tier 1 and 2 cohorts have separate canonical scope and do not silently include Tier 3', () => {
  assert.deepEqual(researchTiers(), [3]);
  assert.deepEqual(researchTiers(['--tiers=2,1,2']), [1, 2]);
  for (const input of ['--tiers=', '--tiers=4', '--tiers=all', '--tiers=1;DROP']) {
    assert.throws(() => researchTiers([input]), /Choose tiers/);
  }
  const query = readFileSync(new URL('./musician-instagram-cohort.sql', import.meta.url), 'utf8');
  const selected = selectionForTiers(query, [1, 2]);
  assert.match(selected, /AND tier IN \(1,2\)/);
  assert.doesNotMatch(selected, /AND tier = 3/);
  assert.doesNotMatch(selected, /\bLIMIT\b/i);
  assert.match(selected, /computed_at >= toStartOfDay\(now\(\)\)/);
  assert.match(selected, /a.platform = 'instagram'/);
  assert.equal(selectionForTiers(query, [3]), query);
});
test('profile, cm_artist and account lookup identities retain full UInt64 precision', () => {
  validatePlayers([player]);
  assert.throws(() => validatePlayers([{ ...player, cm_artist: 'invalid' }]), /identity/);
  assert.throws(() => validatePlayers([{ ...player, account_ids: ['18446744073709551616'] }]), /identity/);
  assert.throws(() => validatePlayers([player, player]), /duplicate/);
  assert.throws(() => validatePlayers([]), /No artists/);
});
test('the Tier 3 cohort has no 100-profile limit and retains freshness and no-Instagram filters', () => {
  const query = readFileSync(new URL('./musician-instagram-cohort.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(query, /\bLIMIT\b/i);
  assert.match(query, /tier = 3/);
  assert.match(query, /computed_at >= toStartOfDay\(now\(\)\)/);
  assert.match(query, /a.platform = 'instagram'/);
  validatePlayers(Array.from({ length: 10001 }, (_, index) => ({ ...player, profile_id: String(index + 1) })));
});
test('successful prior Serper searches are reused without another charge, including no-candidate results', () => {
  for (const status of ['candidates_found', 'no_candidates']) {
    const state = initialState(player, { latest: [status, [], JSON.stringify({ ...success, estimatedCostUsd: 0.001 }), '', 'original-run', 'date', player.cm_artist] });
    assert.equal(state.status, status);
    assert.equal(state.result.reusedFromRunId, 'original-run');
    assert.equal(state.result.estimatedCostUsd, 0);
  }
  assert.equal(initialState(player).status, 'queued');
});
test('old unfinished, failed, different-identity or missing-Serper work is held for review, not replayed', () => {
  for (const status of ['queued', 'running', 'failed', 'needs_review']) {
    assert.equal(initialState(player, { latest: [status, [], '{}', '', 'old', 'date', player.cm_artist] }).status, 'needs_review');
  }
  assert.equal(initialState(player, { latest: ['candidates_found', [], JSON.stringify(success), '', 'old', 'date', 'different'] }).status, 'needs_review');
  assert.equal(initialState(player, { latest: ['candidates_found', [], '{}', '', 'old', 'date', player.cm_artist] }).status, 'needs_review');
});
test('focused reruns select only matching completed Serper no-candidate profiles', () => {
  const players = [
    player,
    { ...player, profile_id: '2' },
    { ...player, profile_id: '3' },
    { ...player, profile_id: '4' },
    { ...player, profile_id: '5' },
    { ...player, profile_id: '6' },
  ];
  const prior = (status, urls = [], cmArtist = player.cm_artist, result = success) =>
    ({ latest: [status, urls, JSON.stringify(result), '', 'old-run', 'date', cmArtist] });
  const previous = new Map([
    ['9007199254740993', prior('no_candidates')],
    ['2', prior('candidates_found')],
    ['3', prior('no_candidates', ['https://www.instagram.com/existing/'])],
    ['4', prior('no_candidates', [], 'different-artist')],
    ['5', prior('no_candidates', [], player.cm_artist, { methodsUsed: [{ method: 'gemini', status: 'used' }] })],
  ]);

  assert.deepEqual(rerunNoCandidateProfiles(players, previous).map(item => item.profile_id), ['9007199254740993']);
});
test('only completed Serper searches and actual Instagram profile URLs can be saved as candidates', () => {
  assert.deepEqual(candidateUrls(success), ['https://www.instagram.com/example.artist/']);
  assert.deepEqual(candidateUrls({ ...success, profiles: [] }), []);
  for (const status of ['failed', 'unavailable']) assert.throws(() =>
    candidateUrls({ ...success, methodsUsed: [{ method: 'serper', status }] }), /Serper/);
  assert.throws(() => candidateUrls({ ...success, methodsUsed: [{ method: 'gemini', status: 'used' }] }), /Serper/);
  for (const url of ['https://evil.example/example', 'https://www.instagram.com/p/123', 'https://instagram.com/accounts',
    'https://instagram.com/example/reels', 'http://instagram.com/example']) {
    assert.deepEqual(candidateUrls({ ...success, profiles: [{ url }] }), []);
  }
});
test('irrelevant or malformed URLs cannot stop the full queue or appear in lookup URLs', async () => {
  const states = [];
  await processQueue({ players: [player, { ...player, profile_id: '18' }],
    save: async (p, status, result, urls) => states.push({ status, urls }),
    search: async () => ({ ...success, profiles: [{ url: 'https://instagram.com/explore/tags/music' }, { url: 'not a URL' }, ...success.profiles] }),
  });
  assert.equal(states.filter(row => row.status === 'candidates_found').length, 2);
  assert.ok(states.filter(row => row.status === 'candidates_found').every(row => row.urls.length === 1));
});
test('paid work follows durable admission and saves per-artist results', async () => {
  const operations = [];
  const outcome = await processQueue({ players: [player],
    save: async (p, status, result, urls) => operations.push({ id: p.profile_id, status, urls }),
    search: async () => { assert.equal(operations[0].status, 'running'); return success; },
  });
  assert.equal(outcome.finished, 1);
  assert.deepEqual(operations.map(o => o.status), ['running', 'candidates_found']);
  assert.deepEqual(operations[1].urls, candidateUrls(success));
});
test('a missing required provider closes all lanes and leaves later profiles untouched', async () => {
  let dispatched = 0;
  const saved = [];
  const outcome = await processQueue({
    players: Array.from({ length: 100 }, (_, i) => ({ ...player, profile_id: String(i + 1) })),
    save: async (p, status) => saved.push([p.profile_id, status]),
    search: async () => { dispatched++; return { methodsUsed: [{ method: 'serper', status: 'failed' }] }; },
  });
  assert.ok(outcome.stopped);
  assert.ok(dispatched <= 4);
  assert.ok(saved.some(row => row[1] === 'failed'));
  assert.ok(saved.every(row => Number(row[0]) <= 4));
});
test('failed admission prevents any paid request and a failed result save never retries work', async () => {
  let dispatched = 0;
  await assert.rejects(processQueue({ players: [player],
    save: async () => { throw new Error('storage down'); },
    search: async () => { dispatched++; return success; } }), /storage down/);
  assert.equal(dispatched, 0);
  await assert.rejects(processQueue({ players: [player],
    save: async (p, status) => { if (status !== 'running') throw new Error('result storage down'); },
    search: async () => { dispatched++; return success; } }), /result storage down/);
  assert.equal(dispatched, 1);
});
