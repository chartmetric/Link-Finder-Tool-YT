import assert from "node:assert/strict";
import test from "node:test";
import {
  musicianInstagramResearchCoverageResponse,
  musicianInstagramResearchCoverageSql,
} from "../src/lib/musician-instagram-research-coverage";

test("research coverage returns URL and resolved counts for all three tiers", () => {
  const result = musicianInstagramResearchCoverageResponse([
    {
      tier: 1, total_profiles: "100", profiles_with_instagram_urls: "90",
      profiles_with_no_supported_match: "5", profiles_with_url_or_no_supported_match: "95",
    },
    {
      tier: 2, total_profiles: "200", profiles_with_instagram_urls: "150",
      profiles_with_no_supported_match: "20", profiles_with_url_or_no_supported_match: "170",
    },
    {
      tier: 3, total_profiles: "300", profiles_with_instagram_urls: "240",
      profiles_with_no_supported_match: "30", profiles_with_url_or_no_supported_match: "270",
    },
  ], new Date("2026-11-03T20:00:00.000Z"));

  assert.equal(result.tiers.reduce((sum, row) => sum + row.totalProfiles, 0), 600);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithInstagramUrls, 0), 480);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithNoSupportedMatch, 0), 55);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithUrlOrNoSupportedMatch, 0), 535);
  assert.equal(result.generatedAt, "2026-11-03T20:00:00.000Z");
  assert.deepEqual(result.tiers.map(row => [row.tier, row.totalProfiles, row.profilesWithUrlOrNoSupportedMatch]), [
    [1, 100, 95], [2, 200, 170], [3, 300, 270],
  ]);
});

test("research coverage SQL includes active catalog Instagram URLs and latest research outcomes", () => {
  assert.match(musicianInstagramResearchCoverageSql, /computed_at >= toStartOfDay\(now\(\)\)/);
  assert.match(musicianInstagramResearchCoverageSql, /HAVING assigned_tier IN \(1, 2, 3\)/);
  assert.match(musicianInstagramResearchCoverageSql, /argMax\(tuple\(status, instagram_urls\), updated_at\)/);
  assert.match(musicianInstagramResearchCoverageSql, /a\.platform = 'instagram'/);
  assert.match(musicianInstagramResearchCoverageSql, /l\.disconnected_at IS NULL/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url\)/);
  assert.match(musicianInstagramResearchCoverageSql, /status = 'no_candidates'/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url OR no_supported_match\)/);
});
