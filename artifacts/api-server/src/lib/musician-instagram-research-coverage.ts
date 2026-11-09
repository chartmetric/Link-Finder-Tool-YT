import { clickHouseJson } from "./clickhouse-profiles";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";
import type { MusicianInstagramResearchTier } from "@workspace/api-zod";

type ResearchRow = {
  tier: number | string;
  total_profiles: number | string;
  processed_profiles: number | string;
  profiles_with_instagram_urls: number | string;
  profiles_with_research_urls: number | string;
  profiles_with_no_supported_match: number | string;
  profiles_with_url_or_no_supported_match: number | string;
  completed_no_candidate_profiles: number | string;
  failed_profiles: number | string;
  pending_profiles: number | string;
  profiles_with_catalog_instagram_urls: number | string;
  profiles_with_research_candidates: number | string;
  profiles_with_failed_or_incomplete_searches: number | string;
};

type ResearchHistoryRow = {
  date: string;
  unique_profiles: number | string;
  cumulative_unique_profiles: number | string;
  attempts: number | string;
  candidate_profiles: number | string;
  candidate_attempts: number | string;
  candidate_urls: number | string;
  no_candidate_profiles: number | string;
  no_candidate_attempts: number | string;
  failed_profiles: number | string;
  failed_attempts: number | string;
  in_progress_attempts: number | string;
};

export type MusicianInstagramResearchHistoryDay = {
  date: string;
  uniqueProfiles: number;
  cumulativeUniqueProfiles: number;
  attempts: number;
  candidateProfiles: number;
  candidateAttempts: number;
  candidateUrls: number;
  noCandidateProfiles: number;
  noCandidateAttempts: number;
  failedProfiles: number;
  failedAttempts: number;
  inProgressAttempts: number;
};

const tiers = [1, 2, 3, 4, 5] as const;

export const musicianTierSnapshotMaxAgeMs = 36 * 60 * 60_000;

// Resolve once, before tier filtering: never fill gaps using older assignments.
export const musicianTierSnapshotSql = `
  SELECT toString(maxOrNull(computed_at), 'UTC') AS snapshot_at
  FROM new_vertical.l_profile_tier FINAL
  WHERE profile_type = 'musician' AND grain = 'global'
  FORMAT JSON
`;

export const musicianInstagramResearchCoverageSql = `
  WITH fresh_tier_rows AS (
    SELECT profile, tier, computed_at, updated_at
    FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type = 'musician' AND grain = 'global'
      AND computed_at = toDateTime({snapshotAt:String}, 'UTC')
  ),
  tier_assignments AS (
    SELECT profile, argMax(tier, tuple(computed_at, updated_at)) AS assigned_tier
    FROM fresh_tier_rows
    GROUP BY profile
    HAVING assigned_tier IN (1, 2, 3, 4, 5)
  ),
  catalog_instagram_profiles AS (
    SELECT l.profile_id,
      countIf(notEmpty(trim(ifNull(a.account_url, '')))) > 0 AS has_catalog_instagram_url
    FROM new_vertical.l_profile_account l
    INNER JOIN new_vertical.account a ON a.id = l.account_id
    WHERE l.disconnected_at IS NULL
      AND lower(a.platform) = 'instagram'
    GROUP BY l.profile_id
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
      tupleElement(l.outcome, 1) AS research_status,
      tupleElement(l.outcome, 2) AS instagram_urls,
      coalesce(c.has_catalog_instagram_url, 0) AS has_catalog_instagram_url
    FROM tier_assignments AS t
    LEFT JOIN latest_lookup AS l ON toUInt64(t.profile) = l.profile_id
    LEFT JOIN catalog_instagram_profiles AS c ON toUInt64(t.profile) = c.profile_id
  ),
  profile_coverage AS (
    SELECT
      tier,
      research_status,
      has_catalog_instagram_url,
      research_status = 'candidates_found' AND notEmpty(instagram_urls) AS has_research_url,
      has_catalog_instagram_url
        OR (research_status = 'candidates_found' AND notEmpty(instagram_urls)) AS has_instagram_url,
      research_status = 'no_candidates' AND NOT has_catalog_instagram_url AS no_supported_match
    FROM tier_results
  )
  SELECT
    tier,
    count() AS total_profiles,
    countIf(research_status IN ('candidates_found', 'no_candidates')) AS processed_profiles,
    countIf(has_instagram_url) AS profiles_with_instagram_urls,
    countIf(has_research_url) AS profiles_with_research_urls,
    countIf(no_supported_match) AS profiles_with_no_supported_match,
    countIf(has_instagram_url OR no_supported_match) AS profiles_with_url_or_no_supported_match,
    countIf(research_status = 'no_candidates') AS completed_no_candidate_profiles,
    countIf(research_status = 'failed') AS failed_profiles,
    countIf(research_status IN ('queued', 'running')) AS pending_profiles,
    countIf(has_catalog_instagram_url) AS profiles_with_catalog_instagram_urls,
    countIf(has_research_url) AS profiles_with_research_candidates,
    countIf(NOT has_instagram_url AND NOT no_supported_match) AS profiles_with_failed_or_incomplete_searches
  FROM profile_coverage
  GROUP BY tier
  ORDER BY tier
  FORMAT JSON
`;

