import { createHash } from "node:crypto";
import type { YoutubeArtistProgress } from "@workspace/api-zod";

export const YOUTUBE_RUN_ID = "youtube-no-link-20-usd2";
export const YOUTUBE_CAMPAIGN_ID = "full-tiers-1-5-no-youtube-uncapped";
export const youtubeDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requireValue = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
type ScopeArtist = { profile_id: string; cm_artist: string; tier: number };
type Decision = { status: string; reason: string; reviewSuggestion: boolean; inputSha256: string; score: number | null };
type Outcome = { artist: { profileId: string; cmArtist: string }; searchStatus: string;
  candidates: { decision: Decision }[]; outcome: string };
type Approval = { id: string; scopeSha256: string; scope: ScopeArtist[]; capCents: number; artists: number };
type Budget = { id: string; scope_sha256: string; cap_cents: number; reserved_cents: number; status: string };
export function buildYoutubeArtistProgress(approval: Approval, outcomes: Outcome[], budget: Budget,
  phaseStatus: string, updatedAt: string, capturedAt: string): YoutubeArtistProgress {
  requireValue(approval.id === YOUTUBE_RUN_ID && budget.id === approval.id
    && approval.scopeSha256 === youtubeDigest(approval.scope) && budget.scope_sha256 === approval.scopeSha256,
    "YouTube progress approval binding changed.");
  requireValue(approval.capCents === 200 && budget.cap_cents === 200, "YouTube spending cap changed.");
  const scope = new Map(approval.scope.map(a => [String(a.profile_id), a]));
  requireValue(scope.size === approval.artists && approval.scope.length === approval.artists,
    "Duplicate YouTube scope.");
  requireValue(approval.scope.every(a => Number(a.tier) >= 1 && Number(a.tier) <= 5), "Invalid YouTube tiers.");
  const seen = new Set<string>();
  let searched = 0, withCandidates = 0, checked = 0, likely = 0, noChannel = 0, held = 0, pending = 0;
  const completedStates = new Set(["likely_artist_owned", "not_artist_owned", "related_catalog_channel", "ownership_conflict"]);
  for (const row of outcomes) {
    const id = String(row.artist.profileId), artist = scope.get(id);
    requireValue(artist && String(artist.cm_artist) === String(row.artist.cmArtist) && !seen.has(id),
      "Unbound or duplicate YouTube artist.");
    seen.add(id);
    requireValue(["candidates_found", "no_match", "failed", "admitted"].includes(row.searchStatus), "Unknown search state.");
    if (!["candidates_found", "no_match"].includes(row.searchStatus)) {
      requireValue(row.candidates.length === 0, "Failed search has completed findings.");
      continue;
    }
    searched++;
    if (row.searchStatus === "no_match") {
      requireValue(row.candidates.length === 0 && row.outcome === "completed_no_channel_result",
        "No-channel result conflicts with evidence.");
      noChannel++;
      continue;
    }
    requireValue(row.candidates.length > 0, "Candidate search is empty.");
    withCandidates++;
    let artistChecked = false, artistLikely = false;
    for (const { decision: d } of row.candidates) {
      requireValue(d && typeof d.status === "string" && /^[a-f0-9]{64}$/.test(d.inputSha256),
        "Missing saved ownership decision.");
      const hasCheck = completedStates.has(d.status)
        || (d.status === "needs_identity_check" && d.reason === "recorded_model_uncertain_or_unresolved_channel_type"
          && typeof d.score === "number" && Number.isFinite(d.score));
      artistChecked ||= hasCheck;
      if (d.reviewSuggestion) {
        requireValue(d.status === "likely_artist_owned" && hasCheck, "Suggestion is not an ownership check.");
        artistLikely = true;
      }
      if (d.reason === "model_request_exceeds_approved_byte_limit") held++;
      if (["needs_identity_check", "needs_channel_metadata"].includes(d.status)) pending++;
      else requireValue(completedStates.has(d.status), "Unknown ownership state.");
    }
    checked += Number(artistChecked);
    likely += Number(artistLikely);
  }
  return validateYoutubeArtistProgress({
    runId: approval.id, scopeSha256: approval.scopeSha256, status: phaseStatus,
    totalArtists: approval.artists, searchedArtists: searched,
    processedPercent: approval.artists ? searched / approval.artists * 100 : 0,
    artistsWithCandidates: withCandidates, checkedArtists: checked, likelyMatches: likely,
    notAcceptedArtists: checked - likely, uncheckedArtists: withCandidates - checked,
    noChannelFound: noChannel, heldCandidates: held, pendingCandidates: pending,
    successRate: checked ? likely / checked * 100 : null,
    reservedUsd: budget.reserved_cents / 100, maximumSpendUsd: budget.cap_cents / 100,
    updatedAt, capturedAt,
  });
}

