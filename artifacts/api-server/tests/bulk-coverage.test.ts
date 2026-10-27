import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkCoverageSql, coverageResponse } from "../src/lib/bulk-coverage";

test("coverage returns every cohort and bucket even for empty populations", () => {
  const result = coverageResponse([], "2026-10-27T00:00:00Z");
  assert.deepEqual(result.types.map(type => type.profileType), ["brand", "creator", "artist"]);
  for (const type of result.types) {
    assert.equal(type.buckets.length, 3);
    assert.ok(type.buckets.every(bucket => bucket.total === 0 && bucket.covered === 0));
  }
});

test("coverage preserves real counts without crossing cohorts or tier groups", () => {
  const result = coverageResponse([
    { profileType: "brand", group: "all", total: 900, covered: 3 },
    { profileType: "artist", group: "tiers_1_3", total: 100, covered: 1 },
  ]);
  assert.deepEqual(result.types[0].buckets[2], { group: "all", total: 900, covered: 3 });
  assert.equal(result.types[1].buckets[2].covered, 0);
  assert.equal(result.types[2].buckets[0].covered, 1);
});

test("strict resolution is evidence-backed, latest-state and read-only", () => {
  assert.match(bulkCoverageSql, /'verdict'\) = 'verified'/);
  assert.doesNotMatch(bulkCoverageSql, /'likely'|'not_found'/);
  assert.match(bulkCoverageSql, /'reference', 'explicit_unavailable'/);
  assert.match(bulkCoverageSql, /argMax\(tuple\(deleted_at, profile_type, profile_types\)/);
  assert.match(bulkCoverageSql, /GROUP BY profileId/);
  assert.doesNotMatch(bulkCoverageSql, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/);
});