export const musicianInstagramResearchHistorySql = `
  WITH fresh_tier_rows AS (
    SELECT profile, tier, computed_at, updated_at
    FROM new_vertical.l_profile_tier FINAL
    WHERE profile_type = 'musician' AND grain = 'global'
      AND computed_at = toDateTime({snapshotAt:String}, 'UTC')
  ),
  tier_assignments AS (
    SELECT profile, argMax(tier, tuple(computed_at, updated_at)) AS assigned_tier
    FROM fresh_tier_rows
    GROUP BY profile
    HAVING assigned_tier IN (1, 2, 3)
  ),
  attempts AS (
    SELECT
      e.profile_id,
      e.run_id,
      argMax(tuple(e.status, e.instagram_urls), tuple(e.updated_at, e.status)) AS outcome,
      max(e.updated_at) AS result_at,
      countIf(e.status = 'running') AS started_events
    FROM poc_new_verticals.musician_instagram_discovery_events AS e
    INNER JOIN tier_assignments AS t ON toUInt64(t.profile) = e.profile_id
    GROUP BY e.profile_id, e.run_id
    HAVING started_events > 0
  ),
  dated_attempts AS (
    SELECT
      toDate(result_at) AS day,
      profile_id,
      run_id,
      tupleElement(outcome, 1) AS status,
      tupleElement(outcome, 2) AS instagram_urls
    FROM attempts
    WHERE tupleElement(outcome, 1) != 'queued'
  ),
  daily AS (
    SELECT
      day,
      uniqExact(profile_id) AS unique_profiles,
      count() AS attempts,
      uniqExactIf(profile_id, status = 'candidates_found' AND notEmpty(instagram_urls)) AS candidate_profiles,
      countIf(status = 'candidates_found' AND notEmpty(instagram_urls)) AS candidate_attempts,
      sumIf(length(instagram_urls), status = 'candidates_found' AND notEmpty(instagram_urls)) AS candidate_urls,
      uniqExactIf(profile_id, status = 'no_candidates') AS no_candidate_profiles,
      countIf(status = 'no_candidates') AS no_candidate_attempts,
      uniqExactIf(profile_id, status = 'failed') AS failed_profiles,
      countIf(status = 'failed') AS failed_attempts,
      countIf(status = 'running') AS in_progress_attempts
    FROM dated_attempts
    GROUP BY day
  ),
  first_profile_day AS (
    SELECT profile_id, min(day) AS first_day
    FROM dated_attempts
    GROUP BY profile_id
  ),
  new_profiles AS (
    SELECT first_day AS day, count() AS new_unique_profiles
    FROM first_profile_day
    GROUP BY first_day
  ),
  cumulative AS (
    SELECT
      day,
      sum(new_unique_profiles) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_unique_profiles
    FROM new_profiles
  )
  SELECT
    d.day AS date,
    d.unique_profiles,
    c.cumulative_unique_profiles,
    d.attempts,
    d.candidate_profiles,
    d.candidate_attempts,
    d.candidate_urls,
    d.no_candidate_profiles,
    d.no_candidate_attempts,
    d.failed_profiles,
    d.failed_attempts,
    d.in_progress_attempts
  FROM daily AS d
  INNER JOIN cumulative AS c ON c.day = d.day
  WHERE d.day >= today() - 89
  ORDER BY d.day DESC
  LIMIT 90
  FORMAT JSON
`;

