import { test } from "node:test";
import assert from "node:assert/strict";
import { ListBulkCoverageProfilesParams } from "@workspace/api-zod";
import {
  bulkCoverageSql, bulkCoverageProfilesSql, coverageResponse, coverageProfilesResponse,
  COVERAGE_PLATFORMS, COVERAGE_STATES, coveragePlatformCoveredConditionSql,
  coverageAllPlatformsConditionSql,
} from "../src/lib/bulk-coverage";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";

test("coverage returns every cohort and bucket even for empty populations", () => {
  const result = coverageResponse([], "2026-10-27T00:00:00Z");
  assert.deepEqual(result.types.map(type => type.profileType), ["brand", "creator", "artist"]);
  for (const type of result.types) {
    assert.equal(type.buckets.length, 3);
    assert.ok(type.buckets.every(bucket => bucket.total === 0 && bucket.covered === 0
      && bucket.investigated === 0 && bucket.uncoveredInvestigated === 0
      && bucket.allPlatformsCoveredProfiles === 0
      && bucket.platformBreakdown.length === 3
      && bucket.platformBreakdown.every(p => p.states.length === 6 && p.states.every(s => s.count === 0))));
  }
});

test("coverage preserves real counts without crossing cohorts or tier groups", () => {
  const base = { investigated: 10, uncoveredInvestigated: 7, allPlatformsCoveredProfiles: 6, profilesWithActiveLinks: 8, likely_only: 2,
    needs_review: 1, no_match: 1, explicit_absence: 1, provider_failure: 1, unresolved: 1 };
  const result = coverageResponse([
    { ...base, profileType: "brand", group: "all", platform: "TikTok", total: 900, covered: 3 },
    { ...base, profileType: "artist", group: "tiers_1_3", platform: "YouTube", total: 100, covered: 1, allPlatformsCoveredProfiles: 4, profilesWithActiveLinks: 3 },
  ]);
  assert.equal(result.types[0].buckets[2].total, 900);
  assert.equal(result.types[0].buckets[2].covered, 3);
  assert.equal(result.types[0].buckets[2].allPlatformsCoveredProfiles, 6);
  assert.equal(result.types[0].buckets[2].profilesWithActiveLinks, 8);
  assert.equal(result.types[2].buckets[0].profilesWithActiveLinks, 3);
  assert.equal(result.types[0].buckets[2].platformBreakdown[1].states[0].count, 2);
  assert.equal(result.types[0].buckets[2].platformBreakdown[0].states[0].count, 0);
  assert.equal(result.types[1].buckets[2].covered, 0);
  assert.equal(result.types[2].buckets[0].covered, 1);
});

test("platform coverage is evidence-backed, latest-state and read-only", () => {
  assert.match(bulkCoverageSql, /'verdict'\) = 'verified'/);
  assert.match(bulkCoverageSql, /'reference', 'explicit_unavailable'/);
  assert.match(bulkCoverageSql, /argMax\(tuple\(deleted_at, profile_type, profile_types, name\)/);
  assert.match(bulkCoverageSql, /GROUP BY profileId/);
  assert.match(bulkCoverageSql, /outcomeStatus = 'found'/);
  assert.match(bulkCoverageSql, /allPlatformsCoveredProfiles/);
  assert.match(bulkCoverageSql, /countIf\(platformCovered\) = 3 AS allPlatformsCovered/);
  assert.match(bulkCoverageSql, /outcomeStatus = 'not_found' OR/);
  assert.match(bulkCoverageSql, /uniqExactIf\(profileId, allPlatformsCovered\) AS allPlatformsCoveredProfiles/);
  assert.match(bulkCoverageSql, /GROUP BY profileType, `group`/);
  assert.doesNotMatch(bulkCoverageSql, /countIf\(hasLinks = 1 OR fullyResolved = 1\)/);
  for (const sql of [bulkCoverageSql, bulkCoverageProfilesSql]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
  }
  assert.match(bulkCoverageProfilesSql, /investigated = 1 AND resolved = 0/);
  assert.match(bulkCoverageProfilesSql, /profileId > \{afterId:UInt64\}/);
  assert.match(bulkCoverageProfilesSql, /ORDER BY profileId ASC LIMIT \{pageSize:UInt32\}/);
});

