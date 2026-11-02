import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BulkBrandRun, ProfileMatch } from '@workspace/api-client-react';
import { BULK_CSV_HEADERS, bulkRunToCsv, downloadBulkRunCsv, escapeCsvCell } from '../../musician-social-finder/src/lib/bulk-csv.ts';
import { getNetConfidence } from '../../musician-social-finder/src/lib/net-confidence.ts';

const checkedAt = '2026-10-26T12:00:00.000Z';
function profile(overrides: Partial<ProfileMatch> = {}): ProfileMatch {
  return { platform: 'YouTube', category: 'social', title: 'Brand', url: 'https://youtube.com/@brand',
    displayUrl: 'youtube.com/@brand', snippet: 'Official', confidence: 90, signals: ['Official link'],
    methods: ['serper'], ...overrides };
}
function savedRun(profiles: ProfileMatch[] = []): BulkBrandRun {
  return {
    id: 'saved-run', status: 'completed', createdAt: checkedAt, updatedAt: checkedAt, heartbeatAt: checkedAt,
    workerId: 'worker', resumeVersion: 1, stopRequested: false, estimatedCostUsd: 0,
    items: [{
      candidate: { profileId: 42, profileName: 'Brand', tier: 3, tierRank: 1, accountId: 'ref-id',
        platform: 'instagram', handle: 'brand', url: 'https://instagram.com/brand' },
      status: 'completed', platforms: [
        { platform: 'Instagram', status: 'reference', reason: 'Starting account', evidenceUrls: [], checkedAt },
        { platform: 'YouTube', status: 'needs_review', reason: 'Needs identity checks', evidenceUrls: ['https://brand.example'], checkedAt },
        { platform: 'TikTok', status: 'not_found', reason: 'No supported match', evidenceUrls: [], checkedAt },
      ],
      result: { subject: 'Brand', query: 'Brand social', searchedAt: checkedAt, profiles, sources: [],
        totalFound: profiles.length, highConfidenceCount: 0, methodsUsed: [], estimatedCostUsd: 0 },
    }],
  };
}

// Independent CSV reader: verifies field and record boundaries, including embedded newlines.
function records(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { current.push(cell); cell = ''; }
    else if (c === '\r' && csv[i + 1] === '\n' && !quoted) {
      current.push(cell); rows.push(current); current = []; cell = ''; i++;
    } else cell += c;
  }
  assert.equal(quoted, false);
  const headers = rows.shift()!;
  assert.deepEqual(headers, [...BULK_CSV_HEADERS]);
  return rows.map(values => {
    assert.equal(values.length, headers.length);
    return Object.fromEntries(headers.map((header, i) => [header, values[i]]));
  });
}

test('exports confirmed aliases under one candidate, including starting-account aliases', () => {
  const p = profile({ channelId: 'UCbrand', urlAliases: ['https://youtube.com/@brand', 'https://youtube.com/channel/UCbrand'] });
  const run = savedRun([p]);
  run.items[0].result!.referenceProfile = { platform: 'instagram', handle: 'brand', url: run.items[0].candidate.url,
    urlAliases: ['https://instagram.com/brand/'] };
  const rows = records(bulkRunToCsv(run));
  assert.equal(rows.length, 3);
  assert.equal(rows[1].discovered_url, p.url);
  assert.equal(rows[1].confirmed_aliases, p.urlAliases!.join('\n'));
  assert.equal(rows[1].reference_confirmed_aliases, 'https://instagram.com/brand/');
  assert.equal(rows[1].brand_id, '42');
  assert.equal(rows[1].tier, '3');
  assert.equal(rows[1].reference_account_id, 'ref-id');
});

test('missing verification leaves net confidence blank, never substitutes discovery', () => {
  const row = records(bulkRunToCsv(savedRun([profile()])))[1];
  assert.equal(row.discovery_score_0_100, '90');
  assert.equal(row.net_confidence_evidence_score_0_100, '');
  assert.equal(row.net_confidence_status, 'unassessed');
  assert.match(row.net_confidence_explanation, /discovery score alone is not identity confidence/);
});

test('uses the shared evidence score for complete and partial verification, including mismatch caps', () => {
  const meta = { platform: 'youtube', handle: 'brand', url: 'https://youtube.com/@brand' };
  const full = profile({ identityComparison: { status: 'likely', score: 100, reasons: [], reference: meta, candidate: meta },
    jevVerification: { verdict: 'mismatch', sameIdentityProbability: 0.9, verdictConfidence: 1, probabilities: {} } });
  const partial = profile({ ...full, url: 'https://youtube.com/@other', jevVerification: undefined });
  const rows = records(bulkRunToCsv(savedRun([full, partial]))).filter(r => r.discovered_url);
  for (const [i, p] of [full, partial].entries()) {
    const net = getNetConfidence(p);
    assert.equal(rows[i].net_confidence_evidence_score_0_100, String(net.score));
    assert.equal(rows[i].net_confidence_status, net.status);
    assert.equal(rows[i].net_confidence_explanation, net.explanation);
    assert.match(rows[i].net_confidence_explanation, /not a calibrated probability/);
  }
  assert.equal(rows[0].net_confidence_evidence_score_0_100, '49');
});

