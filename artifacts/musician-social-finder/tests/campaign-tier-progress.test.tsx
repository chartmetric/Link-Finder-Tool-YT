import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getGetArtistCampaignProgressQueryKey } from "@workspace/api-client-react";
import { ArtistCampaignProgress } from "../src/components/artist-campaign-progress";

function render(tiersAvailable: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(getGetArtistCampaignProgressQueryKey(), { progress: {
    status: "running", totalArtists: 20, processedArtists: 4, checkedArtists: 3, likelyMatches: 1,
    notAcceptedArtists: 2, incompleteArtists: 1, processedPercent: 20, successRate: 100 / 3,
    reservedUsd: 0.1, maximumSpendUsd: 100, updatedAt: "2026-11-11T12:00:00Z", stale: false,
    ...(tiersAvailable ? { tierBreakdown: [1, 2, 3, 4, 5].map(tier => ({
      tier, totalArtists: 4, processedArtists: tier === 1 ? 4 : 0, checkedArtists: tier === 1 ? 3 : 0,
      likelyMatches: tier === 1 ? 1 : 0, notAcceptedArtists: tier === 1 ? 2 : 0,
      incompleteArtists: tier === 1 ? 1 : 0, processedPercent: tier === 1 ? 100 : 0,
      successRate: tier === 1 ? 100 / 3 : null,
    })) } : { tierBreakdownUnavailableReason: "Frozen tier evidence unavailable." }),
  } });
  try {
    return renderToStaticMarkup(<QueryClientProvider client={client}><ArtistCampaignProgress /></QueryClientProvider>);
  } finally { client.clear(); }
}

test("tier detail is collapsed by default with explicit rate denominators and all five frozen tiers", () => {
  const html = render(true);
  assert.match(html, /<details[^>]*data-testid="campaign-tier-details"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  for (const tier of [1, 2, 3, 4, 5]) assert.match(html, new RegExp(`data-testid="campaign-tier-${tier}"`));
  assert.match(html, /33\.3%/);
  assert.match(html, /Likely \/ checked/);
  assert.match(html, /1 \/ 3/);
  assert.match(html, /n\/a/);
  assert.match(html, /No artists checked yet/);
  assert.match(html, /not current catalog tiers/);
  assert.match(html, /excluded from that rate/);
  assert.match(html, /text-campaign-processed/);
  // All colors use shared theme tokens so the panel follows light and dark mode.
  assert.match(html, /border-border bg-background\/50/);
  assert.match(html, /text-muted-foreground/);
});

test("unavailable tier evidence keeps headline totals visible without fabricated tier cards", () => {
  const html = render(false);
  assert.match(html, /Frozen tier evidence unavailable/);
  assert.match(html, /text-campaign-processed/);
  assert.doesNotMatch(html, /data-testid="campaign-tier-1"/);
});