test("ClickHouse counts isolated coverage fixtures once per qualifying profile", {
  skip: process.env.RUN_CLICKHOUSE_COVERAGE_FIXTURE_TEST !== "1",
}, async () => {
  const query = `
    WITH fixture AS (
      SELECT * FROM values(
        'profileId UInt64, platform String, outcomeStatus Nullable(String), itemStatus Nullable(String), evidenceUrls Array(String), candidateUrls Array(String), resolved Nullable(UInt8)',
        (101, 'Instagram', 'found', 'completed', ['https://candidate.example'], ['https://candidate.example', 'https://candidate.example'], 0),
        (101, 'TikTok', 'found', 'completed', ['https://candidate.example'], ['https://candidate.example'], 0),
        (101, 'YouTube', 'found', 'completed', ['https://candidate.example'], ['https://candidate.example'], 0),
        (202, 'Instagram', 'reference', 'completed', ['https://reference.example'], [], 1),
        (202, 'TikTok', 'reference', 'completed', ['https://reference.example'], [], 1),
        (202, 'YouTube', 'reference', 'completed', ['https://reference.example'], [], 1),
        (303, 'Instagram', NULL, NULL, [], [], NULL),
        (303, 'TikTok', NULL, NULL, [], [], NULL),
        (303, 'YouTube', NULL, NULL, [], [], NULL),
        (404, 'Instagram', 'found', 'failed', ['https://failed.example'], ['https://failed.example'], NULL),
        (404, 'TikTok', 'found', 'failed', ['https://failed.example'], ['https://failed.example'], NULL),
        (404, 'YouTube', 'found', 'failed', ['https://failed.example'], ['https://failed.example'], NULL),
        (505, 'Instagram', 'found', 'completed', ['https://partial.example'], ['https://partial.example'], 0),
        (505, 'TikTok', 'found', 'completed', ['https://partial.example'], ['https://partial.example'], 0),
        (505, 'YouTube', NULL, NULL, [], [], NULL),
        (606, 'Instagram', 'not_found', 'completed', [], [], 0),
        (606, 'TikTok', 'not_found', 'completed', [], [], 0),
        (606, 'YouTube', 'not_found', 'completed', [], [], 0)
      )
    ),
    platform_coverage AS (
      SELECT *,
        arrayExists(url -> notEmpty(url), candidateUrls) AS hasCandidateLink,
        ${coveragePlatformCoveredConditionSql} AS platformCovered
      FROM fixture
    ),
    coverage_profile_resolution AS (
      SELECT profileId, ${coverageAllPlatformsConditionSql} AS allPlatformsCovered
      FROM platform_coverage
      GROUP BY profileId
    )
    SELECT
      (SELECT uniqExactIf(profileId, allPlatformsCovered) FROM coverage_profile_resolution) AS allPlatformsCoveredProfiles,
      (SELECT uniqExactIf(profileId, ifNull(resolved = 1, 0)) FROM platform_coverage) AS fullyResolvedProfiles,
      (SELECT uniqExactIf(profileId, hasCandidateLink AND itemStatus = 'completed') FROM platform_coverage) AS completedCandidateProfiles
    FORMAT JSON
  `;
  const result = await clickHouseJson<{
    allPlatformsCoveredProfiles: number;
    fullyResolvedProfiles: number;
    completedCandidateProfiles: number;
  }>(query);
  assert.deepEqual(result.data, [{
    allPlatformsCoveredProfiles: 3,
    fullyResolvedProfiles: 1,
    completedCandidateProfiles: 2,
  }]);
});

test("coverage counts links, completed no-matches, and confirmed absence on every platform", () => {
  const platforms = ["Instagram", "TikTok", "YouTube"] as const;
  const groups = ["all", "tiers_1_3", "tiers_1_5"] as const;
  const profileTypes = ["brand", "creator", "artist"] as const;
  const evidence = profileTypes.flatMap(profileType => [
    { id: `${profileType}-candidate-links`, groups: ["all", "tiers_1_3"], coveredPlatforms: [...platforms] },
    { id: `${profileType}-links-and-absence`, groups: ["all", "tiers_1_5"], coveredPlatforms: [...platforms] },
    { id: `${profileType}-partial`, groups: ["all", "tiers_1_3", "tiers_1_5"], coveredPlatforms: ["Instagram", "TikTok"] },
  ].flatMap(profile => platforms.map(platform => ({
    profileType, groups: profile.groups, profileId: profile.id, platform,
    platformCovered: profile.coveredPlatforms.includes(platform),
  }))));
  const uniqueCount = (profileType: typeof profileTypes[number], group: typeof groups[number]) => {
    const platformsByProfile = new Map<string, Set<string>>();
    for (const row of evidence.filter(row => row.profileType === profileType && row.groups.includes(group) && row.platformCovered)) {
      const seen = platformsByProfile.get(row.profileId) ?? new Set<string>();
      seen.add(row.platform);
      platformsByProfile.set(row.profileId, seen);
    }
    return [...platformsByProfile.values()].filter(seen => seen.size === platforms.length).length;
  };

  for (const profileType of profileTypes) {
    assert.equal(uniqueCount(profileType, "all"), 2);
    assert.equal(uniqueCount(profileType, "tiers_1_3"), 1);
    assert.equal(uniqueCount(profileType, "tiers_1_5"), 1);
  }
  assert.match(bulkCoverageSql, /hasCandidateLink/);
  assert.match(bulkCoverageSql, /outcomeStatus = 'not_found' AND itemStatus = 'completed', 'no_match'/);
  assert.match(bulkCoverageSql, /outcomeStatus IN \('reference', 'explicit_unavailable'\)/);
});

