import { pool } from "@workspace/db";
import type { MusicianPlatformCoverage } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";
import {
  getMusicianInstagramResearchCoverage, musicianTierSnapshotSql, musicianTierSnapshotStatus,
} from "./musician-instagram-research-coverage";

type Platform = "instagram" | "youtube";
type Tier = MusicianPlatformCoverage["tiers"][number];
type YoutubeRow = { tier: string | number; total: string | number } &
  Record<"catalog" | "supported" | "candidates" | "no_match" | "failed" | "pending" | "not_searched", string | number>;
type PilotRow = { profile_id: string; cm_artist: string; status: string; candidate_count: number; checked_at: Date };
const states = new Set(["candidates_found", "no_match", "failed", "admitted"]);
const emptyPilot = "SELECT toUInt64(0) profile_id,toUInt64(0) cm_artist,'' status,0 candidate_count,toDateTime64('1970-01-01',3,'UTC') checked_at WHERE 0";

export function youtubePilotSql(rows: PilotRow[]) {
  return rows.map(row => {
    if (!/^\d+$/.test(row.profile_id) || !/^\d+$/.test(row.cm_artist) || !states.has(row.status)
      || !Number.isSafeInteger(row.candidate_count) || row.candidate_count < 0)
      throw Error("Invalid saved YouTube evidence.");
    const at = new Date(row.checked_at).toISOString().replace("T", " ").replace("Z", "");
    return `SELECT toUInt64(${row.profile_id}) profile_id,toUInt64(${row.cm_artist}) cm_artist,
      '${row.status}' status,${row.candidate_count} candidate_count,toDateTime64('${at}',3,'UTC') checked_at`;
  }).join(" UNION ALL ") || emptyPilot;
}

// The YouTube surface intentionally reports catalog links plus the new test.
// Reconstructing all historical investigations exceeded the read deadline;
// those sources are explicitly excluded in the UI, not presented as zero matches.
export function youtubeCoverageSql(pilotRows: PilotRow[]) {
  return `WITH snapshot_tiers AS (
    SELECT profile,argMax(tier,tuple(computed_at,updated_at)) tier
    FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type='musician' AND grain='global'
      AND computed_at=toDateTime({snapshotAt:String},'UTC')
    GROUP BY profile HAVING tier BETWEEN 1 AND 5
  ), catalog_youtube AS (
    SELECT DISTINCT l.profile_id
    FROM new_vertical.l_profile_account l
    INNER JOIN new_vertical.account a ON a.id=l.account_id
    WHERE l.disconnected_at IS NULL AND lower(a.platform)='youtube'
      AND notEmpty(trim(ifNull(a.account_url,'')))
  ), pilot AS (${youtubePilotSql(pilotRows)}),
  evidence AS (
    SELECT t.tier tier,p.id profile_id,
      p.id IN (SELECT profile_id FROM catalog_youtube) catalog,
      y.status pilot_status,y.candidate_count pilot_candidates,
      y.profile_id!=0 AND y.cm_artist=p.cm_source_id use_pilot
    FROM snapshot_tiers t
    INNER JOIN (SELECT id,cm_source_id FROM new_vertical.profile FINAL
      WHERE cm_source='cm_artist' AND deleted_at IS NULL) p ON p.id=t.profile
    LEFT JOIN pilot y ON y.profile_id=p.id
  ), classified AS (
    SELECT tier,multiIf(
      catalog,'catalog',
      use_pilot AND pilot_status='candidates_found' AND pilot_candidates>0,'candidates',
      use_pilot AND pilot_status='no_match','no_match',
      use_pilot AND pilot_status='failed','failed',
      use_pilot AND pilot_status='admitted','pending',
      'not_searched') state
    FROM evidence
  )
  SELECT tier,count() total,
    countIf(state='catalog') catalog,countIf(state='supported') supported,
    countIf(state='candidates') candidates,countIf(state='no_match') no_match,
    countIf(state='failed') failed,countIf(state='pending') pending,
    countIf(state='not_searched') not_searched
  FROM classified GROUP BY tier ORDER BY tier FORMAT JSON`;
}

function nonnegative(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid coverage count.");
  return n;
}
export function youtubeCoverageResponse(rows: YoutubeRow[], snapshotAt: string | null, now = new Date()): MusicianPlatformCoverage {
  const snapshotStatus = musicianTierSnapshotStatus(snapshotAt, now);
  return { platform: "youtube", snapshotAt, snapshotStatus, generatedAt: now.toISOString(),
    tiers: snapshotStatus === "current" || snapshotStatus === "recent" ? rows.map(row => {
      const tier: Tier = {
        tier: nonnegative(row.tier), totalProfiles: nonnegative(row.total),
        catalogUrls: nonnegative(row.catalog), supportedResearchUrls: nonnegative(row.supported),
        unresolvedCandidates: nonnegative(row.candidates), noSupportedMatch: nonnegative(row.no_match),
        failed: nonnegative(row.failed), pending: nonnegative(row.pending), notSearched: nonnegative(row.not_searched),
      };
      const sum = tier.catalogUrls + tier.supportedResearchUrls + tier.unresolvedCandidates
        + tier.noSupportedMatch + tier.failed + tier.pending + tier.notSearched;
      if (sum !== tier.totalProfiles || tier.tier < 1 || tier.tier > 5) throw Error("YouTube coverage counts disagree.");
      return tier;
    }) : [] };
}

const youtubeCache = createCoverageCache(async () => {
  const snapshot = await clickHouseJson<{snapshot_at: string | null}>(musicianTierSnapshotSql, {}, 30_000);
  const raw = snapshot.data[0]?.snapshot_at;
  const at = raw ? new Date(raw.replace(" ", "T") + "Z").toISOString() : null;
  const status = musicianTierSnapshotStatus(at);
  if (status === "stale" || status === "unavailable") return youtubeCoverageResponse([], at);
  const { rows } = await pool.query<PilotRow>(`SELECT DISTINCT ON(profile_id) profile_id,cm_artist,status,
    jsonb_array_length(candidates_json) candidate_count,checked_at
    FROM youtube_discovery_test_results ORDER BY profile_id,checked_at DESC,run_id DESC`);
  const result = await clickHouseJson<YoutubeRow>(youtubeCoverageSql(rows), {snapshotAt: raw!}, 45_000);
  return youtubeCoverageResponse(result.data, at);
}, error => logger.warn({err: error}, "YouTube coverage refresh failed"));

export async function getMusicianPlatformCoverage(platform: Platform): Promise<MusicianPlatformCoverage> {
  if (platform === "youtube") {
    const result = await youtubeCache.get();
    const status = musicianTierSnapshotStatus(result.snapshotAt);
    return {...result, snapshotStatus: status, tiers: status === "current" || status === "recent" ? result.tiers : []};
  }
  const result = await getMusicianInstagramResearchCoverage();
  return { platform, snapshotAt: result.snapshotAt, snapshotStatus: result.snapshotStatus, generatedAt: result.generatedAt,
    tiers: result.tiers.map(t => ({
      tier: t.tier, totalProfiles: t.totalProfiles, catalogUrls: t.profilesWithCatalogInstagramUrls,
      supportedResearchUrls: t.profilesWithSupportedResearchUrls,
      unresolvedCandidates: t.profilesWithUnresolvedCandidates, noSupportedMatch: t.profilesWithNoSupportedMatch,
      failed: t.failedProfiles, pending: t.pendingProfiles,
      notSearched: Math.max(0, t.profilesWithFailedOrIncompleteSearches - t.failedProfiles - t.pendingProfiles),
    })) };
}