const asCount = (value: number | string | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function musicianInstagramResearchCoverageResponse(
  rows: ResearchRow[],
  snapshotAt: string | null,
  generatedAt = new Date(),
  historyRows: ResearchHistoryRow[] = [],
) {
  const snapshotStatus = musicianTierSnapshotStatus(snapshotAt, generatedAt);
  const tierRows: MusicianInstagramResearchTier[] = tiers.map(tier => {
    const row = rows.find(item => Number(item.tier) === tier);
    return {
      tier,
      totalProfiles: asCount(row?.total_profiles),
      processedProfiles: asCount(row?.processed_profiles),
      profilesWithInstagramUrls: asCount(row?.profiles_with_instagram_urls),
      profilesWithResearchUrls: asCount(row?.profiles_with_research_urls),
      profilesWithNoSupportedMatch: asCount(row?.profiles_with_no_supported_match),
      profilesWithUrlOrNoSupportedMatch: asCount(row?.profiles_with_url_or_no_supported_match),
      completedNoCandidateProfiles: asCount(row?.completed_no_candidate_profiles),
      failedProfiles: asCount(row?.failed_profiles),
      pendingProfiles: asCount(row?.pending_profiles),
      profilesWithCatalogInstagramUrls: asCount(row?.profiles_with_catalog_instagram_urls),
      profilesWithResearchCandidates: asCount(row?.profiles_with_research_candidates),
      profilesWithFailedOrIncompleteSearches: asCount(row?.profiles_with_failed_or_incomplete_searches),
    };
  });

  return {
    tiers: snapshotStatus === "current" || snapshotStatus === "recent" ? tierRows : [],
    snapshotAt,
    snapshotStatus,
    history: (snapshotStatus === "current" || snapshotStatus === "recent" ? historyRows : []).map(row => ({
      date: row.date,
      uniqueProfiles: asCount(row.unique_profiles),
      cumulativeUniqueProfiles: asCount(row.cumulative_unique_profiles),
      attempts: asCount(row.attempts),
      candidateProfiles: asCount(row.candidate_profiles),
      candidateAttempts: asCount(row.candidate_attempts),
      candidateUrls: asCount(row.candidate_urls),
      noCandidateProfiles: asCount(row.no_candidate_profiles),
      noCandidateAttempts: asCount(row.no_candidate_attempts),
      failedProfiles: asCount(row.failed_profiles),
      failedAttempts: asCount(row.failed_attempts),
      inProgressAttempts: asCount(row.in_progress_attempts),
    })),
    generatedAt: generatedAt.toISOString(),
  };

}

export function musicianTierSnapshotStatus(snapshotAt: string | null, now = new Date()) {
  const time = snapshotAt ? Date.parse(snapshotAt) : NaN;
  if (!Number.isFinite(time) || time > now.getTime()) return "unavailable" as const;
  if (now.getTime() - time > musicianTierSnapshotMaxAgeMs) return "stale" as const;
  return snapshotAt!.slice(0, 10) === now.toISOString().slice(0, 10) ? "current" as const : "recent" as const;
}

export function createMusicianInstagramResearchCoverage(
  read = clickHouseJson,
  now = () => new Date(),
  onError = (error: unknown) => logger.warn({ err: error }, "Musician Instagram research coverage failed; retaining last successful snapshot when available"),
) {
  const coverageCache = createCoverageCache(async () => {
    const snapshot = await read<{ snapshot_at: string | null }>(musicianTierSnapshotSql, {}, 30_000);
    const raw = snapshot.data[0]?.snapshot_at;
    const snapshotAt = raw ? new Date(`${raw.replace(" ", "T")}Z`).toISOString() : null;
    const status = musicianTierSnapshotStatus(snapshotAt, now());
    if (status === "stale" || status === "unavailable") {
      return musicianInstagramResearchCoverageResponse([], snapshotAt, now());
    }
    const params = { snapshotAt: raw! };
    const [result, history] = await Promise.all([
      read<ResearchRow>(musicianInstagramResearchCoverageSql, params, 30_000),
      read<ResearchHistoryRow>(musicianInstagramResearchHistorySql, params, 30_000),
    ]);
    return musicianInstagramResearchCoverageResponse(result.data, snapshotAt, now(), history.data);
  }, onError, () => now().getTime());

  return async () => {
    const result = await coverageCache.get();
    // Cache retention after a failed read must not extend the tier snapshot's age.
    const snapshotStatus = musicianTierSnapshotStatus(result.snapshotAt, now());
    return {
      ...result,
      snapshotStatus,
      tiers: snapshotStatus === "current" || snapshotStatus === "recent" ? result.tiers : [],
      history: snapshotStatus === "current" || snapshotStatus === "recent" ? result.history : [],
    };
  };
}

export const getMusicianInstagramResearchCoverage = createMusicianInstagramResearchCoverage();
