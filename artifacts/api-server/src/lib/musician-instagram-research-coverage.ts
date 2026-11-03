import { clickHouseJson } from "./clickhouse-profiles";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";

type ResearchRow = {
  tier: number | string;
  total_profiles: number | string;
  processed_profiles: number | string;
  profiles_with_instagram_urls: number | string;
  completed_no_candidate_profiles: number | string;
  failed_profiles: number | string;
  pending_profiles: number | string;
};

export type MusicianInstagramResearchTier = {
  tier: number;
  totalProfiles: number;
  processedProfiles: number;
  profilesWithInstagramUrls: number;
  completedNoCandidateProfiles: number;
  failedProfiles: number;
  pendingProfiles: number;
};

const tiers = [1, 2, 3] as const;

export const musicianInstagramResearchCoverageSql = `
  WITH fresh_tier_rows AS (
    SELECT profile, tier, computed_at, updated_at
    FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type = 'musician'
      AND computed_at >= toStartOfDay(now())
  ),
  tier_assignments AS (
    SELECT profile, argMax(tier, tuple(computed_at, updated_at)) AS assigned_tier
    FROM fresh_tier_rows
    GROUP BY profile
    HAVING assigned_tier IN (1, 2, 3)
  ),
  latest_lookup AS (
    SELECT profile_id,
      argMax(tuple(status, instagram_urls), updated_at) AS outcome
    FROM poc_new_verticals.musician_instagram_discovery_events
    GROUP BY profile_id
  ),
  tier_results AS (
    SELECT
      t.profile,
      t.assigned_tier AS tier,
      tupleElement(l.outcome, 1) AS status,
      tupleElement(l.outcome, 2) AS instagram_urls
    FROM tier_assignments AS t
    LEFT JOIN latest_lookup AS l ON toUInt64(t.profile) = l.profile_id
  )
  SELECT
    tier,
    count() AS total_profiles,
    countIf(status IN ('candidates_found', 'no_candidates')) AS processed_profiles,
    countIf(status = 'candidates_found' AND notEmpty(instagram_urls)) AS profiles_with_instagram_urls,
    countIf(status = 'no_candidates') AS completed_no_candidate_profiles,
    countIf(status = 'failed') AS failed_profiles,
    countIf(status IN ('queued', 'running')) AS pending_profiles
  FROM tier_results
  GROUP BY tier
  ORDER BY tier
  FORMAT JSON
`;

const asCount = (value: number | string | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function musicianInstagramResearchCoverageResponse(
  rows: ResearchRow[],
  generatedAt = new Date(),
) {
  const tierRows: MusicianInstagramResearchTier[] = tiers.map(tier => {
    const row = rows.find(item => Number(item.tier) === tier);
    return {
      tier,
      totalProfiles: asCount(row?.total_profiles),
      processedProfiles: asCount(row?.processed_profiles),
      profilesWithInstagramUrls: asCount(row?.profiles_with_instagram_urls),
      completedNoCandidateProfiles: asCount(row?.completed_no_candidate_profiles),
      failedProfiles: asCount(row?.failed_profiles),
      pendingProfiles: asCount(row?.pending_profiles),
    };
  });
  const sum = (key: keyof Omit<MusicianInstagramResearchTier, "tier">) =>
    tierRows.reduce((total, row) => total + row[key], 0);

  return {
    totalProfiles: sum("totalProfiles"),
    processedProfiles: sum("processedProfiles"),
    profilesWithInstagramUrls: sum("profilesWithInstagramUrls"),
    completedNoCandidateProfiles: sum("completedNoCandidateProfiles"),
    failedProfiles: sum("failedProfiles"),
    pendingProfiles: sum("pendingProfiles"),
    tiers: tierRows,
    generatedAt: generatedAt.toISOString(),
  };
}

const coverageCache = createCoverageCache(async () => {
  const result = await clickHouseJson<ResearchRow>(musicianInstagramResearchCoverageSql, {}, 30_000);
  return musicianInstagramResearchCoverageResponse(result.data);
}, error => logger.warn({ err: error }, "Musician Instagram research coverage failed; retaining last successful snapshot when available"));

export function getMusicianInstagramResearchCoverage() {
  return coverageCache.get();
}