test('retains incomplete providers, successful candidates, failed items, errors, and not-found semantics', () => {
  const run = savedRun([profile()]);
  const result = run.items[0].result!;
  result.methodsUsed = [
    { method: 'serper', label: 'Serper', status: 'used', estimatedCostUsd: 0, costNote: 'Cached', durationMs: 1, results: [] },
    { method: 'tavily', label: 'Tavily', status: 'failed', estimatedCostUsd: 0, costNote: 'Timed out', durationMs: 100, results: [] },
  ];
  result.sources = [{ title: 'Official', url: 'https://brand.example', snippet: 'Social links' }];
  result.historySaveError = 'History unavailable';
  run.error = 'Run warning';
  run.items[0].platforms[2].status = 'incomplete';
  run.items.push({ candidate: { ...run.items[0].candidate, profileId: 43 }, status: 'failed',
    error: 'Provider error', platforms: [{ platform: 'TikTok', status: 'incomplete', reason: 'Provider error', evidenceUrls: [], checkedAt }] });
  run.items.push({ ...run.items[1], candidate: { ...run.items[1].candidate, profileId: 44 },
    status: 'queued', platforms: [], error: undefined });
  const before = structuredClone(run);
  const rows = records(bulkRunToCsv(run));
  assert.deepEqual(run, before);
  assert.equal(rows.length, 5);
  assert.equal(rows[1].discovered_url, profile().url);
  assert.deepEqual(JSON.parse(rows[1].provider_results_json), result.methodsUsed);
  assert.deepEqual(JSON.parse(rows[1].search_sources_json), result.sources);
  assert.equal(rows[1].outcome_evidence_urls, 'https://brand.example');
  assert.equal(rows[1].checked_at, checkedAt);
  assert.equal(rows[1].history_save_error, 'History unavailable');
  assert.equal(rows[1].run_error, 'Run warning');
  assert.equal(rows[2].outcome, 'incomplete');
  assert.match(rows[2].outcome_caution, /no conclusion/);
  assert.equal(rows[3].item_status, 'failed');
  assert.equal(rows[3].item_error, 'Provider error');
  assert.equal(rows[4].item_status, 'queued');
  assert.equal(rows[4].outcome, '');
  const notFound = records(bulkRunToCsv(savedRun()))[2];
  assert.equal(notFound.outcome, 'not_found');
  assert.match(notFound.outcome_caution, /not confirmed absence/);
  assert.equal(notFound.net_confidence_evidence_score_0_100, '');
});

test('preserves explicit-unavailable status without upgrading an unsourced claim', () => {
  const run = savedRun();
  run.items[0].platforms[2].status = 'explicit_unavailable';
  assert.match(records(bulkRunToCsv(run))[2].outcome_caution, /unverified/);
  run.items[0].platforms[2].evidenceUrls = ['https://brand.example/no-tiktok'];
  const row = records(bulkRunToCsv(run))[2];
  assert.equal(row.outcome, 'explicit_unavailable');
  assert.equal(row.outcome_caution, '');
  assert.equal(row.outcome_evidence_urls, 'https://brand.example/no-tiktok');
});

test('round-trips commas, quotes, newlines, Unicode and neutralizes spreadsheet formulas in every cell', () => {
  const run = savedRun([profile({ snippet: 'Line one,\r\n"Line two" — 音楽' })]);
  run.items[0].candidate.profileName = 'Música, "Brand"\n第二行';
  run.items[0].error = '=HYPERLINK("https://evil.example")';
  run.items[0].platforms[1].reason = '  +SUM(1,2)';
  const rows = records(bulkRunToCsv(run));
  assert.equal(rows[1].candidate_snippet, run.items[0].result!.profiles[0].snippet);
  assert.equal(rows[1].brand_name, run.items[0].candidate.profileName);
  assert.equal(rows[1].item_error, `'${run.items[0].error}`);
  assert.equal(rows[1].outcome_reason, "'  +SUM(1,2)");
  for (const value of ['=1', '+1', '-1', '@SUM(1)', '\tformula', '\rformula', '\nformula', ' \t=1', '\u0000@x']) {
    assert.ok(escapeCsvCell(value).startsWith(`"'`), JSON.stringify(value));
  }
  assert.equal(escapeCsvCell('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(escapeCsvCell(0), '"0"');
});

test('retains candidates without a saved platform outcome and exports an empty run with headers', () => {
  const run = savedRun([profile({ platform: 'Other' })]);
  const row = records(bulkRunToCsv(run)).at(-1)!;
  assert.equal(row.target_platform, 'Other');
  assert.equal(row.outcome, '');
  run.items = [];
  assert.deepEqual(records(bulkRunToCsv(run)), []);
});

test('download builds a local UTF-8 CSV without network calls or approval/write operations', async t => {
  let downloaded: Blob | undefined, clicked = false, removed = false, revoked = false;
  const anchor = { href: '', download: '', click: () => { clicked = true; }, remove: () => { removed = true; } };
  const fetchMock = t.mock.method(globalThis, 'fetch', () => { throw new Error('Export must not use network'); });
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { downloaded = blob; return 'blob:csv'; });
  t.mock.method(URL, 'revokeObjectURL', () => { revoked = true; });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => { callback(); return 0; });
  Object.defineProperty(globalThis, 'document', { configurable: true,
    value: { createElement: () => anchor, body: { appendChild: () => {} } } });
  t.after(() => { Reflect.deleteProperty(globalThis, 'document'); });
  const run = savedRun([profile()]);
  downloadBulkRunCsv(run);
  assert.ok(clicked && removed && revoked);
  assert.equal(anchor.href, 'blob:csv');
  assert.equal(anchor.download, 'bulk-brand-run-saved-run.csv');
  assert.equal(downloaded!.type, 'text/csv;charset=utf-8');
  const bytes = new Uint8Array(await downloaded!.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(await downloaded!.text(), bulkRunToCsv(run));
  assert.equal(fetchMock.mock.callCount(), 0);
});
