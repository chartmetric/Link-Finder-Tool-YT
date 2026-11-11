export type CampaignScope = 'all' | 'tiers_1_5';
type Counters = {
  totalArtists: number; processedArtists: number; checkedArtists: number;
  likelyMatches: number; notAcceptedArtists: number; incompleteArtists: number;
  processedPercent: number; successRate: number | null;
};
type Progress = Counters & {
  campaignId: string;
  tierBreakdown?: (Counters & { tier: number })[];
};
const tierOnlyCampaign = 'full-tiers-1-5-no-ig-usd100';

/** Display projection only: never changes the paid queue or its approval. */
export function campaignScopeView(progress: Progress, scope: CampaignScope):
  { counts: Counters | null; note: string } {
  if (scope === 'all') return {
    counts: progress,
    note: 'All artists in this campaign—not the entire artist catalog.',
  };
  if (!progress.tierBreakdown) return progress.campaignId === tierOnlyCampaign
    ? { counts: progress, note: 'This campaign includes only tiers 1–5, so both tabs show the same totals.' }
    : { counts: null, note: 'Tier-filtered progress is unavailable for this campaign. No counts have been guessed.' };
  const rows = progress.tierBreakdown.filter(t => t.tier >= 1 && t.tier <= 5);
  if (rows.length !== 5 || new Set(rows.map(t => t.tier)).size !== 5
    || rows.some(t => !Number.isInteger(t.tier))) return {
      counts: null, note: 'Tier assignments are incomplete. Switch to All artists to see the campaign totals.',
    };
  const counts = rows.reduce((sum, t) => ({
    totalArtists: sum.totalArtists + t.totalArtists,
    processedArtists: sum.processedArtists + t.processedArtists,
    checkedArtists: sum.checkedArtists + t.checkedArtists,
    likelyMatches: sum.likelyMatches + t.likelyMatches,
    notAcceptedArtists: sum.notAcceptedArtists + t.notAcceptedArtists,
    incompleteArtists: sum.incompleteArtists + t.incompleteArtists,
    processedPercent: 0, successRate: null as number | null,
  }), { totalArtists: 0, processedArtists: 0, checkedArtists: 0, likelyMatches: 0,
    notAcceptedArtists: 0, incompleteArtists: 0, processedPercent: 0, successRate: null as number | null });
  counts.processedPercent = counts.totalArtists ? counts.processedArtists / counts.totalArtists * 100 : 0;
  counts.successRate = counts.checkedArtists ? counts.likelyMatches / counts.checkedArtists * 100 : null;
  return {
    counts,
    note: counts.totalArtists === progress.totalArtists
      ? 'This campaign includes only tiers 1–5, so both tabs show the same totals.'
      : 'Only artists assigned to tiers 1–5 when this campaign was approved. Spending is campaign-wide.',
  };
}
