import { pool } from "@workspace/db";
import type { MusicianPlatformCoverage } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";
import {
  musicianInstagramResearchProfileSql, musicianTierSnapshotSql, musicianTierSnapshotStatus,
} from "./musician-instagram-research-coverage";
import { createCampaignCoverageReader, type CoverageProfile } from "./campaign-coverage";
import { youtubeTestCoverage, type SavedYoutubeTest } from "./youtube-test-coverage";

type Platform = "instagram" | "youtube";
type Tier = MusicianPlatformCoverage["tiers"][number];
type YoutubeRow = { tier: string | number; total: string | number } &
  Record<"catalog" | "supported" | "candidates" | "no_match" | "failed" | "pending" | "not_searched", string | number> &
  Partial<Record<"test_likely" | "test_topic", string | number>>;
type PilotRow = { profile_id: string; cm_artist: string; status: string; candidate_count: number; checked_at: Date };
const states = new Set(["candidates_found", "no_match", "failed", "admitted", "test_likely", "test_topic"]);
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

// Report catalog links plus identity-bound saved batch results.
// Reconstructing all historical investigations exceeded the read deadline;
// those sources are explicitly excluded in the UI, not presented as zero matches.
export function youtubeCoverageProfileSql(pilotRows: PilotRow[]) {
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
    LEFT JOIN pilot y ON y.profile_id=p.id AND y.cm_artist=p.cm_source_id
  ), classified AS (
    SELECT profile_id,tier,multiIf(
      catalog,'catalog',
      use_pilot AND pilot_status='test_likely','test_likely',
      use_pilot AND pilot_status='test_topic','test_topic',
      use_pilot AND pilot_status='candidates_found' AND pilot_candidates>0,'candidates',
      use_pilot AND pilot_status='no_match','no_match',
      use_pilot AND pilot_status='failed','failed',
      use_pilot AND pilot_status='admitted','pending',
      'not_searched') state
    FROM evidence
  )`;
}

export function youtubeCoverageSql(pilotRows: PilotRow[]) {
  return `${youtubeCoverageProfileSql(pilotRows)}
  SELECT tier,count() total,
    countIf(state='catalog') catalog,countIf(state='supported') supported,
    countIf(state='test_likely') test_likely,countIf(state='test_topic') test_topic,
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
        testLikelyUrls: nonnegative(row.test_likely ?? 0), testTopicUrls: nonnegative(row.test_topic ?? 0),
        unresolvedCandidates: nonnegative(row.candidates), noSupportedMatch: nonnegative(row.no_match),
        failed: nonnegative(row.failed), pending: nonnegative(row.pending), notSearched: nonnegative(row.not_searched),
      };
      const sum = tier.catalogUrls + tier.supportedResearchUrls + tier.unresolvedCandidates
        + tier.testLikelyUrls! + tier.testTopicUrls!
        + tier.noSupportedMatch + tier.failed + tier.pending + tier.notSearched;
      if (sum !== tier.totalProfiles || tier.tier < 1 || tier.tier > 5) throw Error("YouTube coverage counts disagree.");
      return tier;
    }) : [] };
}

async function readMembership(platform: Platform) {
  const snapshot = await clickHouseJson<{snapshot_at: string | null}>(musicianTierSnapshotSql, {}, 30_000);
  const raw = snapshot.data[0]?.snapshot_at;
  const at = raw ? new Date(raw.replace(" ", "T") + "Z").toISOString() : null;
  const status = musicianTierSnapshotStatus(at);
  if (status === "stale" || status === "unavailable") return { platform, snapshotAt: at, generatedAt: new Date().toISOString(), profiles: [] as CoverageProfile[] };
  let sql: string;
  let testObservedAt: string | null = null;
  if (platform === "instagram") {
    sql = `${musicianInstagramResearchProfileSql}
      SELECT toString(v.profile) profile_id,toString(p.cm_source_id) cm_artist,v.tier tier,
        multiIf(has_catalog_instagram_url,'catalog',supported_research_only,'supported',
          no_supported_match,'no_match',unresolved_candidates,'candidates',
          research_status='failed','failed',research_status IN ('queued','running'),'pending','not_searched') state
      FROM profile_coverage v
      LEFT JOIN (SELECT id,cm_source_id FROM new_vertical.profile FINAL
        WHERE cm_source='cm_artist' AND deleted_at IS NULL AND id IN (SELECT profile FROM tier_assignments)) p ON p.id=v.profile
      FORMAT JSON`;
  } else {
    const saved = await pool.query<SavedYoutubeTest>(`SELECT DISTINCT ON(profile_id,cm_artist)
      profile_id,cm_artist,status,candidates_json,checked_at
      FROM youtube_discovery_test_results
      ORDER BY profile_id,cm_artist,
        CASE WHEN status IN ('admitted','review_prepared') THEN 1 ELSE 0 END,
        checked_at DESC,run_id DESC`);
    const rows = youtubeTestCoverage(saved.rows);
    if (rows.length) testObservedAt = new Date(Math.max(...rows.map(r => r.checked_at.getTime()))).toISOString();
    sql = `${youtubeCoverageProfileSql(rows)}
      SELECT toString(c.profile_id) profile_id,toString(p.cm_source_id) cm_artist,c.tier tier,c.state state
      FROM classified c
      INNER JOIN (SELECT id,cm_source_id FROM new_vertical.profile FINAL WHERE cm_source='cm_artist'
        AND deleted_at IS NULL AND id IN (SELECT profile FROM snapshot_tiers)) p ON p.id=c.profile_id
      FORMAT JSON`;
  }
  const result = await clickHouseJson<CoverageProfile>(sql, {snapshotAt: raw!}, 45_000);
  return { platform, snapshotAt: at, generatedAt: new Date().toISOString(), testObservedAt, profiles: result.data };
}

const membershipCaches = {
  instagram: createCoverageCache(() => readMembership("instagram"), error => logger.warn({err: error}, "Instagram coverage membership refresh failed")),
  youtube: createCoverageCache(() => readMembership("youtube"), error => logger.warn({err: error}, "YouTube coverage membership refresh failed")),
};
const readCoverage = createCampaignCoverageReader(platform => membershipCaches[platform].get());

export async function getMusicianPlatformCoverage(platform: Platform): Promise<MusicianPlatformCoverage> {
  return readCoverage(platform);
}
