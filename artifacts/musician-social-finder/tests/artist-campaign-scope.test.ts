import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignScopeView } from '../src/lib/artist-campaign-scope';

const tier = (n: number, total: number, checked: number, likely: number) => ({
  tier: n, totalArtists: total, processedArtists: checked, checkedArtists: checked,
  likelyMatches: likely, notAcceptedArtists: checked - likely, incompleteArtists: 0,
  processedPercent: total ? checked / total * 100 : 0, successRate: checked ? likely / checked * 100 : null,
});
const progress = {
  campaignId: 'mixed-campaign', totalArtists: 1000, processedArtists: 500,
  checkedArtists: 400, likelyMatches: 200, notAcceptedArtists: 200, incompleteArtists: 100,
  processedPercent: 50, successRate: 50, reservedUsd: 40,
  tierBreakdown: [tier(1, 10, 1, 1), tier(2, 20, 9, 3), tier(3, 30, 0, 0),
    tier(4, 40, 0, 0), tier(5, 50, 0, 0), tier(6, 850, 390, 196)],
};
test('all scope preserves original totals; tier scope recomputes weighted counts and excludes other tiers', () => {
  assert.equal(campaignScopeView(progress, 'all').counts, progress);
  const result = campaignScopeView(progress, 'tiers_1_5').counts!;
  assert.equal(result.totalArtists, 150);
  assert.equal(result.processedArtists, 10);
  assert.equal(result.checkedArtists, 10);
  assert.equal(result.likelyMatches, 4);
  assert.equal(result.successRate, 40);
  assert.equal(result.processedPercent, 10 / 150 * 100);
  assert.equal(progress.reservedUsd, 40);
});
test('only the known tier-only campaign can reuse headline totals without a tier breakdown', () => {
  const source = { ...progress, tierBreakdown: undefined };
  assert.equal(campaignScopeView(source, 'tiers_1_5').counts, null);
  const known = { ...source, campaignId: 'full-tiers-1-5-no-ig-usd100' };
  assert.equal(campaignScopeView(known, 'tiers_1_5').counts, known);
});
test('missing or duplicated tiers never silently substitute all-artist counts', () => {
  for (const rows of [progress.tierBreakdown.slice(0, 4),
    [...progress.tierBreakdown.slice(0, 4), progress.tierBreakdown[0]]]) {
    assert.equal(campaignScopeView({ ...progress, tierBreakdown: rows }, 'tiers_1_5').counts, null);
  }
});
test('no checked artists has no success rate; empty tier scope has zero processed percentage', () => {
  const result = campaignScopeView({ ...progress,
    tierBreakdown: [1, 2, 3, 4, 5].map(n => tier(n, 0, 0, 0)),
  }, 'tiers_1_5').counts!;
  assert.equal(result.processedPercent, 0);
  assert.equal(result.successRate, null);
});
