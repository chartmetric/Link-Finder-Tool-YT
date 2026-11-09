import assert from "node:assert/strict";
import test from "node:test";
import { GetMusicianInstagramResearchCoverageResponse } from "@workspace/api-zod";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";
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
      profiles_with_catalog_instagram_urls: "35", profiles_with_research_candidates: "55",
      profiles_with_failed_or_incomplete_searches: "5",
    },
    {
      tier: 2, total_profiles: "200", profiles_with_instagram_urls: "150",
      processed_profiles: "125", profiles_with_research_urls: "110",
      profiles_with_no_supported_match: "20", profiles_with_url_or_no_supported_match: "170",
      completed_no_candidate_profiles: "15", failed_profiles: "4", pending_profiles: "3",
      profiles_with_catalog_instagram_urls: "40", profiles_with_research_candidates: "110",
      profiles_with_failed_or_incomplete_searches: "30",
    },
    {
      tier: 3, total_profiles: "300", profiles_with_instagram_urls: "240",
      processed_profiles: "210", profiles_with_research_urls: "190",
      profiles_with_no_supported_match: "30", profiles_with_url_or_no_supported_match: "270",
      completed_no_candidate_profiles: "20", failed_profiles: "6", pending_profiles: "4",
      profiles_with_catalog_instagram_urls: "50", profiles_with_research_candidates: "190",
      profiles_with_failed_or_incomplete_searches: "30",
    },
    {
      tier: 4, total_profiles: "400", profiles_with_instagram_urls: "300",
      processed_profiles: "300", profiles_with_research_urls: "280",
      profiles_with_no_supported_match: "40", profiles_with_url_or_no_supported_match: "340",
      completed_no_candidate_profiles: "20", failed_profiles: "10", pending_profiles: "5",
      profiles_with_catalog_instagram_urls: "20", profiles_with_research_candidates: "280",
      profiles_with_failed_or_incomplete_searches: "60",
    },
    {
      tier: 5, total_profiles: "500", profiles_with_instagram_urls: "350",
      processed_profiles: "400", profiles_with_research_urls: "350",
      profiles_with_no_supported_match: "50", profiles_with_url_or_no_supported_match: "400",
      completed_no_candidate_profiles: "50", failed_profiles: "15", pending_profiles: "10",
      profiles_with_catalog_instagram_urls: "0", profiles_with_research_candidates: "350",
      profiles_with_failed_or_incomplete_searches: "100",
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
  assert.deepEqual(JSON.parse(JSON.stringify(GetMusicianInstagramResearchCoverageResponse.parse(result))), result);
  assert.equal(result.tiers[3].profilesWithCatalogInstagramUrls, 20);
  assert.equal(result.tiers[3].profilesWithResearchCandidates, 280);
  assert.equal(result.tiers[3].profilesWithFailedOrIncompleteSearches, 60);
});

test("research coverage preserves empty tiers including tier 4", () => {
  const result = musicianInstagramResearchCoverageResponse([]);
  assert.deepEqual(result.tiers.map(row => row.tier), [1, 2, 3, 4, 5]);
  assert.equal(result.tiers[3].totalProfiles, 0);
  assert.equal(result.tiers[3].profilesWithFailedOrIncompleteSearches, 0);
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
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_catalog_instagram_url\) AS profiles_with_catalog_instagram_urls/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(NOT has_instagram_url AND NOT no_supported_match\)/);
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

// Read-only SQL check: all catalog and research sources are inline fixtures.
test("coverage SQL retains Tier 4 outcomes without inferring links from missing research", {
  skip: process.env.RUN_COVERAGE_SQL_TESTS !== "1",
}, async () => {
  const tiers = [1, 2, 3, 4, 5];
  const rows = tiers.flatMap(tier => Array.from({ length: 10 }, (_, offset) => ({
    profile: tier * 100 + offset, tier, profile_type: "musician", grain: "global",
    computed_at: "2026-11-04 10:00:00", updated_at: "2026-11-04 10:00:00",
  })));
  rows.push({ ...rows[30], tier: 1, computed_at: "2026-11-03 10:00:00" });
  rows.push({ ...rows[30], tier: 1, grain: "country" });
  const events = tiers.flatMap(tier =>
    ["candidates_found", "no_candidates", "failed", "queued", "running", "needs_review", "candidates_found", ""].map((status, offset) => ({
      profile_id: tier * 100 + offset + 1, status,
      instagram_urls: offset === 0 ? ["https://instagram.com/candidate"] : [],
      updated_at: "2026-11-04 12:00:00",
    })));
  events.push({ profile_id: 403, status: "no_candidates", instagram_urls: [], updated_at: "2026-11-04 11:00:00" });
  const links = tiers.flatMap(tier => [
    { profile_id: tier * 100, account_id: tier * 100, disconnected_at: null },
    { profile_id: tier * 100, account_id: tier * 100, disconnected_at: null },
    { profile_id: tier * 100 + 9, account_id: tier * 100, disconnected_at: "2026-11-03 00:00:00" },
  ]);
  const accounts = tiers.map(tier => ({ id: tier * 100, platform: "instagram", account_url: "https://instagram.com/catalog" }));
  const fixture = (structure: string, data: unknown[]) =>
    `format(JSONEachRow, '${structure}', '${data.map(row => JSON.stringify(row)).join("\n").replaceAll("\\", "\\\\").replaceAll("'", "\\'")}')`;
  const sql = musicianInstagramResearchCoverageSql
    .replace("new_vertical.l_profile_tier FINAL", fixture("profile UInt64, tier UInt8, profile_type String, grain String, computed_at DateTime, updated_at DateTime", rows))
    .replace("poc_new_verticals.musician_instagram_discovery_events", fixture("profile_id UInt64, status String, instagram_urls Array(String), updated_at DateTime", events))
    .replace("new_vertical.l_profile_account l", `${fixture("profile_id UInt64, account_id UInt64, disconnected_at Nullable(DateTime)", links)} l`)
    .replace("new_vertical.account a", `${fixture("id UInt64, platform String, account_url String", accounts)} a`)
    .replace("toStartOfDay(now())", "toDateTime('2026-11-04 00:00:00')");
  const response = await clickHouseJson<Parameters<typeof musicianInstagramResearchCoverageResponse>[0][number]>(sql);
  const result = musicianInstagramResearchCoverageResponse(response.data);
  for (const row of result.tiers) {
    assert.equal(row.totalProfiles, 10);
    assert.equal(row.profilesWithCatalogInstagramUrls, 1);
    assert.equal(row.profilesWithResearchCandidates, 1);
    assert.equal(row.profilesWithInstagramUrls, 2);
    assert.equal(row.profilesWithNoSupportedMatch, 1);
    assert.equal(row.profilesWithUrlOrNoSupportedMatch, 3);
    assert.equal(row.profilesWithFailedOrIncompleteSearches, 7);
    assert.equal(row.failedProfiles, 1);
    assert.equal(row.pendingProfiles, 2);
  }
});
