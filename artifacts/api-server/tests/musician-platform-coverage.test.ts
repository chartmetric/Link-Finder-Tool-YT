import test from "node:test";
import assert from "node:assert/strict";
import { youtubeCoverageResponse, youtubeCoverageSql, youtubePilotSql } from "../src/lib/musician-platform-coverage";

test("YouTube categories remain separate and raw candidates are not link coverage", () => {
  const result = youtubeCoverageResponse([{tier: 1, total: 10, catalog: 2, supported: 1,
    candidates: 3, no_match: 1, failed: 1, pending: 1, not_searched: 1}],
  "2026-11-10T01:00:00.000Z", new Date("2026-11-10T03:00:00.000Z"));
  assert.equal(result.platform, "youtube");
  assert.equal(result.tiers[0].catalogUrls + result.tiers[0].supportedResearchUrls, 3);
  assert.equal(result.tiers[0].unresolvedCandidates, 3);
  assert.throws(() => youtubeCoverageResponse([{tier: 1, total: 2, catalog: 3, supported: 0,
    candidates: 0, no_match: 0, failed: 0, pending: 0, not_searched: 0}],
  "2026-11-10T01:00:00.000Z", new Date("2026-11-10T03:00:00.000Z")), /disagree/);
});
test("Missing or stale snapshots never become zero coverage", () => {
  assert.deepEqual(youtubeCoverageResponse([], null).tiers, []);
  assert.equal(youtubeCoverageResponse([], "2026-11-01T01:00:00.000Z", new Date("2026-11-10")).snapshotStatus, "stale");
});
test("Saved evidence is numeric-identity bound and query scoped to a single global tier snapshot", () => {
  assert.throws(() => youtubePilotSql([{profile_id: "1); DROP TABLE x", cm_artist:"2",
    status:"no_match", candidate_count:0, checked_at:new Date()}]), /Invalid/);
  const sql = youtubeCoverageSql([]);
  assert.match(sql, /grain='global'/);
  assert.match(sql, /computed_at=toDateTime/);
  assert.match(sql, /lower\(a.platform\)='youtube'/);
  assert.match(sql, /y.cm_artist=p.cm_source_id/);
  assert.doesNotMatch(sql, /profile_bulk_events/);
  assert.match(sql, /use_pilot AND pilot_status='candidates_found'/);
});
