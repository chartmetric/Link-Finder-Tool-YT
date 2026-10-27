import type { BulkCoverage, BulkProfileType } from "@workspace/api-zod";
import { clickHouseJson } from "./clickhouse-profiles";

export const COVERAGE_PLATFORMS = ["Instagram", "TikTok", "YouTube"];
const kinds: BulkProfileType[] = ["brand", "creator", "artist"];
const groups = ["tiers_1_3", "tiers_1_5", "all"] as const;
type CoverageRow = { profileType: BulkProfileType; group: typeof groups[number]; total: number; covered: number };

/** Latest saved evidence, not the number of runs or URLs. Catalog is read-only.
 * A found/likely outcome alone is deliberately insufficient for strict coverage.
 * Latest snapshots include archives; profile aggregation removes duplicated items. */
export const bulkCoverageSql = `
WITH snapshots AS (
  SELECT argMax(data_json, version) AS state, max(version) AS v
  FROM poc_new_verticals.profile_bulk_events
  WHERE event_type = 'snapshot' GROUP BY run_id
), assessments AS (
  SELECT JSONExtractUInt(item, 'candidate', 'profileId') AS profileId,
    argMax(
      JSONExtractString(item, 'status') = 'completed'
      AND length(JSONExtractArrayRaw(item, 'platforms')) = 3
      AND arrayAll(platform ->
        arrayCount(outcome -> JSONExtractString(outcome, 'platform') = platform
          AND notEmpty(JSONExtractArrayRaw(outcome, 'evidenceUrls'))
          AND (
            JSONExtractString(outcome, 'status') IN ('reference', 'explicit_unavailable')
            OR (JSONExtractString(outcome, 'status') = 'found'
              AND arrayExists(candidate ->
                lower(JSONExtractString(candidate, 'platform')) = lower(platform)
                AND JSONExtractString(candidate, 'jevVerification', 'verdict') = 'verified',
                JSONExtractArrayRaw(item, 'result', 'profiles')))
          ), JSONExtractArrayRaw(item, 'platforms')) = 1,
        ['Instagram', 'TikTok', 'YouTube']),
      tuple(JSONExtractString(item, 'completedAt'), v)
    ) AS resolved
  FROM snapshots ARRAY JOIN JSONExtractArrayRaw(state, 'items') AS item
  WHERE notEmpty(JSONExtractString(item, 'startedAt'))
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
export function getBulkCoverage(): Promise<BulkCoverage> {
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (!inflight) inflight = clickHouseJson<CoverageRow>(bulkCoverageSql, {}, 60_000).then(rows => {
    const value = coverageResponse(rows.data);
    cached = { value, expiresAt: Date.now() + 5 * 60_000 };
    return value;
  }).finally(() => { inflight = undefined; });
  return inflight;
}
