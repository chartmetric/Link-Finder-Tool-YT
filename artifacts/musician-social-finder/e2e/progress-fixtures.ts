import { test as base, expect, type Page } from '@playwright/test';
import type { BulkBillingHealth, BulkBrandCandidate, BulkBrandRun, BulkBrandRunInput, MusicianInstagramResearchCoverage, MusicianInstagramRerunEligibility } from '@workspace/api-client-react';

export const ROOT = 'fixture-root-progress';
export const ARCHIVE = 'fixture-archive-1';
const time = '2026-10-27T12:00:00.000Z';

export const candidates: BulkBrandCandidate[] = Array.from({ length: 4 }, (_, n) => ({
  profileId: n + 1,
  profileName: `Fixture profile ${n + 1}`,
  profileType: 'brand',
  tier: 1,
  tierRank: n + 1,
  accountId: `fixture-account-${n + 1}`,
  platform: 'Instagram',
  handle: `fixture${n + 1}`,
  url: `https://www.instagram.com/fixture${n + 1}/`,
  canInvestigate: true,
  accountCount: 1,
}));

export function run(overrides: Partial<BulkBrandRun> = {}): BulkBrandRun {
  return {
    id: ROOT, status: 'running', createdAt: time, updatedAt: time, heartbeatAt: time,
    workerId: 'fixture-worker', resumeVersion: 0, stopRequested: false,
    estimatedCostUsd: 0.01, workersPerType: 2,
    scopes: [{ profileType: 'brand', limit: 4 }],
    items: candidates.map((candidate, n) => ({
      candidate, status: n < 2 ? 'running' : 'queued', platforms: [],
    })),
    ...overrides,
  };
}

export function continuous(cap?: number): BulkBrandRun {
  return run({
    continuous: {
      upperProfileId: 1000, profileLimit: cap, batches: 1,
      completed: 8, failed: 2, completedCostUsd: 0.1,
      cursors: [{ profileType: 'brand', afterId: 10, exhausted: false, completed: 8, failed: 2 }],
    },
  });
}

export function advance(previous: BulkBrandRun, terminal = false): BulkBrandRun {
  return {
    ...previous, status: terminal ? 'completed' : 'running',
    updatedAt: terminal ? '2026-10-27T12:00:06.000Z' : '2026-10-27T12:00:03.000Z',
    items: previous.items.map((item, n) => ({
      ...item,
      status: terminal ? (n % 2 ? 'failed' : 'completed')
        : n === 0 ? 'completed' : n === 1 ? 'failed' : n === 2 ? 'running' : 'queued',
      ...(n === 1 ? { error: 'Fixture provider failure (no provider called)' } : {}),
    })),
  };
}

export class ProgressApi {
  root = run();
  archive = run({
    id: ARCHIVE, archiveOf: ROOT, batchNumber: 1, status: 'completed',
    items: candidates.map(candidate => ({ candidate, status: 'completed', platforms: [] })),
  });
  starts: BulkBrandRunInput[] = [];
  readOnly = false;
  mutations: string[] = [];
  saved = false;
  writes: string[] = [];
  reads: Record<string, number> = {};
  // Saved run errors and the shared billing gate are independent snapshots.
  // Healthy by default so Start/Resume availability has an explicit fixture.
  billingHealth: BulkBillingHealth = { outages: [] };
  billingHealthReads = 0;
  errors = false;
  holdStart = false;
  releaseStart?: () => void;
  unexpected: string[] = [];