test("multi-classified profiles appear once in each type-specific tier bucket", () => {
  const profiles = [
    { id: 42, profileType: "musician", profileTypes: ["musician", "creator"] },
    { id: 99, profileType: "brand", profileTypes: [] },
  ];
  const tiers = [
    { profile: 42, profileType: "musician", tier: 2 },
    { profile: 42, profileType: "creator", tier: 5 },
    { profile: 99, profileType: "brand", tier: 6 },
  ];
  const validTypes = new Set(["brand", "creator", "musician"]);
  const scoped = profiles.flatMap(profile => [...new Set([profile.profileType, ...profile.profileTypes])]
    .filter(sourceType => validTypes.has(sourceType))
    .flatMap(sourceType => {
      const tier = tiers.find(row => row.profile === profile.id && row.profileType === sourceType)?.tier;
      const profileType = sourceType === "musician" ? "artist" : sourceType;
      return ["all", ...(tier !== undefined && tier <= 3 ? ["tiers_1_3"] : []),
        ...(tier !== undefined && tier <= 5 ? ["tiers_1_5"] : [])]
        .map(group => ({ profileId: profile.id, profileType, group }));
    }));
  const ids = (profileType: string, group: string) => scoped
    .filter(row => row.profileType === profileType && row.group === group)
    .map(row => row.profileId);

  assert.deepEqual(ids("artist", "all"), [42]);
  assert.deepEqual(ids("artist", "tiers_1_3"), [42]);
  assert.deepEqual(ids("artist", "tiers_1_5"), [42]);
  assert.deepEqual(ids("creator", "all"), [42]);
  assert.deepEqual(ids("creator", "tiers_1_3"), []);
  assert.deepEqual(ids("creator", "tiers_1_5"), [42]);
  assert.deepEqual(ids("brand", "all"), [99]);
  assert.deepEqual(ids("brand", "tiers_1_3"), []);
  assert.deepEqual(ids("brand", "tiers_1_5"), []);

  assert.match(bulkCoverageSql, /arrayJoin\(arrayDistinct\(arrayFilter\([\s\S]*arrayConcat\(\[tupleElement\(data, 2\)\], tupleElement\(data, 3\)\)/);
  assert.match(bulkCoverageSql, /LEFT JOIN tiers t ON t\.profile = m\.id AND t\.profile_type = m\.sourceType/);
});

test("coverage bucket validation bounds IDs and page sizes and validates every filter", () => {
  const params = { profileType: "brand", group: "all", platform: "TikTok", state: "no_match", afterId: "0", limit: "25" };
  assert.equal(ListBulkCoverageProfilesParams.parse(params).limit, 25);
  for (const [key, values] of Object.entries({
    profileType: ["musician", "unknown"], group: ["tier_1"], platform: ["web"],
    state: ["absent", "completed"], afterId: ["-1", "1.5", "oops"], limit: ["0", "51", "2.5"],
  })) {
    for (const value of values) assert.equal(ListBulkCoverageProfilesParams.safeParse({ ...params, [key]: value }).success, false);
  }
  assert.deepEqual(COVERAGE_PLATFORMS, ["Instagram", "TikTok", "YouTube"]);
  assert.ok(COVERAGE_STATES.includes("no_match") && COVERAGE_STATES.includes("explicit_absence"));
});

test("coverage pages use a look-ahead row without returning it and keep empty cursor stable", () => {
  const profile = { profileName: "Fixture", tier: null, platform: "TikTok", state: "no_match" as const,
    reason: "No supported match, not absence", evidenceUrls: [], checkedAt: "", sourceRunId: "fixture", referenceUrl: "" };
  const page = coverageProfilesResponse([1, 3, 8].map(profileId => ({ ...profile, profileId })), 0, 2);
  assert.deepEqual(page.profiles.map(p => p.profileId), [1, 3]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextAfterId, 3);
  const end = coverageProfilesResponse([], 8, 2);
  assert.equal(end.nextAfterId, 8);
  assert.equal(end.hasMore, false);
});
