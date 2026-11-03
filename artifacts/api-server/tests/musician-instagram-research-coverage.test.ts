import assert from "node:assert/strict";
import test from "node:test";
import {
  musicianInstagramResearchCoverageResponse,
  musicianInstagramResearchCoverageSql,
} from "../src/lib/musician-instagram-research-coverage";

test("research coverage returns all three tiers and sums their profile counts", () => {
  const result = musicianInstagramResearchCoverageResponse([
    {
      tier: 1, total_profiles: "1113", processed_profiles: "11",
      profiles_with_instagram_urls: "11", completed_no_candidate_profiles: "0",
      failed_profiles: "0", pending_profiles: "0",
    },
    {
      tier: 2, total_profiles: "8933", processed_profiles: "2999",
      profiles_with_instagram_urls: "2884", completed_no_candidate_profiles: "115",
      failed_profiles: "0", pending_profiles: "0",
    },
    {
      tier: 3, total_profiles: "17596", processed_profiles: "10331",
      profiles_with_instagram_urls: "10010", completed_no_candidate_profiles: "321",
      failed_profiles: "0", pending_profiles: "0",
    },
  ], new Date("2026-11-03T20:00:00.000Z"));

  assert.equal(result.totalProfiles, 27642);
  assert.equal(result.processedProfiles, 13341);
  assert.equal(result.profilesWithInstagramUrls, 12905);
  assert.equal(result.completedNoCandidateProfiles, 436);
  assert.equal(result.generatedAt, "2026-11-03T20:00:00.000Z");
  assert.deepEqual(result.tiers.map(row => [row.tier, row.processedProfiles, row.profilesWithInstagramUrls]), [
    [1, 11, 11], [2, 2999, 2884], [3, 10331, 10010],
  ]);
});

test("research coverage SQL uses fresh Tier 1–3 assignments and each profile's latest result", () => {
  assert.match(musicianInstagramResearchCoverageSql, /computed_at >= toStartOfDay\(now\(\)\)/);
  assert.match(musicianInstagramResearchCoverageSql, /HAVING assigned_tier IN \(1, 2, 3\)/);
  assert.match(musicianInstagramResearchCoverageSql, /argMax\(tuple\(status, instagram_urls\), updated_at\)/);
  assert.match(musicianInstagramResearchCoverageSql, /status IN \('candidates_found', 'no_candidates'\)/);
  assert.match(musicianInstagramResearchCoverageSql, /status = 'no_candidates'/);
});
