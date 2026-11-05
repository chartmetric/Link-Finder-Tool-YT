import assert from "node:assert/strict";
import test from "node:test";
import {
  musicianInstagramResearchCoverageResponse,
  musicianInstagramResearchCoverageSql,
} from "../src/lib/musician-instagram-research-coverage";

test("research coverage returns URL and resolved counts for all five tiers", () => {
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
    {
      tier: 4, total_profiles: "400", profiles_with_instagram_urls: "300",
      profiles_with_no_supported_match: "40", profiles_with_url_or_no_supported_match: "340",
    },
    {
      tier: 5, total_profiles: "500", profiles_with_instagram_urls: "350",
      profiles_with_no_supported_match: "50", profiles_with_url_or_no_supported_match: "400",
    },
  ], new Date("2026-11-03T20:00:00.000Z"));

  assert.equal(result.tiers.reduce((sum, row) => sum + row.totalProfiles, 0), 1500);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithInstagramUrls, 0), 1130);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithNoSupportedMatch, 0), 145);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithUrlOrNoSupportedMatch, 0), 1275);
  assert.equal(result.generatedAt, "2026-11-03T20:00:00.000Z");
  assert.deepEqual(result.tiers.map(row => [row.tier, row.totalProfiles, row.profilesWithUrlOrNoSupportedMatch]), [
    [1, 100, 95], [2, 200, 170], [3, 300, 270], [4, 400, 340], [5, 500, 400],
  ]);
});

test("research coverage SQL includes current global tiers, catalog URLs, and latest research outcomes", () => {
  assert.match(musicianInstagramResearchCoverageSql, /computed_at >= toStartOfDay\(now\(\)\)/);
  assert.match(musicianInstagramResearchCoverageSql, /grain = 'global'/);
  assert.match(musicianInstagramResearchCoverageSql, /HAVING assigned_tier IN \(1, 2, 3, 4, 5\)/);
  assert.match(musicianInstagramResearchCoverageSql, /catalog_instagram_profiles/);
  assert.match(musicianInstagramResearchCoverageSql, /lower\(a\.platform\) = 'instagram'/);
  assert.match(musicianInstagramResearchCoverageSql, /argMax\(tuple\(status, instagram_urls\), updated_at\)/);
  assert.match(musicianInstagramResearchCoverageSql, /research_status = 'candidates_found' AND notEmpty\(instagram_urls\)/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url\)/);
  assert.match(musicianInstagramResearchCoverageSql, /research_status = 'no_candidates' AND NOT has_catalog_instagram_url/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url OR no_supported_match\)/);
  assert.match(musicianInstagramResearchCoverageSql, /new_vertical\.l_profile_account/);
});
