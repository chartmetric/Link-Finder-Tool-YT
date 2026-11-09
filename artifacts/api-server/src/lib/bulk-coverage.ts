import type {
  BulkCoverage, BulkProfileType, BulkCoverageGroup, BulkCoverageState,
  BulkCoverageProfile, BulkCoverageProfiles,
} from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { coverageReferenceKeySql } from "./coverage-reference-sql";
import { createCoverageCache } from "./coverage-cache";
import { logger } from "./logger";

export const COVERAGE_PLATFORMS = ["Instagram", "TikTok", "YouTube"] as const;
export const COVERAGE_STATES: BulkCoverageState[] = [
  "likely_only", "needs_review", "no_match", "explicit_absence", "provider_failure", "unresolved",
];
const kinds: BulkProfileType[] = ["brand", "creator", "artist"];
const groups: BulkCoverageGroup[] = ["tiers_1_3", "tiers_1_5", "all"];
export const coveragePlatformCoveredConditionSql = `itemStatus = 'completed' AND (
      hasCandidateLink OR
      outcomeStatus = 'not_found' OR
      (outcomeStatus IN ('reference', 'explicit_unavailable') AND notEmpty(evidenceUrls))
    )`;
export const coverageAllPlatformsConditionSql = "countIf(platformCovered) = 3";
type CoverageRow = {
  profileType: BulkProfileType; group: BulkCoverageGroup; platform: typeof COVERAGE_PLATFORMS[number];
  total: number; covered: number; allPlatformsCoveredProfiles: number;
  profilesWithActiveLinks: number;
  profilesWithLinkCandidates: number; fullyResolvedProfiles: number;
  profilesWithLinksOrFullyResolved: number;
  unrankedProfiles: number;
  investigated: number; uncoveredInvestigated: number;
} & Record<BulkCoverageState, number>;

/** Counts and drill-down use the same latest assessment per profile/platform.
 * Singles link only through unambiguous trusted reference URLs/confirmed aliases;
 * no discovery, historical verification, name matching or new absence claims.
 * Current catalog IDs, classifications and global tiers determine membership. */
