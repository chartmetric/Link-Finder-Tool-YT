import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPilotBudget } from './instagram-pilot-budget.mjs';
import { pilotPreflight, runFixturePilot } from './instagram-pilot-runner.mjs';

const spotify = 'https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';
const ig = 'https://www.instagram.com/example.artist/';
function manifest(count = 1) {
  return { run_allowed: false, artists: Array.from({ length: count }, (_, i) => ({
    profile_id: String(i + 1), cm_artist: String(i + 100), artist: 'Example Artist',
    catalog_profile: { profile_id: String(i + 1), cm_artist: String(i + 100), cm_source: 'cm_artist' },
    source_identity_matches: true, reference_preflight: { readiness: 'reference_usable' },
    account_ids: ['7'], accounts: [{ account_id: '7', platform: 'spotify', account_url: spotify }],
  })), proposed_limits: {
    artist_workers: 5, global_concurrent_provider_requests: 5, eligible_artists_before_prerequisite_fixes: count,
    serper_requests_per_artist: 2, instagram_candidate_metadata_per_artist: 3, reference_metadata_per_artist: 1,
    jev_requests_per_artist: 1, serper_requests_total: 100, scrapecreators_requests_total: 103,
    jev_requests_total: 34, paid_http_requests_total: 205, public_spotify_oembed_requests_total: 33,
    public_official_or_linkhub_page_requests_total: 34, per_request_timeout_seconds: 20,
    per_artist_wall_time_seconds: 120, job_wall_time_minutes: 30,
    jev_max_input_tokens_per_request: 6000, jev_max_output_tokens_per_request: 1000,
  } };
}
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-pilot-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'admissions.jsonl');
}
const fixture = dispatch => ({ fixture: true, dispatch });

test('dry-run validates references without network, and repaired references do not widen approved scope', () => {
  const m = manifest(3);
  m.artists[1].accounts = [];
  m.artists[2].reference_preflight.readiness = 'reference_format_unsupported';
  m.artists[2].accounts[0] = { account_id: '7', platform: 'youtube', account_url: 'https://music.youtube.com/channel/UCvU9MbC4e-3A8myju8Q_o-g' };
  const result = pilotPreflight(m);
  assert.equal(result.networkCalls, 0);
  assert.deepEqual(result.artists.map(a => a.eligible), [true, false, false]);
  assert.equal(result.artists[2].reason, 'reference_repaired_but_scope_reapproval_required');
  m.artists[0].catalog_profile.cm_artist = 'other';
  assert.equal(pilotPreflight(m).artists[0].reason, 'catalog_identity_conflict');
});

test('no live transport or replay of an existing journal is permitted', async t => {
  const journalPath = await temp(t);
  await assert.rejects(createPilotBudget({ manifest: manifest(), journalPath, mode: 'live',
    transport: fixture(() => { throw new Error('must not dispatch'); }) }), /Live execution is disabled/);
  const budget = await createPilotBudget({ manifest: manifest(), journalPath, mode: 'fixture', transport: fixture(async () => ({})) });
  await budget.close();
  await assert.rejects(createPilotBudget({ manifest: manifest(), journalPath, mode: 'fixture', transport: fixture(async () => ({})) }), /EEXIST/);
});

test('every dispatch follows durable admission; duplicate keys and per-artist caps refuse extra calls', async t => {
  const journalPath = await temp(t);
  let calls = 0;
  const budget = await createPilotBudget({ manifest: manifest(), journalPath, mode: 'fixture',
    transport: fixture(async request => {
      const rows = (await fs.readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(rows.some(row => row.phase === 'admitted' && row.key === request.key));
      calls++;
      return {};
    }) });
  await budget.request({ profileId: '1', kind: 'serper', key: 'first' });
  await assert.rejects(budget.request({ profileId: '1', kind: 'serper', key: 'first' }), /replay/);
  await budget.request({ profileId: '1', kind: 'serper', key: 'second' });
  await assert.rejects(budget.request({ profileId: '1', kind: 'serper', key: 'third' }), /cap/);
  await assert.rejects(budget.request({ profileId: '999', kind: 'serper', key: 'foreign' }), /scope/);
  assert.equal(calls, 2);
  await budget.close();
});

test('global concurrency and shared ScrapeCreators cap hold under concurrent admissions', async t => {
  const m = manifest(12);
  m.proposed_limits.scrapecreators_requests_total = 7;
  let active = 0, peak = 0, calls = 0;
  const budget = await createPilotBudget({ manifest: m, journalPath: await temp(t), mode: 'fixture',
    transport: fixture(async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 3));
      active--; return {};
    }) });
  await Promise.allSettled(m.artists.map((a, i) => budget.request({ profileId: a.profile_id,
    kind: i % 2 ? 'scrapecreators_reference' : 'scrapecreators_candidate', key: `req-${i}` })));
  assert.equal(calls, 7);
  assert.ok(peak <= 5);
  assert.equal(budget.snapshot().paid, 7);
  await budget.close();
});

