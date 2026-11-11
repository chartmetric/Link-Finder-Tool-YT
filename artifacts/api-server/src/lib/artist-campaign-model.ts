export const CAMPAIGN_ID = "full-tiers-1-5-no-ig-usd100";
export const CAMPAIGN_QUEUE_SHA256 = "9d7abb7e11a718f465725115d46b678afeb50a114cba1efc61c921aab0364928";
export const CAMPAIGN_DIRECTORY = "generated-artifacts/next-saved-full-tiers-1-5-usd100";

export type Counts = { processed: number; checked: number; likely: number; reserved: number };
export const zero = (): Counts => ({ processed: 0, checked: 0, likely: 0, reserved: 0 });
export const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw Error("Invalid campaign count.");
  return Number(value);
};
export function checkpointCounts(artist: any): Counts {
  const candidate = artist.candidates?.[0];
  const checked = Boolean(candidate?.recordedAnswer);
  const processed = checked || ["unavailable", "unsupported"].includes(candidate?.status)
    || candidate?.reason === "interrupted_or_uncertain_no_retry";
  return { processed: Number(processed), checked: Number(checked),
    likely: Number(checked && candidate?.review?.reviewSuggestion === true), reserved: 0 };
}
export function artistTotals(total: number, totals: Counts) {
  count(total); Object.values(totals).forEach(count);
  if (totals.likely > totals.checked || totals.checked > totals.processed || totals.processed > total)
    throw Error("Campaign totals do not agree.");
  return {
    totalArtists: total, processedArtists: totals.processed, checkedArtists: totals.checked,
    likelyMatches: totals.likely, notAcceptedArtists: totals.checked - totals.likely,
    incompleteArtists: totals.processed - totals.checked,
    processedPercent: total ? totals.processed / total * 100 : 0,
    successRate: totals.checked ? totals.likely / totals.checked * 100 : null,
  };
}
export function progressTotals(total: number, totals: Counts, status: string, updatedAt: string, now = Date.now(),
  maximumSpendCents: number | null = 10000) {
  if (maximumSpendCents !== null && maximumSpendCents !== 10000) throw Error("Unrecognized campaign spending approval.");
  if (maximumSpendCents !== null && totals.reserved > maximumSpendCents) throw Error("Campaign reservations exceed the approved cap.");
  return {
    ...artistTotals(total, totals), status,
    reservedUsd: totals.reserved / 100, maximumSpendUsd: maximumSpendCents === null ? null : maximumSpendCents / 100, updatedAt,
    stale: status === "running" && now - Date.parse(updatedAt) > 120_000,
  };
}
