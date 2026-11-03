import { clickHouseJson } from "./clickhouse-profiles";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";

type ResearchRow = {
  tier: number | string;
  total_profiles: number | string;
  profiles_with_instagram_urls: number | string;
  profiles_with_no_supported_match: number | string;
  profiles_with_url_or_no_supported_match: number | string;
};

export type MusicianInstagramResearchTier = {
  tier: number;
  totalProfiles: number;
  profilesWithInstagramUrls: number;
  profilesWithNoSupportedMatch: number;
  profilesWithUrlOrNoSupportedMatch: number;
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
  -- The saved Tier 1-3 discovery cohort was selected from profiles without an Instagram catalog link.
  -- Therefore, a tier profile with no saved research row has a catalog Instagram URL.
  tier_results AS (
    SELECT
      t.profile,
      t.assigned_tier AS tier,
      tupleElement(l.outcome, 1) AS research_status,
      tupleElement(l.outcome, 2) AS instagram_urls
    FROM tier_assignments AS t
    LEFT JOIN latest_lookup AS l ON toUInt64(t.profile) = l.profile_id
  ),
  profile_coverage AS (
    SELECT
      tier,
      research_status = ''
        OR (research_status = 'candidates_found' AND notEmpty(instagram_urls)) AS has_instagram_url,
      research_status = 'no_candidates' AS no_supported_match
    FROM tier_results
  )
  SELECT
    tier,
    count() AS total_profiles,
    countIf(has_instagram_url) AS profiles_with_instagram_urls,
    countIf(no_supported_match) AS profiles_with_no_supported_match,
    countIf(has_instagram_url OR no_supported_match) AS profiles_with_url_or_no_supported_match
  FROM profile_coverage
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
      profilesWithInstagramUrls: asCount(row?.profiles_with_instagram_urls),
      profilesWithNoSupportedMatch: asCount(row?.profiles_with_no_supported_match),
      profilesWithUrlOrNoSupportedMatch: asCount(row?.profiles_with_url_or_no_supported_match),
    };
  });

  return {
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
