import type { ArtistResultRow, ArtistResultField } from "@workspace/api-zod";

export type CampaignArtist = {
  profile_id: string; cm_artist: string; artist: string; tier: number; status: string;
  reason: string | null; result_sha256: string | null; candidates: number;
  checked: boolean; likely: boolean;
};
export type ArchivedCandidate = {
  url: string; capture?: { body?: { channelId?: string }; [key: string]: unknown };
  decision: { status: string; reason: string; reviewSuggestion: boolean; score: number | null; [key: string]: unknown };
  metadataActuallyUsed?: unknown; recordedAnswer?: { answer?: { verdict?: string }; [key: string]: unknown };
  [key: string]: unknown;
};
export type ArchivedArtist = {
  artist: { profileId: string; cmArtist: string; name: string; [key: string]: unknown };
  searchStatus: string; candidates: ArchivedCandidate[];
};
export const youtubeResultId = "youtube-full-tiers-1-5-no-youtube-uncapped";
export const youtubeFieldDefinitions: [string, ArtistResultField["group"]][] = [
  ["Artist name", "identity"], ["Profile ID", "identity"], ["Chartmetric artist ID", "identity"], ["Tier", "identity"],
  ["Candidate YouTube link", "identity"], ["Likely YouTube suggestion", "identity"], ["Channel ID", "identity"],
  ["Current result status", "decision"], ["Current reason", "decision"], ["Current likely suggestion", "decision"],
  ["Identity score", "decision"], ["Current verdict", "decision"], ["Archived decision (JSON)", "decision"],
  ["Recorded model judgment (JSON)", "decision"], ["Search outcome", "decision"],
  ["Exact metadata actually prepared for model (JSON)", "metadata"], ["Model delivery status", "provenance"],
  ["Captured channel details (JSON)", "metadata"], ["Available artist metadata (JSON)", "metadata"],
  ["Archived artist context (JSON)", "metadata"], ["Search receipt (JSON)", "raw"],
  ["Channel receipt (JSON)", "raw"], ["Exact model request and response receipt (JSON)", "raw"],
  ["Full archived candidate (JSON)", "raw"], ["Coordinator artist state (JSON)", "provenance"],
  ["All committed returned receipts for artist (JSON)", "raw"],
  ["Current channel-conflict profiles (JSON)", "provenance"], ["Archive result hash", "provenance"],
  ["Archive availability", "provenance"], ["Current holds observed at", "provenance"],
];
export function youtubeRow(a: CampaignArtist, candidate: ArchivedCandidate | null, index: number,
  conflictProfiles: string[], observedAt: string, record?: ArchivedArtist): ArtistResultRow {
  const d = candidate?.decision;
  // Coordinator artist holds also suppress other archived positives for that
  // artist. Never infer that an old likely judgment is still a current suggestion.
  const held = !!candidate && (conflictProfiles.length > 1 || a.reason === "channel_reused_across_catalog_artists");
  const assessed = !!d && (["likely_artist_owned", "related_catalog_channel", "not_artist_owned", "ownership_conflict"].includes(d.status)
    || (d.reason === "recorded_model_uncertain_or_unresolved_channel_type" && Number.isFinite(d.score)));
  const likely = !held && a.likely && d?.reviewSuggestion === true;
  const status = held ? "shared_handle" : a.status !== "completed" ? a.status === "in_progress" ? "pending" : a.status
    : !record ? "unavailable" : !candidate ? record.searchStatus === "no_match" ? "no_channel" : "unavailable"
    : likely ? "likely" : d?.reason === "model_request_exceeds_approved_byte_limit" ? "held"
    : assessed ? "checked_not_accepted" : d?.status === "needs_channel_metadata" ? "metadata_failed" : "pending";
  const reason = held ? "channel_reused_across_catalog_artists" : a.reason ?? d?.reason ?? record?.searchStatus ?? a.status;
  const verdict = held ? "ownership_conflict" : d?.status ?? null;
  const values: Record<string, unknown> = {
    "Artist name": a.artist, "Profile ID": a.profile_id, "Chartmetric artist ID": a.cm_artist, "Tier": a.tier,
    "Candidate YouTube link": candidate?.url, "Likely YouTube suggestion": likely ? candidate?.url : "",
    "Channel ID": candidate?.capture?.body?.channelId, "Current result status": status, "Current reason": reason,
    "Current likely suggestion": likely, "Identity score": d?.score, "Current verdict": verdict,
    "Archived decision (JSON)": d, "Recorded model judgment (JSON)": candidate?.recordedAnswer,
    "Search outcome": record?.searchStatus, "Exact metadata actually prepared for model (JSON)": candidate?.metadataActuallyUsed,
    "Model delivery status": candidate?.recordedAnswer ? "Recorded answer; exact sent request is retained in the model receipt."
      : candidate?.metadataActuallyUsed ? "Prepared input only; no completed model answer. Do not infer delivery."
      : "No model input or answer archived for this candidate.",
    "Captured channel details (JSON)": candidate?.capture, "Archived artist context (JSON)": record?.artist,
    "Full archived candidate (JSON)": candidate, "Coordinator artist state (JSON)": a,
    "Current channel-conflict profiles (JSON)": conflictProfiles, "Archive result hash": a.result_sha256,
    "Archive availability": a.status === "completed" && !record ? "Completed result not yet available in archive; refresh without retrying paid work."
      : a.status !== "completed" ? "No committed artist result; this is not a completed no-channel search." : "Immutable result loaded",
    "Current holds observed at": observedAt,
  };
  return { id: `${youtubeResultId}:${a.profile_id}:${index}`, artistName: a.artist, profileId: a.profile_id,
    candidateUrl: candidate?.url ?? null, verifiedUrl: null, status, score: d?.score ?? null, verdict,
    comparisonType: null, fields: youtubeFieldDefinitions.map(([label, group]) => ({
      label, group, value: values[label] == null ? "" : typeof values[label] === "object"
        ? JSON.stringify(values[label]) : String(values[label]),
    })) };
}
