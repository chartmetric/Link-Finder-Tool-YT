import type { BulkCoverage, BulkProfileType } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";
import { coverageReferenceKeySql } from "./coverage-reference-sql";

export const COVERAGE_PLATFORMS = ["Instagram", "TikTok", "YouTube"];
const kinds: BulkProfileType[] = ["brand", "creator", "artist"];
const groups = ["tiers_1_3", "tiers_1_5", "all"] as const;
type CoverageRow = { profileType: BulkProfileType; group: typeof groups[number]; total: number; covered: number };

/** Latest saved evidence, not the number of runs or URLs. Catalog is read-only.
 * A found/likely outcome alone is deliberately insufficient for strict coverage.
 * Latest snapshots include archives. Singles are linked only through trusted
 * reference URLs/metadata-confirmed aliases, never names or discovered candidates.
 * Stored verdicts are consumed as-is: no historical verification or discovery. */
export const bulkCoverageSql = `
WITH snapshots AS (
  SELECT argMax(data_json, version) AS state, max(version) AS v
  FROM poc_new_verticals.profile_bulk_events
  WHERE event_type = 'snapshot' GROUP BY run_id
), snapshot_items AS (
  SELECT v, arrayJoin(JSONExtractArrayRaw(state, 'items')) AS item FROM snapshots
), bulk_assessments AS (
  SELECT JSONExtractUInt(item, 'candidate', 'profileId') AS profileId, platform,
      JSONExtractString(item, 'status') = 'completed'
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
    v AS sourceVersion,
    concat('bulk:', toString(v), ':', toString(profileId)) AS assessmentId,
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
  WHERE toString(id) NOT IN (SELECT historyId FROM bulk_assessments WHERE notEmpty(historyId))
    AND notEmpty(${coverageReferenceKeySql("known_profile_url")})
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
  SELECT m.profileId AS profileId, platform,
    (
      lower(JSONExtractString(s.result_json, 'referenceProfile', 'platform')) = lower(platform)
      OR arrayExists(candidate ->
        lower(JSONExtractString(candidate, 'platform')) = lower(platform)
        AND JSONExtractString(candidate, 'jevVerification', 'verdict') = 'verified'
        AND notEmpty(${coverageReferenceKeySql("JSONExtractString(candidate, 'url')")}),
        JSONExtractArrayRaw(s.result_json, 'profiles'))
    ) AS resolved,
    s.searched_at AS assessedAt, toUInt64(0) AS sourceVersion,
    concat('single:', toString(s.id)) AS assessmentId
  FROM saved_singles s INNER JOIN single_matches m ON m.id = s.id
  ARRAY JOIN ['Instagram', 'TikTok', 'YouTube'] AS platform
), platform_assessments AS (
  SELECT profileId, platform, argMax(resolved, tuple(assessedAt, sourceVersion, assessmentId)) AS resolved
  FROM (
    SELECT profileId, platform, resolved, assessedAt, sourceVersion, assessmentId FROM bulk_assessments
    UNION ALL
    SELECT profileId, platform, resolved, assessedAt, sourceVersion, assessmentId FROM single_assessments
  )
  GROUP BY profileId, platform
), assessments AS (
  SELECT profileId, countIf(resolved) = 3 AS resolved FROM platform_assessments
  GROUP BY profileId
), current_profiles AS (
  SELECT id, argMax(tuple(deleted_at, profile_type, profile_types), updated_at) AS data
  FROM new_vertical.profile GROUP BY id
  HAVING tupleElement(data, 1) IS NULL
), memberships AS (
  SELECT id, arrayJoin(arrayDistinct(arrayFilter(
    x -> x IN ('brand', 'creator', 'musician'),
    arrayConcat([tupleElement(data, 2)], tupleElement(data, 3))))) AS sourceType
  FROM current_profiles
), tiers AS (
  SELECT profile, profile_type, tupleElement(argMax(tuple(tier), tuple(computed_at, updated_at)), 1) AS tier
  FROM new_vertical.l_profile_tier
  WHERE grain = 'global' AND profile_type IN ('brand', 'creator', 'musician')
  GROUP BY profile, profile_type
)
SELECT if(m.sourceType = 'musician', 'artist', m.sourceType) AS profileType,
  arrayJoin(arrayConcat(['all'],
    if(t.tier BETWEEN 1 AND 3, ['tiers_1_3'], []),
    if(t.tier BETWEEN 1 AND 5, ['tiers_1_5'], []))) AS group,
  count() AS total, countIf(a.resolved = 1) AS covered
FROM memberships m
LEFT JOIN tiers t ON t.profile = m.id AND t.profile_type = m.sourceType
LEFT JOIN assessments a ON a.profileId = m.id
GROUP BY profileType, group
FORMAT JSON
`;

export function coverageResponse(rows: CoverageRow[], generatedAt = new Date().toISOString()): BulkCoverage {
  return {
    platforms: COVERAGE_PLATFORMS,
    generatedAt,
    types: kinds.map(profileType => ({
      profileType,
      buckets: groups.map(group => {
        const row = rows.find(row => row.profileType === profileType && row.group === group);
        return { group, total: Number(row?.total ?? 0), covered: Number(row?.covered ?? 0) };
      }),
    })),
  };
}

let cached: { expiresAt: number; value: BulkCoverage } | undefined;
let inflight: Promise<BulkCoverage> | undefined;
let revision = 0;
export function invalidateBulkCoverage() {
  revision++;
  cached = undefined;
  inflight = undefined;
}
export function getBulkCoverage(): Promise<BulkCoverage> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (!inflight) {
    const currentRevision = revision;
    const request = clickHouseJson<CoverageRow>(bulkCoverageSql, {}, 60_000).then(rows => {
      const value = coverageResponse(rows.data);
      if (revision === currentRevision) cached = { value, expiresAt: Date.now() + 5 * 60_000 };
      return value;
    }).finally(() => { if (inflight === request) inflight = undefined; });
    inflight = request;
  }
  return inflight;
}
