import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getGetMusicianPlatformCoverageQueryKey } from '@workspace/api-client-react';
import { MusicianPlatformCoverage } from '../src/components/bulk/musician-platform-coverage';

test('headline and tier percentage include likely matches, while catalog figures stay separate on both platforms', () => {
  for (const platform of ['instagram', 'youtube'] as const) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const value = {
      platform, snapshotStatus: 'current', snapshotAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(), catalogGeneratedAt: '2026-11-11T18:00:00Z',
      campaignObservedAt: '2026-11-11T18:54:00Z', campaignStatus: platform === 'youtube' ? 'stopped' : 'running',
      campaignIncluded: true, campaignError: null,
      tiers: [{ tier: 2, totalProfiles: 10, catalogUrls: 2, supportedResearchUrls: 1,
        campaignLikelyUrls: 2, unresolvedCandidates: 1, noSupportedMatch: 1, failed: 1, pending: 1, notSearched: 1 }],
    };
    const render = () => renderToStaticMarkup(
      <QueryClientProvider client={client}><MusicianPlatformCoverage platform={platform} /></QueryClientProvider>,
    );
    try {
      client.setQueryData(getGetMusicianPlatformCoverageQueryKey(platform), value);
      let html = render();
      assert.match(html, /text-platform-coverage-total-percent">50\.0%/);
      assert.match(html, /Catalog: 2 \(20\.0%\)/);
      assert.match(html, /Additional campaign likely matches: 2/);
      assert.match(html, /Each artist counts once/);
      assert.match(html, /not catalog additions/);
      assert.match(html, /mpc-seg campaign/);
      assert.match(html, /Campaign likely · review/);
      assert.match(html, /of 10 Tier 1–5 artists have a .* link or likely match/);
      assert.doesNotMatch(html, /<details[^>]*\bopen/);
      client.setQueryData(getGetMusicianPlatformCoverageQueryKey(platform), {
        ...value, tiers: [{ ...value.tiers[0], campaignLikelyUrls: 3, notSearched: 0 }],
      });
      html = render();
      assert.match(html, /text-platform-coverage-total-percent">60\.0%/);
      client.setQueryData(getGetMusicianPlatformCoverageQueryKey(platform), {
        ...value, campaignError: 'Campaign refresh unavailable. Coverage includes the last saved likely matches.',
      });
      assert.match(render(), /Campaign refresh unavailable/);
    } finally { client.clear(); }
  }
});