export const coverageCtes = `
WITH snapshots AS (
  SELECT run_id, argMax(data_json, version) AS snapshot, max(version) AS v
  FROM poc_new_verticals.profile_bulk_events
  WHERE event_type = 'snapshot' GROUP BY run_id
), snapshot_items AS (
  SELECT run_id, v, arrayJoin(JSONExtractArrayRaw(snapshot, 'items')) AS item FROM snapshots
), bulk_assessments AS (
  SELECT JSONExtractUInt(item, 'candidate', 'profileId') AS profileId, platform,
    JSONExtractString(item, 'status') AS itemStatus,
    JSONExtractRaw(item, 'result') AS resultJson,
    arrayFilter(o -> JSONExtractString(o, 'platform') = platform,
      JSONExtractArrayRaw(item, 'platforms')) AS outcomes,
    arrayElement(outcomes, 1) AS outcome,
    length(outcomes) AS outcomeCount,
    JSONExtractString(outcome, 'status') AS outcomeStatus,
    JSONExtractString(outcome, 'reason') AS reason,
    JSONExtract(outcome, 'evidenceUrls', 'Array(String)') AS evidenceUrls,
    JSONExtractString(outcome, 'checkedAt') AS checkedAt,
    JSONExtractString(item, 'candidate', 'url') AS referenceUrl,
    JSONExtractString(item, 'error') AS error,
    toString(run_id) AS sourceRunId, '' AS sourceHistoryId,
    itemStatus = 'completed'
      AND arrayCount(outcome -> JSONExtractString(outcome, 'platform') = platform
        AND notEmpty(JSONExtractArrayRaw(outcome, 'evidenceUrls'))
        AND (
          JSONExtractString(outcome, 'status') IN ('reference', 'explicit_unavailable')
          OR (JSONExtractString(outcome, 'status') = 'found'
            AND arrayExists(candidate ->
              lower(JSONExtractString(candidate, 'platform')) = lower(platform)
              AND JSONExtractString(candidate, 'jevVerification', 'verdict') = 'verified',
              JSONExtractArrayRaw(item, 'result', 'profiles')))
        ), JSONExtractArrayRaw(item, 'platforms')) = 1 AS resolved,
    coalesce(parseDateTime64BestEffortOrNull(JSONExtractString(item, 'completedAt'), 3),
      parseDateTime64BestEffortOrNull(JSONExtractString(item, 'startedAt'), 3)) AS assessedAt,
    v AS sourceVersion, concat('bulk:', toString(v), ':', toString(profileId), ':', toString(run_id)) AS assessmentId,
    JSONExtractString(item, 'result', 'historyId') AS historyId
  FROM snapshot_items ARRAY JOIN ['Instagram', 'TikTok', 'YouTube'] AS platform
  WHERE notEmpty(JSONExtractString(item, 'startedAt'))
), saved_singles AS (
  SELECT id, known_profile_url, result_json, searched_at,
    arrayDistinct(arrayFilter(url -> notEmpty(url), arrayConcat(
      [${coverageReferenceKeySql("known_profile_url")}],
      arrayMap(url -> ${coverageReferenceKeySql("url")},
        arrayConcat([JSONExtractString(result_json, 'referenceProfile', 'url')],
          JSONExtract(result_json, 'referenceProfile', 'urlAliases', 'Array(String)')))
    ))) AS referenceKeys
  FROM poc_new_verticals.profile_search_history
  WHERE notEmpty(${coverageReferenceKeySql("known_profile_url")})
    AND has(arrayMap(url -> ${coverageReferenceKeySql("url")},
      arrayConcat([JSONExtractString(result_json, 'referenceProfile', 'url')],
        JSONExtract(result_json, 'referenceProfile', 'urlAliases', 'Array(String)'))),
      ${coverageReferenceKeySql("known_profile_url")})
), reference_keys AS (
  SELECT DISTINCT arrayJoin(referenceKeys) AS referenceKey FROM saved_singles
), catalog_references AS (
  SELECT l.profile_id AS profileId, ${coverageReferenceKeySql("a.account_url")} AS referenceKey
  FROM new_vertical.l_profile_account l
  INNER JOIN new_vertical.account a ON a.id = l.account_id
  WHERE l.disconnected_at IS NULL
    AND ${coverageReferenceKeySql("a.account_url")} IN (SELECT referenceKey FROM reference_keys)
  UNION DISTINCT
  SELECT profile_id AS profileId, ${coverageReferenceKeySql("url")} AS referenceKey
  FROM new_vertical.profile_links
  WHERE active = 'true'
    AND ${coverageReferenceKeySql("url")} IN (SELECT referenceKey FROM reference_keys)
), single_matches AS (
  SELECT s.id AS id, any(c.profileId) AS profileId
  FROM (SELECT id, arrayJoin(referenceKeys) AS referenceKey FROM saved_singles) s
  INNER JOIN catalog_references c ON c.referenceKey = s.referenceKey
  GROUP BY s.id HAVING uniqExact(c.profileId) = 1
), single_assessments AS (
  SELECT m.profileId AS profileId, platform, s.result_json AS resultJson,
    lower(JSONExtractString(s.result_json, 'referenceProfile', 'platform')) = lower(platform) AS isReference,
    arrayFilter(candidate -> lower(JSONExtractString(candidate, 'platform')) = lower(platform),
      JSONExtractArrayRaw(s.result_json, 'profiles')) AS candidates,
    arrayExists(candidate -> JSONExtractString(candidate, 'jevVerification', 'verdict') = 'verified'
      AND notEmpty(${coverageReferenceKeySql("JSONExtractString(candidate, 'url')")}), candidates) AS verified,
    arrayExists(candidate -> JSONExtractString(candidate, 'jevVerification', 'verdict') = 'likely'
      OR (empty(JSONExtractString(candidate, 'jevVerification', 'verdict'))
        AND JSONExtractString(candidate, 'identityComparison', 'status') = 'likely'), candidates) AS likely,
    arrayExists(candidate -> if(notEmpty(JSONExtractString(candidate, 'jevVerification', 'verdict')),
      JSONExtractString(candidate, 'jevVerification', 'verdict') != 'mismatch',
      JSONExtractString(candidate, 'identityComparison', 'status') != 'mismatch'), candidates) AS needsReview,
    arrayAll(method -> arrayExists(m -> JSONExtractString(m, 'method') = method
      AND JSONExtractString(m, 'status') = 'used', JSONExtractArrayRaw(s.result_json, 'methodsUsed')),
      ['serper', 'gemini']) AS discoveryComplete,
    multiIf(isReference, 'reference', verified OR likely, 'found',
      needsReview, 'needs_review', discoveryComplete, 'not_found', 'incomplete') AS outcomeStatus,
    multiIf(isReference, 'Saved trusted reference account.',
      verified, 'Saved verified identity match.',
      likely, 'Saved likely identity assessment; verification is still required.',
      needsReview, 'Saved candidates need review before establishing a match.',
      discoveryComplete, 'Saved discovery providers completed without a supported match. This is not confirmed absence.',
      'Saved discovery evidence is incomplete or a required provider was unavailable.') AS reason,
    if(isReference,
      arrayDistinct(arrayFilter(url -> notEmpty(url), arrayConcat(
        [JSONExtractString(s.result_json, 'referenceProfile', 'url')],
        JSONExtract(s.result_json, 'referenceProfile', 'urlAliases', 'Array(String)')))),
      arrayDistinct(arrayFilter(url -> notEmpty(url), arrayFlatten(arrayMap(candidate ->
        arrayConcat([JSONExtractString(candidate, 'url')],
          JSONExtract(candidate, 'urlAliases', 'Array(String)')), candidates))))) AS evidenceUrls,
    toString(s.searched_at) AS checkedAt, s.known_profile_url AS referenceUrl,
    'completed' AS itemStatus, '' AS error, toUInt64(1) AS outcomeCount,
    '' AS sourceRunId, toString(s.id) AS sourceHistoryId,
    (isReference OR verified) AS resolved,
    s.searched_at AS assessedAt, toUInt64(0) AS sourceVersion,
    concat('single:', toString(s.id)) AS assessmentId
  FROM saved_singles s INNER JOIN single_matches m ON m.id = s.id
  ARRAY JOIN ['Instagram', 'TikTok', 'YouTube'] AS platform
  WHERE toString(s.id) NOT IN (SELECT historyId FROM bulk_assessments WHERE notEmpty(historyId))
), all_assessments AS (
  SELECT profileId, platform, resolved, assessedAt, sourceVersion, assessmentId, resultJson,
    itemStatus, outcomeCount, outcomeStatus, reason, evidenceUrls, checkedAt,
    referenceUrl, error, sourceRunId, sourceHistoryId FROM bulk_assessments
  UNION ALL
  SELECT profileId, platform, resolved, assessedAt, sourceVersion, assessmentId, resultJson,
    itemStatus, outcomeCount, outcomeStatus, reason, evidenceUrls, checkedAt,
    referenceUrl, error, sourceRunId, sourceHistoryId FROM single_assessments
), latest_platforms AS (
  SELECT profileId, platform,
    argMax(resolved, tuple(assessedAt, sourceVersion, assessmentId)) AS platformResolved,
    argMax(tuple(resultJson, itemStatus, outcomeCount, outcomeStatus, reason, evidenceUrls,
      checkedAt, referenceUrl, error, sourceRunId, sourceHistoryId),
      tuple(assessedAt, sourceVersion, assessmentId)) AS latest
  FROM all_assessments GROUP BY profileId, platform
), assessments AS (
  SELECT *, countIf(platformResolved) OVER (PARTITION BY profileId) = 3 AS resolved
  FROM latest_platforms
), current_profiles AS (
  SELECT id, argMax(tuple(deleted_at, profile_type, profile_types, name), updated_at) AS data
  FROM new_vertical.profile GROUP BY id
  HAVING tupleElement(data, 1) IS NULL
), active_account_links AS (
  SELECT tupleElement(r.link, 1) AS profileId,
    uniqExact(tupleElement(r.link, 2)) AS activeLinkCount
  FROM (
    SELECT id, argMax(tuple(profile_id, account_id, disconnected_at), modified_at) AS link
    FROM new_vertical.l_profile_account
    GROUP BY id
    HAVING tupleElement(link, 3) IS NULL
  ) r
  INNER JOIN (
    SELECT id, argMax(tuple(ifNull(account_url, ''), is_active), modified_at) AS account
    FROM new_vertical.account
    GROUP BY id
    HAVING tupleElement(account, 2) = 1 AND notEmpty(tupleElement(account, 1))
  ) a ON a.id = tupleElement(r.link, 2)
  GROUP BY profileId
), memberships AS (
  SELECT id, tupleElement(data, 4) AS profileName, arrayJoin(arrayDistinct(arrayFilter(
    x -> x IN ('brand', 'creator', 'musician'),
    arrayConcat([tupleElement(data, 2)], tupleElement(data, 3))))) AS sourceType
  FROM current_profiles
), tiers AS (
  SELECT profile, profile_type, tupleElement(argMax(tuple(tier), tuple(computed_at, updated_at)), 1) AS tier
  FROM new_vertical.l_profile_tier
  WHERE grain = 'global' AND profile_type IN ('brand', 'creator', 'musician')
  GROUP BY profile, profile_type
), scoped AS (
  SELECT m.id AS profileId, m.profileName AS profileName,
    if(m.sourceType = 'musician', 'artist', m.sourceType) AS profileType,
    arrayJoin(arrayConcat(['all'],
      if(t.tier BETWEEN 1 AND 3, ['tiers_1_3'], []),
      if(t.tier BETWEEN 1 AND 5, ['tiers_1_5'], []))) AS \`group\`,
    t.tier AS tier
  FROM memberships m
  LEFT JOIN tiers t ON t.profile = m.id AND t.profile_type = m.sourceType
), unranked_profile_counts AS (
  SELECT profileType, uniqExactIf(profileId, ifNull(tier, 0) NOT BETWEEN 1 AND 5) AS unrankedProfiles
  FROM scoped
  WHERE \`group\` = 'all'
  GROUP BY profileType
), platform_evidence AS (
  SELECT s.profileId AS profileId, s.profileName AS profileName, s.profileType AS profileType,
    s.\`group\` AS \`group\`, s.tier AS tier, p.resolved AS resolved,
    p.profileId != 0 AS investigated, platforms.requestedPlatform AS platform,
    tupleElement(p.latest, 1) AS resultJson, tupleElement(p.latest, 2) AS itemStatus,
    tupleElement(p.latest, 3) AS outcomeCount, tupleElement(p.latest, 4) AS outcomeStatus,
    tupleElement(p.latest, 5) AS reason, tupleElement(p.latest, 6) AS evidenceUrls,
    tupleElement(p.latest, 7) AS checkedAt, tupleElement(p.latest, 8) AS referenceUrl,
    tupleElement(p.latest, 9) AS error, tupleElement(p.latest, 10) AS sourceRunId,
    tupleElement(p.latest, 11) AS sourceHistoryId,
    arrayExists(candidate ->
      lower(JSONExtractString(candidate, 'platform')) = lower(p.platform)
      AND (JSONExtractString(candidate, 'jevVerification', 'verdict') = 'likely'
        OR (empty(JSONExtractString(candidate, 'jevVerification', 'verdict'))
          AND JSONExtractString(candidate, 'identityComparison', 'status') = 'likely')),
      JSONExtractArrayRaw(resultJson, 'profiles')) AS hasLikely,
    arrayExists(candidate ->
      lower(JSONExtractString(candidate, 'platform')) = lower(p.platform)
      AND JSONExtractString(candidate, 'jevVerification', 'verdict') = 'verified',
      JSONExtractArrayRaw(resultJson, 'profiles')) AS hasVerified,
    arrayExists(candidate ->
      lower(JSONExtractString(candidate, 'platform')) = lower(p.platform)
      AND notEmpty(JSONExtractString(candidate, 'url'))
      AND JSONExtractString(candidate, 'jevVerification', 'verdict') != 'mismatch'
      AND JSONExtractString(candidate, 'identityComparison', 'status') != 'mismatch',
      JSONExtractArrayRaw(resultJson, 'profiles')) AS hasCandidateLink,
    multiIf(
      investigated = 0 OR p.resolved = 1, '',
      outcomeCount > 1, 'needs_review',
      p.platformResolved = 1, if(outcomeStatus = 'explicit_unavailable', 'explicit_absence', ''),
      outcomeStatus = 'found' AND hasVerified AND notEmpty(evidenceUrls) AND itemStatus = 'completed', '',
      outcomeStatus = 'found' AND hasLikely AND notEmpty(evidenceUrls), 'likely_only',
      outcomeStatus IN ('needs_review', 'found', 'reference', 'explicit_unavailable'), 'needs_review',
      outcomeStatus = 'not_found' AND itemStatus = 'completed', 'no_match',
      outcomeStatus = 'incomplete' OR itemStatus = 'failed', 'provider_failure',
      'unresolved') AS evidenceState
  FROM scoped s
  CROSS JOIN (SELECT arrayJoin(['Instagram', 'TikTok', 'YouTube']) AS requestedPlatform) platforms
  LEFT JOIN assessments p ON p.profileId = s.profileId AND p.platform = platforms.requestedPlatform
), platform_coverage AS (
  SELECT *,
    ${coveragePlatformCoveredConditionSql} AS platformCovered
  FROM platform_evidence
), coverage_profile_resolution AS (
  SELECT profileType, \`group\`, profileId,
    ${coverageAllPlatformsConditionSql} AS allPlatformsCovered
  FROM platform_coverage
  GROUP BY profileType, \`group\`, profileId
), coverage_profile_counts AS (
  SELECT profileType, \`group\`,
    uniqExactIf(profileId, allPlatformsCovered) AS allPlatformsCoveredProfiles,
    countIf(hasLinks = 1) AS profilesWithLinkCandidates,
    countIf(fullyResolved = 1) AS fullyResolvedProfiles,
    countIf(hasLinks = 1 OR fullyResolved = 1) AS profilesWithLinksOrFullyResolved
  FROM (
    SELECT r.profileType AS profileType, r.\`group\` AS \`group\`, r.profileId AS profileId,
      r.allPlatformsCovered AS allPlatformsCovered,
      c.hasLinks AS hasLinks, c.fullyResolved AS fullyResolved
    FROM coverage_profile_resolution r
    INNER JOIN (
      SELECT profileType, \`group\`, profileId,
        max(toUInt8(ifNull(outcomeStatus IN ('found', 'needs_review') AND itemStatus = 'completed'
          AND notEmpty(evidenceUrls), 0))) AS hasLinks,
        max(toUInt8(ifNull(resolved = 1, 0))) AS fullyResolved
      FROM platform_evidence
      GROUP BY profileType, \`group\`, profileId
    ) c ON r.profileType = c.profileType AND r.\`group\` = c.\`group\` AND r.profileId = c.profileId
  ) profile_counts
  GROUP BY profileType, \`group\`
), catalog_link_counts AS (
  SELECT s.profileType AS profileType, s.\`group\` AS \`group\`,
    uniqExactIf(s.profileId, ifNull(a.activeLinkCount, 0) > 0) AS profilesWithActiveLinks
  FROM scoped s
  LEFT JOIN active_account_links a ON a.profileId = s.profileId
  GROUP BY s.profileType, s.\`group\`
)
`;

