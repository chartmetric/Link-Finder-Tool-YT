import { test as base, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ArtistResultBatch, ArtistResultRow, GetArtistResultRows200 } from '@workspace/api-client-react';
import { baseUrl, ProgressApi } from './progress-fixtures';

const scope = 'a'.repeat(24);
const time = '2026-11-10T10:00:00.000Z';
export const checkpoint: ArtistResultBatch = {
  id: `saved-alternatives-${scope}-${'c'.repeat(16)}`,
  title: 'Fixture durable checkpoint', source: 'diagnostic',
  createdAt: time, status: 'interrupted_checkpoint',
  artistCount: 1, candidateCount: 1, rowCount: 1, verifiedCount: 0,
  reviewCount: 0, notInspectedCount: 1, metadataFailedCount: 0, noCandidateCount: 0,
  reservedUsd: 0.12, reportedUsd: 0.03,
  explanation: 'Checkpoint evidence retained before the final observation.',
  metrics: [
    { label: 'Parent budget identity', value: 'fixture-approved-parent' },
    { label: 'Spending observation', value: 'Last durable parent snapshot; journal may be newer. No resume authorized.' },
    { label: 'Run date source', value: 'First journal event' },
  ],
};
export const final: ArtistResultBatch = {
  ...checkpoint,
  id: `saved-alternatives-${scope}-${'f'.repeat(16)}`,
  title: 'Fixture final observation', status: 'stopped',
  artistCount: 2, candidateCount: 2, rowCount: 2, verifiedCount: 1,
  reviewCount: 1, notInspectedCount: 0,
  reservedUsd: 0.48, reportedUsd: 0.27,
  explanation: 'Final evidence is a separate snapshot, not a checkpoint replacement.',
  metrics: [
    { label: 'Parent budget identity', value: 'fixture-approved-parent' },
    { label: 'Spending observation', value: 'Final saved parent snapshot, not an invoice' },
    { label: 'Run date source', value: 'First journal event' },
  ],
};
export const newer: ArtistResultBatch = {
  ...final,
  id: `saved-alternatives-${scope}-${'e'.repeat(16)}`,
  title: 'Fixture newer final observation', createdAt: '2026-11-10T11:00:00.000Z',
  artistCount: 3, candidateCount: 3, rowCount: 3, verifiedCount: 3,
  reviewCount: 0, reservedUsd: 0.96, reportedUsd: 0.81,
  explanation: 'Newer evidence must not replace the explicitly selected archive.',
};