  async install(page: Page, frontendUrl = baseUrl()) {
    // Context routing also covers requests after reload/navigation. Never route
    // an unknown /api call through to the server, even if an assertion fails.
    const origin = new URL(frontendUrl).origin;
    await page.context().route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(req.method())) this.writes.push(`${req.method()} ${path}`);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
          const mutation = `${req.method()} ${path}`;
          this.mutations.push(mutation);
          if (this.readOnly) {
            this.unexpected.push(mutation);
            return route.abort('blockedbyclient');
          }
        }
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (path === '/api/bulk/billing-health' && req.method() === 'GET') {
          this.billingHealthReads++;
          return json(this.billingHealth);
        }
        // The artist scope loads saved research summaries, never a new search.
        if (path === '/api/bulk/artist-results' && req.method() === 'GET')
          return json({ batches: [], warnings: [] });
        if (path === '/api/profiles/musician-instagram-research-coverage' && req.method() === 'GET')
          return json({
            snapshotAt: null, snapshotStatus: 'unavailable', tiers: [], history: [], generatedAt: time,
          } satisfies MusicianInstagramResearchCoverage);
        if (path === '/api/profiles/musician-instagram-rerun-eligibility' && req.method() === 'GET')
          return json({
            count: 0, selectionToken: '0'.repeat(64), generatedAt: time,
          } satisfies MusicianInstagramRerunEligibility);
        if (path === '/api/bulk/coverage' && req.method() === 'GET')
          return json({ generatedAt: time, types: [], platforms: ['Instagram', 'TikTok', 'YouTube'] });
        if (path === '/api/bulk/brands/candidates' && req.method() === 'GET')
          return json({ profiles: candidates, hasMore: false, nextAfterId: 4, maxBatchSize: 25 });
        if (path === '/api/bulk/brands/runs' && req.method() === 'GET')
          return json({ runs: this.starts.length || this.saved ? [this.root] : [] });
        if (path === '/api/bulk/brands/runs' && req.method() === 'POST') {
          this.starts.push(req.postDataJSON());
          if (this.holdStart) await new Promise<void>(resolve => { this.releaseStart = resolve; });
          return json(this.root);
        }
        if (path === `/api/bulk/brands/runs/${ROOT}/batches/0` && req.method() === 'GET')
          return json({ runs: [this.archive], hasMore: false, nextBatch: 1 });
        const id = path.slice('/api/bulk/brands/runs/'.length);
        if (path.startsWith('/api/bulk/brands/runs/') && [ROOT, ARCHIVE].includes(id) && req.method() === 'GET') {
          this.reads[id] = (this.reads[id] ?? 0) + 1;
          return this.errors && id === ROOT
            ? json({ error: 'Fixture connection failure' }, 503)
            : json(id === ROOT ? this.root : this.archive);
        }
        this.unexpected.push(`${req.method()} ${path}`);
        return route.abort('blockedbyclient');
      }
      // Block external providers, analytics, images and fonts too. Only the
      // frontend's own assets may reach the network.
      if (url.origin !== origin) return route.abort('blockedbyclient');
      return route.continue();
    });
  }
}

export function baseUrl() {
  return process.env.E2E_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:80');
}

export const test = base.extend<{ api: ProgressApi }>({
  api: async ({ page }, use) => {
    const api = new ProgressApi();
    await api.install(page);
    await use(api);
    expect(api.unexpected, 'No unknown API request may reach a real server').toEqual([]);
  },
});
export { expect };

export async function open(page: Page, savedId?: string) {
  await page.addInitScript(id => {
    // Only seed on first entry, not every navigation/reload.
    if (!sessionStorage.getItem('progress-fixture-seeded')) {
      localStorage.clear();
      if (id) localStorage.setItem('bulk-brands:last-run', JSON.stringify(id));
      sessionStorage.setItem('progress-fixture-seeded', 'true');
    }
    const original = Element.prototype.scrollIntoView;
    (window as unknown as { progressScrolls: unknown[] }).progressScrolls = [];
    Element.prototype.scrollIntoView = function (options) {
      (window as unknown as { progressScrolls: unknown[] }).progressScrolls.push({
        target: this.getAttribute('data-testid') ?? this.id, options,
      });
      original.call(this, options);
    };
  }, savedId);
  // Keep timers running while responses settle: React Query schedules cache
  // notifications with setTimeout. Freezing before navigation strands the UI
  // on skeletons even after route.fulfill has completed.
  await page.clock.install();
  await page.goto('/bulk/brands');
  await expect(page.getByTestId('table-bulk-candidates')).toBeVisible();
}

export async function poll(page: Page, api: ProgressApi, id = ROOT, ms = 3100) {
  const before = api.reads[id] ?? 0;
  await page.clock.fastForward(ms);
  await expect.poll(() => api.reads[id] ?? 0).toBeGreaterThan(before);
}