export const bulkCoverageSql = `${coverageCtes}
SELECT p.profileType AS profileType, p.\`group\` AS \`group\`, p.platform AS platform, count() AS total,
  countIf(p.resolved = 1) AS covered,
  any(q.allPlatformsCoveredProfiles) AS allPlatformsCoveredProfiles,
  any(l.profilesWithActiveLinks) AS profilesWithActiveLinks,
  any(q.profilesWithLinkCandidates) AS profilesWithLinkCandidates,
  any(q.fullyResolvedProfiles) AS fullyResolvedProfiles,
  any(q.profilesWithLinksOrFullyResolved) AS profilesWithLinksOrFullyResolved,
  any(u.unrankedProfiles) AS unrankedProfiles,
  countIf(p.investigated = 1) AS investigated,
  countIf(p.investigated = 1 AND p.resolved = 0) AS uncoveredInvestigated,
  ${COVERAGE_STATES.map(state => `countIf(evidenceState = '${state}') AS ${state}`).join(",\n  ")}
FROM platform_evidence p
LEFT JOIN coverage_profile_counts q
  ON q.profileType = p.profileType AND q.\`group\` = p.\`group\`
LEFT JOIN catalog_link_counts l
  ON l.profileType = p.profileType AND l.\`group\` = p.\`group\`
LEFT JOIN unranked_profile_counts u ON u.profileType = p.profileType
GROUP BY p.profileType, p.\`group\`, p.platform FORMAT JSON`;

