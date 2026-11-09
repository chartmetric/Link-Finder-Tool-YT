import assert from "node:assert/strict";
import test from "node:test";
import {
  musicianInstagramResearchCoverageResponse,
  musicianInstagramResearchCoverageSql,
  musicianInstagramResearchHistorySql,
} from "../src/lib/musician-instagram-research-coverage";

test("research coverage returns URL and resolved counts for all five tiers", () => {
  const result = musicianInstagramResearchCoverageResponse([
    {
      tier: 1, total_profiles: "100", profiles_with_instagram_urls: "90",
      processed_profiles: "60", profiles_with_research_urls: "55",
      profiles_with_no_supported_match: "5", profiles_with_url_or_no_supported_match: "95",
      completed_no_candidate_profiles: "5", failed_profiles: "3", pending_profiles: "2",
    },
    {
      tier: 2, total_profiles: "200", profiles_with_instagram_urls: "150",
      processed_profiles: "125", profiles_with_research_urls: "110",
      profiles_with_no_supported_match: "20", profiles_with_url_or_no_supported_match: "170",
      completed_no_candidate_profiles: "15", failed_profiles: "4", pending_profiles: "3",
    },
    {
      tier: 3, total_profiles: "300", profiles_with_instagram_urls: "240",
      processed_profiles: "210", profiles_with_research_urls: "190",
      profiles_with_no_supported_match: "30", profiles_with_url_or_no_supported_match: "270",
      completed_no_candidate_profiles: "20", failed_profiles: "6", pending_profiles: "4",
    },
    {
      tier: 4, total_profiles: "400", profiles_with_instagram_urls: "300",
      processed_profiles: "300", profiles_with_research_urls: "280",
      profiles_with_no_supported_match: "40", profiles_with_url_or_no_supported_match: "340",
      completed_no_candidate_profiles: "20", failed_profiles: "10", pending_profiles: "5",
    },
    {
      tier: 5, total_profiles: "500", profiles_with_instagram_urls: "350",
      processed_profiles: "400", profiles_with_research_urls: "350",
      profiles_with_no_supported_match: "50", profiles_with_url_or_no_supported_match: "400",
      completed_no_candidate_profiles: "50", failed_profiles: "15", pending_profiles: "10",
    },
  ], [], new Date("2026-11-03T20:00:00.000Z"));

  assert.equal(result.tiers.reduce((sum, row) => sum + row.totalProfiles, 0), 1500);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithInstagramUrls, 0), 1130);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithNoSupportedMatch, 0), 145);
  assert.equal(result.tiers.reduce((sum, row) => sum + row.profilesWithUrlOrNoSupportedMatch, 0), 1275);
  assert.equal(result.tiers.slice(0, 3).reduce((sum, row) => sum + row.processedProfiles, 0), 395);
  assert.equal(result.tiers.slice(0, 3).reduce((sum, row) => sum + row.profilesWithResearchUrls, 0), 355);
  assert.equal(result.tiers.slice(0, 3).reduce((sum, row) => sum + row.completedNoCandidateProfiles, 0), 40);
  assert.equal(result.tiers.slice(0, 3).reduce((sum, row) => sum + row.failedProfiles, 0), 13);
  assert.equal(result.tiers.slice(0, 3).reduce((sum, row) => sum + row.pendingProfiles, 0), 9);
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

test("research history separates attempts from unique profiles and cumulative profile coverage", () => {
  const result = musicianInstagramResearchCoverageResponse([], [
    {
      date: "2026-11-01",
      unique_profiles: "3",
      cumulative_unique_profiles: "7",
      attempts: "5",
      candidate_profiles: "1",
      candidate_attempts: "2",
      candidate_urls: "3",
      no_candidate_profiles: "1",
      no_candidate_attempts: "1",
      failed_profiles: "2",
      failed_attempts: "2",
      in_progress_attempts: "0",
    },
    {
      date: "2026-11-02",
      unique_profiles: "2",
      cumulative_unique_profiles: "8",
      attempts: "4",
      candidate_profiles: "1",
      candidate_attempts: "1",
      candidate_urls: "2",
      no_candidate_profiles: "1",
      no_candidate_attempts: "2",
      failed_profiles: "0",
      failed_attempts: "0",
      in_progress_attempts: "1",
    },
  ]);

  assert.deepEqual(result.history.map(day => [
    day.date, day.uniqueProfiles, day.cumulativeUniqueProfiles, day.attempts,
    day.candidateProfiles, day.candidateAttempts, day.candidateUrls, day.noCandidateProfiles,
    day.noCandidateAttempts, day.failedProfiles, day.failedAttempts, day.inProgressAttempts,
  ]), [
    ["2026-11-01", 3, 7, 5, 1, 2, 3, 1, 1, 2, 2, 0],
    ["2026-11-02", 2, 8, 4, 1, 1, 2, 1, 2, 0, 0, 1],
  ]);
});

test("research history SQL deduplicates started run/profile attempts and tracks cumulative unique profiles", () => {
  assert.match(musicianInstagramResearchHistorySql, /GROUP BY e\.profile_id, e\.run_id/);
  assert.match(musicianInstagramResearchHistorySql, /grain = 'global'/);
  assert.match(musicianInstagramResearchHistorySql, /HAVING started_events > 0/);
  assert.match(musicianInstagramResearchHistorySql, /tupleElement\(outcome, 1\) != 'queued'/);
  assert.match(musicianInstagramResearchHistorySql, /uniqExact\(profile_id\) AS unique_profiles/);
  assert.match(musicianInstagramResearchHistorySql, /min\(day\) AS first_day/);
  assert.match(musicianInstagramResearchHistorySql, /cumulative_unique_profiles/);
  assert.match(musicianInstagramResearchHistorySql, /sumIf\(length\(instagram_urls\)/);
  assert.match(musicianInstagramResearchHistorySql, /d\.candidate_urls/);
  assert.match(musicianInstagramResearchHistorySql, /LIMIT 90/);
});