export function validateYoutubeArtistProgress(value: unknown): YoutubeArtistProgress {
  const p = value as YoutubeArtistProgress;
  requireValue(p && [YOUTUBE_RUN_ID, YOUTUBE_CAMPAIGN_ID].includes(p.runId) && /^[a-f0-9]{64}$/.test(p.scopeSha256)
    && ["completed", "stopped", "running"].includes(p.status), "Invalid YouTube snapshot identity.");
  for (const n of [p.totalArtists, p.searchedArtists, p.artistsWithCandidates, p.checkedArtists,
    p.likelyMatches, p.notAcceptedArtists, p.uncheckedArtists, p.noChannelFound, p.heldCandidates, p.pendingCandidates])
    requireValue(Number.isSafeInteger(n) && n >= 0, "Invalid YouTube counter.");
  requireValue(p.likelyMatches <= p.checkedArtists && p.checkedArtists <= p.artistsWithCandidates
    && p.artistsWithCandidates + p.noChannelFound === p.searchedArtists
    && p.searchedArtists <= p.totalArtists && p.notAcceptedArtists === p.checkedArtists - p.likelyMatches
    && p.uncheckedArtists === p.artistsWithCandidates - p.checkedArtists
    && p.heldCandidates <= p.pendingCandidates, "YouTube counters disagree.");
  requireValue(p.processedPercent === (p.totalArtists ? p.searchedArtists / p.totalArtists * 100 : 0)
    && p.successRate === (p.checkedArtists ? p.likelyMatches / p.checkedArtists * 100 : null),
    "YouTube rate denominator changed.");
  requireValue(Number.isFinite(p.reservedUsd) && p.reservedUsd >= 0
    && (p.runId === YOUTUBE_RUN_ID
      ? p.maximumSpendUsd === 2 && p.reservedUsd <= 2
      : p.maximumSpendUsd === null), "YouTube budget counters disagree.");
  requireValue(p.deferredArtists === undefined || (Number.isSafeInteger(p.deferredArtists)
    && p.deferredArtists >= 0 && p.deferredArtists + p.searchedArtists <= p.totalArtists),
    "Invalid deferred YouTube artists.");
  requireValue(Number.isFinite(Date.parse(p.updatedAt)) && Number.isFinite(Date.parse(p.capturedAt))
    && Date.parse(p.updatedAt) <= Date.parse(p.capturedAt) + 5000, "Invalid evidence timestamp.");
  // Counters only. Never mirror bios, candidate URLs, SQL or credentials.
  return Object.fromEntries(["runId", "scopeSha256", "status", "totalArtists", "searchedArtists",
    "processedPercent", "artistsWithCandidates", "checkedArtists", "likelyMatches", "notAcceptedArtists",
    "uncheckedArtists", "noChannelFound", "heldCandidates", "pendingCandidates", "successRate",
    "reservedUsd", "maximumSpendUsd", "deferredArtists", "updatedAt", "capturedAt"].map(k => [k, p[k as keyof YoutubeArtistProgress]])) as unknown as YoutubeArtistProgress;
}