export function coverageResponse(rows: CoverageRow[], generatedAt = new Date().toISOString()): BulkCoverage {
  return {
    platforms: [...COVERAGE_PLATFORMS], generatedAt,
    types: kinds.map(profileType => ({
      profileType,
      unrankedProfiles: Number(rows.find(row => row.profileType === profileType && row.group === "all")?.unrankedProfiles ?? 0),
      buckets: groups.map(group => {
        const matching = rows.filter(row => row.profileType === profileType && row.group === group);
        const row = matching[0];
        return {
          group, total: Number(row?.total ?? 0), covered: Number(row?.covered ?? 0),
          allPlatformsCoveredProfiles: Number(row?.allPlatformsCoveredProfiles ?? 0),
          profilesWithActiveLinks: Number(row?.profilesWithActiveLinks ?? 0),
          profilesWithLinkCandidates: Number(row?.profilesWithLinkCandidates ?? 0),
          fullyResolvedProfiles: Number(row?.fullyResolvedProfiles ?? 0),
          profilesWithLinksOrFullyResolved: Number(row?.profilesWithLinksOrFullyResolved ?? 0),
          investigated: Number(row?.investigated ?? 0),
          uncoveredInvestigated: Number(row?.uncoveredInvestigated ?? 0),
          platformBreakdown: COVERAGE_PLATFORMS.map(platform => ({
            platform, states: COVERAGE_STATES.map(state => ({
              state, count: Number(matching.find(r => r.platform === platform)?.[state] ?? 0),
            })),
          })),
        };
      }),
    })),
  };
}