test('fatal credit errors halt subsequent work; timed-out admissions are not retried', async t => {
  const m = manifest();
  let calls = 0;
  const budget = await createPilotBudget({ manifest: m, journalPath: await temp(t), mode: 'fixture',
    transport: fixture(async () => { calls++; throw Object.assign(new Error('credit failure'), { fatalProvider: true }); }) });
  await assert.rejects(budget.request({ profileId: '1', kind: 'serper', key: 'fatal' }));
  await assert.rejects(budget.request({ profileId: '1', kind: 'serper', key: 'later' }), /stopped/);
  assert.equal(calls, 1);
  await budget.close();
  const timed = await createPilotBudget({ manifest: m, journalPath: await temp(t), mode: 'fixture',
    transport: fixture(() => new Promise(() => {})) });
  await assert.rejects(timed.request({ profileId: '1', kind: 'serper', key: 'uncertain', deadlineAt: Date.now() + 20 }), /timed-out/);
  await assert.rejects(timed.request({ profileId: '1', kind: 'serper', key: 'no-retry' }), /stopped/);
  assert.equal(timed.snapshot().paid, 1);
  await timed.close();
});

test('unbudgeted kinds, expired deadlines and oversized JEV evidence never dispatch', async t => {
  let calls = 0;
  const budget = await createPilotBudget({ manifest: manifest(), journalPath: await temp(t), mode: 'fixture',
    transport: fixture(async () => { calls++; return {}; }) });
  await assert.rejects(budget.request({ profileId: '1', kind: 'other', key: 'bad' }), /Unbudgeted/);
  await assert.rejects(budget.request({ profileId: '1', kind: 'constructor', key: 'prototype' }), /Unbudgeted/);
  await assert.rejects(budget.request({ profileId: '1', kind: 'jev', key: 'large', payload: { text: 'x'.repeat(6001) } }), /reservation/);
  await assert.rejects(budget.request({ profileId: '1', kind: 'serper', key: 'late', deadlineAt: 1 }), /before dispatch/);
  assert.equal(calls, 0);
  await budget.close();
});

test('fixture pipeline supports exact external links and records non-approval without history or claims', async t => {
  const m = manifest(2);
  m.artists[1].accounts = [];
  const calls = [];
  const output = await runFixturePilot({ manifest: m, journalPath: await temp(t), transport: fixture(async request => {
    calls.push(request.kind);
    if (request.kind === 'spotify_oembed') return { platform: 'spotify', handle: 'id', url: spotify };
    if (request.kind === 'serper') return { methodsUsed: [{ method: 'serper', status: 'used' }],
      profiles: [{ url: ig, title: 'Example Artist' }] };
    if (request.kind === 'scrapecreators_candidate') return { platform: 'instagram', url: ig, bio: 'Music', externalUrls: [spotify] };
    if (request.kind === 'jev') return [{ url: ig, jevVerification: { verdict: 'verified', sameIdentityProbability: 0.99 } }];
    throw new Error('unexpected request');
  }) });
  const supported = output.results.find(r => r.profileId === '1');
  assert.deepEqual(supported.urls, [ig]);
  assert.equal(supported.approvedCatalogLinks, false);
  assert.equal(output.results.find(r => r.profileId === '2').status, 'needs_review');
  assert.deepEqual(calls, ['spotify_oembed', 'serper', 'scrapecreators_candidate', 'jev']);
  assert.equal(output.claimsSubmitted, 0);
  assert.equal(output.databaseWrites, 0);
});