function row(id: string, artistName: string, status: string): ArtistResultRow {
  const url = `https://www.instagram.com/${id}/`;
  return {
    id, artistName, profileId: `profile-${id}`, status,
    candidateUrl: url, verifiedUrl: status === 'verified' ? url : null,
    score: status === 'verified' ? 0.95 : null, verdict: null, comparisonType: 'saved',
    fields: [{ label: 'Saved archive evidence', value: `${id} original evidence`, group: 'provenance' }],
  };
}
export const checkpointRows = [row('checkpoint-only', 'Checkpoint-only musician', 'not_inspected')];
export const finalRows = [
  row('final-verified', 'Final verified musician', 'verified'),
  row('final-review', 'Final review musician', 'review'),
];
export const newerRows = [
  row('newer-one', 'Newer first musician', 'verified'),
  row('newer-two', 'Newer second musician', 'verified'),
  row('newer-three', 'Newer third musician', 'verified'),
];
const archives = [checkpoint, final, newer];
export function rowsFor(id: string): ArtistResultRow[] {
  if (id === checkpoint.id) return checkpointRows;
  if (id === final.id) return finalRows;
  if (id === newer.id) return newerRows;
  throw new Error(`Unknown fixture archive: ${id}`);
}
export const rowPath = (id: string) => `/api/bulk/artist-results/${id}/rows/0/25/q%3A/all`;
export const csvPath = (id: string) => `/api/bulk/artist-results/${id}/csv`;
export const csvContents = (b: ArtistResultBatch) =>
  `archive_id,artist_name,reported_usd\n${rowsFor(b.id)
    .map(r => `${b.id},${r.artistName},${b.reportedUsd}`).join('\n')}\n`;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export class ObservationApi extends ProgressApi {
  url = '';
  batches: ArtistResultBatch[] = [checkpoint, final];
  batchResponses: string[][] = [];
  rowRequests: string[] = [];
  csvRequests: string[] = [];
  delivered: string[] = [];
  private holds = new Map<string, ReturnType<typeof gate>>();
  private server?: Server;

  hold(id: string) { this.holds.set(id, gate()); }
  release(id: string) { this.holds.get(id)?.release(); }
  releaseAll() { for (const hold of this.holds.values()) hold.release(); }

  async close() {
    this.releaseAll();
    if (this.server) {
      const closed = once(this.server, 'close');
      this.server.close();
      this.server.closeAllConnections();
      await closed;
    }
  }

  override async install(page: Page) {
    this.readOnly = true;
    // Chromium's native <a download> requests bypass Playwright routing.
    // Put the entire page behind a loopback fixture gateway: native CSV reads
    // terminate here, and NO API request can ever be forwarded to a real API.
    // Only explicit frontend asset paths may be proxied to the Vite workflow.
    this.server = createServer(async (request, response) => {
      const path = new URL(request.url!, 'http://fixture.invalid').pathname;
      if (request.method === 'GET') {
        const batch = archives.find(b => csvPath(b.id) === path);
        if (batch) {
          this.csvRequests.push(path);
          response.writeHead(200, {
            'content-type': 'text/csv',
            'content-disposition': `attachment; filename="${batch.id}.csv"`,
          });
          response.end(csvContents(batch));
          return;
        }
      }
      if (request.method !== 'GET' || path.startsWith('/api/')
        || !/^\/(?:$|bulk\/artists$|src\/|@vite\/|@react-refresh$|@fs\/|node_modules\/|favicon\.svg$|@replit\/vite-plugin-dev-banner\/banner-script\.js$)/.test(path)) {
        this.unexpected.push(`Gateway blocked ${request.method} ${path}`);
        response.writeHead(403).end('Fixture gateway: not allowed');
        return;
      }
      try {
        const upstream = await fetch(new URL(request.url!, baseUrl()), { redirect: 'error' });
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        this.unexpected.push(`Frontend asset unavailable: ${path}: ${String(error)}`);
        response.writeHead(502).end('Fixture frontend unavailable');
      }
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    await super.install(page, this.url);
    // Registered last, so these exact fixture reads take precedence. Everything
    // else falls back to the existing deny-by-default API/external network guard.
    await page.context().route('**/api/**', async route => {
      const request = route.request();
      if (request.method() !== 'GET') return route.fallback();
      const path = new URL(request.url()).pathname;
      const json = (body: unknown) => route.fulfill({ json: body });
      if (path === '/api/bulk/billing-health') return json({ outages: [] });
      if (path === '/api/profiles/musician-instagram-research-coverage')
        return json({ snapshotAt: null, snapshotStatus: 'missing', tiers: [], history: [], generatedAt: time });
      if (path === '/api/profiles/musician-instagram-rerun-eligibility')
        return json({ count: 0, selectionToken: '0'.repeat(64), generatedAt: time });
      if (path === '/api/bulk/artist-results') {
        const batches = [...this.batches];
        await json({ batches, warnings: [] });
        this.batchResponses.push(batches.map(b => b.id));
        return;
      }
      for (const batch of archives) {
        if (path === rowPath(batch.id)) {
          this.rowRequests.push(path);
          await this.holds.get(batch.id)?.promise;
          const rows = rowsFor(batch.id);
          const body: GetArtistResultRows200 = { batch, rows, total: rows.length, nextOffset: null };
          await json(body);
          this.delivered.push(batch.id);
          return;
        }
        // Some browser versions route native downloads, others do not. Both
        // paths terminate in the same loopback fixture handler, never upstream.
        if (path === csvPath(batch.id)) return route.continue();
      }
      return route.fallback();
    });
  }
}

export const test = base.extend<{ api: ObservationApi }>({
  api: async ({ page }, use) => {
    const api = new ObservationApi();
    await api.install(page);
    try { await use(api); }
    finally {
      await api.close();
      expect(api.mutations, 'Opening observations must never start, stop, resume or investigate').toEqual([]);
      expect(api.unexpected, 'Only fixture API reads are permitted; unknown calls are blocked').toEqual([]);
    }
  },
});
export { expect };
