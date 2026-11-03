import { test } from "node:test";
import assert from "node:assert/strict";
import { ListBulkCoverageProfilesParams } from "@workspace/api-zod";
import {
  bulkCoverageSql, bulkCoverageProfilesSql, coverageResponse, coverageProfilesResponse,
  COVERAGE_PLATFORMS, COVERAGE_STATES,
} from "../src/lib/bulk-coverage";

test("coverage returns every cohort and bucket even for empty populations", () => {
  const result = coverageResponse([], "2026-10-27T00:00:00Z");
  assert.deepEqual(result.types.map(type => type.profileType), ["brand", "creator", "artist"]);
  for (const type of result.types) {
    assert.equal(type.buckets.length, 3);
    assert.ok(type.buckets.every(bucket => bucket.total === 0 && bucket.covered === 0
      && bucket.investigated === 0 && bucket.uncoveredInvestigated === 0
      && bucket.profilesWithLinksOrFullyResolved === 0
      && bucket.platformBreakdown.length === 3
      && bucket.platformBreakdown.every(p => p.states.length === 6 && p.states.every(s => s.count === 0))));
  }
});

test("coverage preserves real counts without crossing cohorts or tier groups", () => {
  const base = { investigated: 10, uncoveredInvestigated: 7, profilesWithLinksOrFullyResolved: 6, likely_only: 2,
    needs_review: 1, no_match: 1, explicit_absence: 1, provider_failure: 1, unresolved: 1 };
  const result = coverageResponse([
    { ...base, profileType: "brand", group: "all", platform: "TikTok", total: 900, covered: 3 },
    { ...base, profileType: "artist", group: "tiers_1_3", platform: "YouTube", total: 100, covered: 1, profilesWithLinksOrFullyResolved: 4 },
  ]);
  assert.equal(result.types[0].buckets[2].total, 900);
  assert.equal(result.types[0].buckets[2].covered, 3);
  assert.equal(result.types[0].buckets[2].profilesWithLinksOrFullyResolved, 6);
  assert.equal(result.types[0].buckets[2].platformBreakdown[1].states[0].count, 2);
  assert.equal(result.types[0].buckets[2].platformBreakdown[0].states[0].count, 0);
  assert.equal(result.types[1].buckets[2].covered, 0);
  assert.equal(result.types[2].buckets[0].covered, 1);
});

test("strict resolution is evidence-backed, latest-state and read-only", () => {
  assert.match(bulkCoverageSql, /'verdict'\) = 'verified'/);
  assert.match(bulkCoverageSql, /'reference', 'explicit_unavailable'/);
  assert.match(bulkCoverageSql, /argMax\(tuple\(deleted_at, profile_type, profile_types, name\)/);
  assert.match(bulkCoverageSql, /GROUP BY profileId/);
  assert.match(bulkCoverageSql, /outcomeStatus = 'found'/);
  assert.match(bulkCoverageSql, /profilesWithLinksOrFullyResolved/);
  assert.match(bulkCoverageSql, /GROUP BY profileType, `group`, profileId/);
  for (const sql of [bulkCoverageSql, bulkCoverageProfilesSql]) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
  }
  assert.match(bulkCoverageProfilesSql, /investigated = 1 AND resolved = 0/);
  assert.match(bulkCoverageProfilesSql, /profileId > \{afterId:UInt64\}/);
  assert.match(bulkCoverageProfilesSql, /ORDER BY profileId ASC LIMIT \{pageSize:UInt32\}/);
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