export const bulkCoverageProfilesSql = `${coverageCtes}
SELECT profileId, profileName, nullIf(tier, 0) AS tier, platform, evidenceState AS state,
  if(notEmpty(p.reason), p.reason, if(itemStatus = 'failed', error, 'No completed platform evidence is saved.')) AS reason,
  evidenceUrls, checkedAt, sourceRunId, sourceHistoryId, referenceUrl
FROM platform_evidence p
WHERE profileType = {profileType:String} AND \`group\` = {group:String}
  AND platform = {platform:String} AND evidenceState = {state:String}
  AND investigated = 1 AND resolved = 0 AND profileId > {afterId:UInt64}
ORDER BY profileId ASC LIMIT {pageSize:UInt32} FORMAT JSON`;

export function coverageProfilesResponse(rows: BulkCoverageProfile[], afterId: number, limit: number): BulkCoverageProfiles {
  const profiles = rows.slice(0, limit).map(row => ({ ...row, profileId: Number(row.profileId) }));
  return {
    profiles, hasMore: rows.length > limit,
    nextAfterId: profiles.at(-1)?.profileId ?? afterId, generatedAt: new Date().toISOString(),
  };
}

export async function listBulkCoverageProfiles(params: {
  profileType: BulkProfileType; group: BulkCoverageGroup; platform: string;
  state: BulkCoverageState; afterId: number; limit: number;
}): Promise<BulkCoverageProfiles> {
  const rows = await clickHouseJson<BulkCoverageProfile>(bulkCoverageProfilesSql, {
    profileType: params.profileType, group: params.group, platform: params.platform, state: params.state,
    afterId: String(params.afterId), pageSize: String(params.limit + 1),
  }, 60_000);
  return coverageProfilesResponse(rows.data, params.afterId, params.limit);
}

const coverageCache = createCoverageCache(async () => {
  const rows = await clickHouseJson<CoverageRow>(bulkCoverageSql, {}, 60_000);
  return coverageResponse(rows.data);
}, error => logger.warn({ err: error }, "Coverage calculation failed; retaining last successful snapshot when available"));

export function invalidateBulkCoverage() {
  coverageCache.invalidate();
}
export function getBulkCoverage(): Promise<BulkCoverage> {
  return coverageCache.get();
}