test('missing discovery or restricted metadata stays unresolved, not account unavailable', async t => {
  for (const restricted of [false, true]) {
    const output = await runFixturePilot({ manifest: manifest(), journalPath: await temp(t), transport: fixture(async request => {
      if (request.kind === 'spotify_oembed') return { url: spotify };
      if (request.kind === 'serper') return { methodsUsed: [{ method: 'serper', status: 'used' }],
        ...(restricted ? { profiles: [{ url: ig }] } : {}) };
      throw Object.assign(new Error('Restricted metadata'), { resourceRestricted: true });
    }) });
    assert.equal(output.results[0].status, 'needs_review');
    assert.equal(output.results[0].noAccountConfirmed, undefined);
    assert.equal(output.results[0].partialEvidence.discoveryAttempts.length, 1, 'retain discovery when metadata fails');
    assert.equal(output.results[0].partialEvidence.reference.url, spotify);
  }
});

test('total paid cap cannot be bypassed by switching provider kinds', async t => {
  const m = manifest();
  m.proposed_limits.paid_http_requests_total = 1;
  let calls = 0;
  const budget = await createPilotBudget({ manifest: m, journalPath: await temp(t), mode: 'fixture',
    transport: fixture(async () => { calls++; return {}; }) });
  await budget.request({ profileId: '1', kind: 'serper', key: 'search' });
  await assert.rejects(budget.request({ profileId: '1', kind: 'scrapecreators_candidate', key: 'metadata' }), /cap/);
  assert.equal(calls, 1);
  await budget.close();
});

test('completed empty discovery uses at most two planned queries, not unlimited retries', async t => {
  const calls = [];
  const output = await runFixturePilot({ manifest: manifest(), journalPath: await temp(t),
    transport: fixture(async request => {
      calls.push(request.kind);
      if (request.kind === 'spotify_oembed') return { url: spotify };
      return { methodsUsed: [{ method: 'serper', status: 'used' }], profiles: [] };
    }) });
  assert.deepEqual(calls, ['spotify_oembed', 'serper', 'serper']);
  assert.equal(output.results[0].status, 'no_candidates');
  assert.equal(output.results[0].noAccountConfirmed, false);
});

test('regressions finish and require evaluation before any other profile is dispatched', async t => {
  const m = manifest(2);
  m.artists[1].bucket = 'regression'; // Deliberately last in the original input.
  const called = [];
  let evaluated = false;
  const output = await runFixturePilot({ manifest: m, journalPath: await temp(t),
    evaluateRegressions: rows => {
      evaluated = true;
      assert.deepEqual(rows.map(r => r.profileId), ['2']);
      return false;
    },
    transport: fixture(async request => {
      called.push(request.profileId);
      assert.equal(evaluated, false);
      if (request.kind === 'spotify_oembed') return { url: spotify };
      return { methodsUsed: [{ method: 'serper', status: 'used' }], profiles: [] };
    }) });
  assert.ok(called.length > 0);
  assert.ok(called.every(id => id === '2'));
  assert.equal(output.regressionStagePassed, false);
  assert.match(output.results.find(r => r.profileId === '1').reason, /no requests dispatched/);
});

test('candidate inspection is capped and uninspected hits are explicit, not absence', async t => {
  let metadataCalls = 0;
  const output = await runFixturePilot({ manifest: manifest(), journalPath: await temp(t),
    transport: fixture(async request => {
      if (request.kind === 'spotify_oembed') return { url: spotify };
      if (request.kind === 'serper') return { methodsUsed: [{ method: 'serper', status: 'used' }],
        profiles: Array.from({ length: 5 }, (_, i) => ({ url: `https://www.instagram.com/example${i}/`, title: 'Other person' })) };
      if (request.kind === 'scrapecreators_candidate') { metadataCalls++; return { url: request.payload.url }; }
      return [];
    }) });
  assert.equal(metadataCalls, 3);
  assert.equal(output.results[0].uninspectedCandidates, 2);
  assert.equal(output.results[0].status, 'needs_review');
  assert.equal(output.results[0].rawResult.profiles.length, 3);
  assert.equal(output.results[0].discoveryAttempts[0].profiles.length, 5, 'preserve uninspected discovery evidence');
});
