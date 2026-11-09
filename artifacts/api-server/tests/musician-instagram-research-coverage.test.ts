import assert from "node:assert/strict";
import test from "node:test";
import { GetMusicianInstagramResearchCoverageResponse } from "@workspace/api-zod";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";
import {
  musicianInstagramResearchCoverageResponse,
  musicianInstagramResearchCoverageSql,
  musicianInstagramResearchHistorySql,
  musicianTierSnapshotSql,
  musicianTierSnapshotStatus,
  createMusicianInstagramResearchCoverage,
  musicianInstagramResearchNoCandidatesResponse,
  musicianInstagramResearchNoCandidatesSql,
} from "../src/lib/musician-instagram-research-coverage";

test("no-candidate export preserves the current profile identity and latest outcome timestamp", () => {
  const result = musicianInstagramResearchNoCandidatesResponse([
    {
      profile_id: "9007199254740993",
      cm_artist: "12345",
      artist: "Artist One",
      chartmetric_url: "https://app.chartmetric.com/artist/12345",
      outcome: "completed_no_candidate",
      last_search_at: "2026-11-03 20:00:00",
    },
    {
      profile_id: "44",
      cm_artist: "55",
      artist: "Artist Two",
      chartmetric_url: "https://app.chartmetric.com/artist/55",
      outcome: "failed",
      last_search_at: "2026-11-03 20:01:00",
    },
    {
      profile_id: "66",
      cm_artist: "77",
      artist: "Artist Three",
      chartmetric_url: "https://app.chartmetric.com/artist/77",
      outcome: "incomplete",
      last_search_at: "2026-11-03 20:02:00",
    },
    {
      profile_id: "88",
      cm_artist: "99",
      artist: "Artist Four",
      chartmetric_url: "https://app.chartmetric.com/artist/99",
      outcome: "not_searched",
      last_search_at: "",
    },
  ], new Date("2026-11-03T20:03:00.000Z"));

  assert.equal(result.generatedAt, "2026-11-03T20:03:00.000Z");
  assert.deepEqual(result.profiles.map(profile => [
    profile.profileId, profile.cmArtist, profile.artist, profile.outcome, profile.lastSearchAt,
  ]), [
    ["9007199254740993", "12345", "Artist One", "completed_no_candidate", "2026-11-03 20:00:00"],
    ["44", "55", "Artist Two", "failed", "2026-11-03 20:01:00"],
    ["66", "77", "Artist Three", "incomplete", "2026-11-03 20:02:00"],
    ["88", "99", "Artist Four", "not_searched", null],
  ]);
});

test("no-candidate export SQL uses latest global tiers and latest saved no-URL outcomes", () => {
  assert.match(musicianInstagramResearchNoCandidatesSql, /profile_type = 'musician' AND grain = 'global'/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /argMax\(tier, tuple\(computed_at, updated_at\)\)/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /HAVING assigned_tier IN \(1, 2, 3\)/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /argMax\(tuple\(toString\(cm_artist\), status, instagram_urls, updated_at\), updated_at\)/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /empty\(tupleElement\(l\.latest, 3\)\)/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /new_vertical\.l_profile_account/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /'completed_no_candidate'/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /'failed'/);
  assert.match(musicianInstagramResearchNoCandidatesSql, /'incomplete'/);
});

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
  ].map(row => ({
    ...row,
    profiles_with_supported_research_urls: Number(row.profiles_with_instagram_urls) - Number(row.profiles_with_catalog_instagram_urls),
    profiles_with_unresolved_candidates: "3",
  })), "2026-11-03T04:00:00.000Z", new Date("2026-11-03T20:00:00.000Z"));

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
  assert.equal(result.snapshotAt, "2026-11-03T04:00:00.000Z");
  assert.equal(result.snapshotStatus, "current");
  for (const tier of result.tiers) {
    assert.equal(tier.profilesWithCatalogInstagramUrls + tier.profilesWithSupportedResearchUrls, tier.profilesWithInstagramUrls);
    assert.equal(tier.profilesWithUnresolvedCandidates, 3);
  }
  assert.deepEqual(result.tiers.map(row => [row.tier, row.totalProfiles, row.profilesWithUrlOrNoSupportedMatch]), [
    [1, 100, 95], [2, 200, 170], [3, 300, 270], [4, 400, 340], [5, 500, 400],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(GetMusicianInstagramResearchCoverageResponse.parse(result))), result);
  assert.equal(result.tiers[3].profilesWithCatalogInstagramUrls, 20);
  assert.equal(result.tiers[3].profilesWithResearchCandidates, 280);
  assert.equal(result.tiers[3].profilesWithFailedOrIncompleteSearches, 60);
});

test("research coverage preserves empty tiers including tier 4", () => {
  const result = musicianInstagramResearchCoverageResponse([], "2026-11-03T04:00:00.000Z", new Date("2026-11-03T20:00:00Z"));
  assert.deepEqual(result.tiers.map(row => row.tier), [1, 2, 3, 4, 5]);
  assert.equal(result.tiers[3].totalProfiles, 0);
  assert.equal(result.tiers[3].profilesWithFailedOrIncompleteSearches, 0);
});

test("research coverage SQL includes pinned global tiers, catalog URLs, and latest research outcomes", () => {
  assert.match(musicianInstagramResearchCoverageSql, /computed_at = toDateTime\(\{snapshotAt:String\}, 'UTC'\)/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_catalog_instagram_url\) AS profiles_with_catalog_instagram_urls/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(NOT has_instagram_url AND NOT no_supported_match AND NOT unresolved_candidates\)/);
  assert.match(musicianInstagramResearchCoverageSql, /grain = 'global'/);
  assert.match(musicianInstagramResearchCoverageSql, /HAVING assigned_tier IN \(1, 2, 3, 4, 5\)/);
  assert.match(musicianInstagramResearchCoverageSql, /catalog_instagram_profiles/);
  assert.match(musicianInstagramResearchCoverageSql, /lower\(a\.platform\) = 'instagram'/);
  assert.match(musicianInstagramResearchCoverageSql, /argMax\(tuple\(status, instagram_urls, result_json\), updated_at\)/);
  assert.match(musicianInstagramResearchCoverageSql, /'candidateMatching', 'policy'\) = 'catalog-reference-identity-v1'/);
  assert.match(musicianInstagramResearchCoverageSql, /'candidateMatching', 'status'\) = 'candidates_found'/);
  assert.match(musicianInstagramResearchCoverageSql, /'candidateMatching', 'urls', 'Array\(String\)'/);
  assert.match(musicianInstagramResearchCoverageSql, /NOT has_catalog_instagram_url AND NOT has_supported_research_url/);
  assert.match(musicianInstagramResearchCoverageSql, /research_status IN \('candidates_found', 'needs_review'\)/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url\)/);
  assert.match(musicianInstagramResearchCoverageSql, /research_status = 'no_candidates' AND NOT has_catalog_instagram_url/);
  assert.match(musicianInstagramResearchCoverageSql, /countIf\(has_instagram_url OR no_supported_match\)/);
  assert.match(musicianInstagramResearchCoverageSql, /new_vertical\.l_profile_account/);
});

test("missing tiers are zero-filled without inventing evidence", () => {
  const response = musicianInstagramResearchCoverageResponse([], "2026-11-03T04:00:00.000Z", new Date("2026-11-03T20:00:00Z"));
  assert.equal(response.tiers.length, 5);
  for (const tier of response.tiers) {
    assert.equal(tier.totalProfiles, 0);
    assert.equal(tier.profilesWithInstagramUrls, 0);
    assert.equal(tier.profilesWithCatalogInstagramUrls, 0);
    assert.equal(tier.profilesWithSupportedResearchUrls, 0);
    assert.equal(tier.profilesWithUnresolvedCandidates, 0);
  }
});

const literal = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
test("research coverage pins one global snapshot without historical tier mixing", () => {
  assert.match(musicianTierSnapshotSql, /maxOrNull\(computed_at\)/);
  assert.doesNotMatch(musicianTierSnapshotSql, /tier IN|toStartOfDay/);
  for (const sql of [musicianTierSnapshotSql, musicianInstagramResearchCoverageSql, musicianInstagramResearchHistorySql]) {
    assert.match(sql, /profile_type = 'musician' AND grain = 'global'/);
  }
  for (const sql of [musicianInstagramResearchCoverageSql, musicianInstagramResearchHistorySql]) {
    assert.match(sql, /computed_at = toDateTime\(\{snapshotAt:String\}, 'UTC'\)/);
    assert.doesNotMatch(sql, /computed_at >=|toStartOfDay/);
  }
  assert.doesNotMatch(musicianInstagramResearchCoverageSql, /research_status = ''/);
});

test("research history separates attempts from unique profiles and cumulative profile coverage", () => {
  const result = musicianInstagramResearchCoverageResponse([], "2026-11-03T04:00:00.000Z", new Date("2026-11-03T20:00:00Z"), [
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
      result_json: offset === 0 ? JSON.stringify({ candidateMatching: {
        policy: "catalog-reference-identity-v1", status: "candidates_found", urls: ["https://instagram.com/candidate"],
      } }) : "{}",
      updated_at: "2026-11-04 12:00:00",
    })));
  events.push({ profile_id: 403, status: "no_candidates", instagram_urls: [], result_json: "{}", updated_at: "2026-11-04 11:00:00" });
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
    .replace("poc_new_verticals.musician_instagram_discovery_events", fixture("profile_id UInt64, status String, instagram_urls Array(String), result_json String, updated_at DateTime", events))
    .replace("new_vertical.l_profile_account l", `${fixture("profile_id UInt64, account_id UInt64, disconnected_at Nullable(DateTime)", links)} l`)
    .replace("new_vertical.account a", `${fixture("id UInt64, platform String, account_url String", accounts)} a`);
  const response = await clickHouseJson<Parameters<typeof musicianInstagramResearchCoverageResponse>[0][number]>(sql, { snapshotAt: "2026-11-04 10:00:00" });
  const result = musicianInstagramResearchCoverageResponse(response.data, "2026-11-04T10:00:00.000Z", new Date("2026-11-04T12:00:00Z"));
  for (const row of result.tiers) {
    assert.equal(row.totalProfiles, 10);
    assert.equal(row.profilesWithCatalogInstagramUrls, 1);
    assert.equal(row.profilesWithResearchCandidates, 1);
    assert.equal(row.profilesWithInstagramUrls, 2);
    assert.equal(row.profilesWithNoSupportedMatch, 1);
    assert.equal(row.profilesWithUrlOrNoSupportedMatch, 3);
    assert.equal(row.profilesWithUnresolvedCandidates, 2);
    assert.equal(row.profilesWithSupportedResearchUrls, 1);
    assert.equal(row.profilesWithFailedOrIncompleteSearches, 5);
    assert.equal(row.failedProfiles, 1);
    assert.equal(row.pendingProfiles, 2);
  }
});

const counts = [{
  tier: 1, total_profiles: "100", profiles_with_instagram_urls: "90",
  profiles_with_no_supported_match: "5", profiles_with_url_or_no_supported_match: "95",
}];
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let time = new Date("2026-11-03T23:59:00Z");
  let snapshot: string | null = "2026-11-03 04:00:00";
  let fail = false;
  const pinned: string[] = [];
  const historyPinned: string[] = [];
  const read: typeof clickHouseJson = async <T>(sql: string, params?: Record<string, string>) => {
    if (fail) throw new Error("read failed");
    if (sql === musicianTierSnapshotSql) return { data: [{ snapshot_at: snapshot }] as T[] };
    if (sql === musicianInstagramResearchHistorySql) {
      historyPinned.push(params!.snapshotAt);
      return { data: [{
        date: "2026-11-03", unique_profiles: "1", cumulative_unique_profiles: "1",
        attempts: "1", candidate_profiles: "1", candidate_attempts: "1", candidate_urls: "1",
        no_candidate_profiles: "0", no_candidate_attempts: "0", failed_profiles: "0",
        failed_attempts: "0", in_progress_attempts: "0",
      }] as T[] };
    }
    assert.equal(sql, musicianInstagramResearchCoverageSql);
    pinned.push(params!.snapshotAt);
    return { data: counts as T[] };
  };
  return {
    get: createMusicianInstagramResearchCoverage(read, () => time, () => {}),
    at: (value: string) => { time = new Date(value); },
    snapshot: (value: string | null) => { snapshot = value; },
    fail: () => { fail = true; },
    pinned,
    historyPinned,
  };
}

test("UTC midnight retains one recent snapshot without changing counts or mixing tier history", async () => {
  const f = fixture();
  const before = await f.get();
  f.at("2026-11-04T00:01:00Z");
  const after = await f.get();
  assert.equal(before.snapshotStatus, "current");
  assert.equal(after.snapshotStatus, "recent");
  assert.equal(after.snapshotAt, "2026-11-03T04:00:00.000Z");
  assert.deepEqual(before.tiers, after.tiers);
  assert.deepEqual(before.history, after.history);
  assert.equal(after.history[0].attempts, 1);
  assert.deepEqual(f.pinned, ["2026-11-03 04:00:00"]);
  assert.deepEqual(f.historyPinned, f.pinned);
});

test("a newly arrived snapshot replaces the pinned snapshot on cache refresh", async () => {
  const f = fixture();
  await f.get();
  f.at("2026-11-04T04:01:00Z");
  f.snapshot("2026-11-04 04:00:00");
  await f.get(); // Read-only cache serves the last success during refresh.
  await flush();
  const updated = await f.get();
  assert.equal(updated.snapshotStatus, "current");
  assert.equal(updated.snapshotAt, "2026-11-04T04:00:00.000Z");
  assert.deepEqual(f.pinned, ["2026-11-03 04:00:00", "2026-11-04 04:00:00"]);
  assert.deepEqual(f.historyPinned, f.pinned);
});

test("36-hour age limit is inclusive and independent of UTC day boundaries", () => {
  const at = "2026-11-03T04:00:00.000Z";
  assert.equal(musicianTierSnapshotStatus(at, new Date("2026-11-04T16:00:00Z")), "recent");
  assert.equal(musicianTierSnapshotStatus(at, new Date("2026-11-04T16:00:00.001Z")), "stale");
  assert.equal(musicianTierSnapshotStatus(at, new Date("2026-11-03T03:59:59Z")), "unavailable");
  assert.equal(musicianTierSnapshotStatus(null), "unavailable");
  assert.equal(musicianTierSnapshotStatus("invalid"), "unavailable");
});

test("old or missing snapshots are unavailable, not zero coverage; no counts query is run", async () => {
  for (const snapshot of ["2026-11-01 04:00:00", null]) {
    const f = fixture();
    f.snapshot(snapshot);
    const result = await f.get();
    assert.equal(result.snapshotStatus, snapshot ? "stale" : "unavailable");
    assert.deepEqual(result.tiers, []);
    assert.deepEqual(result.history, []);
    assert.deepEqual(f.pinned, []);
    assert.deepEqual(f.historyPinned, []);
  }
});

test("failed refresh cannot keep serving counts after their tier snapshot exceeds 36 hours", async () => {
  const f = fixture();
  await f.get();
  f.fail();
  f.at("2026-11-04T15:59:00Z");
  assert.equal((await f.get()).snapshotStatus, "recent");
  await flush();
  f.at("2026-11-04T16:00:00.001Z");
  const result = await f.get();
  assert.equal(result.snapshotStatus, "stale");
  assert.deepEqual(result.tiers, []);
  assert.deepEqual(result.history, []);
  assert.equal(result.snapshotAt, "2026-11-03T04:00:00.000Z");
});

test("a stale cached snapshot recovers when a recent snapshot arrives", async () => {
  const f = fixture();
  f.snapshot("2026-11-01 04:00:00");
  assert.equal((await f.get()).snapshotStatus, "stale");
  f.at("2026-11-04T00:05:00Z");
  f.snapshot("2026-11-03 04:00:00");
  await f.get();
  await flush();
  const result = await f.get();
  assert.equal(result.snapshotStatus, "recent");
  assert.equal(result.tiers[0].totalProfiles, 100);
});
const url = "https://www.instagram.com/artist/";
const supported = JSON.stringify({
  candidateMatching: { policy: "catalog-reference-identity-v1", status: "candidates_found", urls: [url] },
});

// Execute the production SELECT against in-query tables only: no stored results,
// catalog links, claims, or provider APIs are written or reinterpreted.
test("legacy candidates_found rows stay unresolved; supported and catalog URLs count once", {
  skip: process.env.TEST_CLICKHOUSE_COVERAGE !== "1",
}, async () => {
  const event = (id: number, status: string, json = "{}", urls = [url], day = 2) =>
    `SELECT toUInt64(${id}) AS profile_id, ${literal(status)} AS status,
      [${urls.map(literal).join(",")}]::Array(String) AS instagram_urls, ${literal(json)} AS result_json,
      toDateTime('2026-11-0${day}') AS updated_at`;
  const events = [
    event(1, "candidates_found"), // historical raw search hit
    event(2, "candidates_found", supported),
    event(3, "no_candidates", "{}", []),
    event(4, "failed"),
    event(5, "needs_review", "{}", []),
    event(6, "candidates_found"),
    event(7, "candidates_found", supported), // catalog overlap
    event(8, "candidates_found", JSON.stringify({ candidateMatching: { policy: "catalog-reference-identity-v1" } })),
    event(9, "candidates_found", "{invalid"),
    event(10, "candidates_found", supported, [url], 1),
    event(10, "candidates_found"), // latest unsupported supersedes support
    event(11, "candidates_found", "{}", [url], 1),
    event(11, "candidates_found", supported),
    event(12, "candidates_found", supported, [" "]),
    event(13, "candidates_found", supported.replace("catalog-reference-identity-v1", "other-policy")),
    event(14, "queued"),
    // 15 has no lookup at all
    event(16, "no_candidates", "{}", []), // catalog takes priority
  ];
  const tier = (id: number, value: number) =>
    `SELECT toUInt64(${id}) AS profile, ${value} AS tier, 'musician' AS profile_type,
      'global' AS grain, toDateTime('2026-11-03 04:00:00') AS computed_at, computed_at AS updated_at`;
  const tierRows = Array.from({ length: 16 }, (_, i) => tier(i + 1, 1));
  // Repeated tier and event rows must not multiply profile counts.
  tierRows.push(tier(1, 1));
  events.push(event(1, "candidates_found"));
  for (const value of [2, 3, 4, 5]) {
    tierRows.push(tier(value * 100, value), tier(value * 100 + 1, value));
    events.push(event(value * 100, "candidates_found"), event(value * 100 + 1, "candidates_found", supported));
  }
  const sql = musicianInstagramResearchCoverageSql
    .replace("new_vertical.l_profile_tier FINAL", `(${tierRows.join(" UNION ALL ")})`)
    .replace("poc_new_verticals.musician_instagram_discovery_events", `(${events.join(" UNION ALL ")})`)
    .replace("new_vertical.l_profile_account", `(
      SELECT toUInt64(number) AS profile_id, toUInt64(number) AS account_id, NULL AS disconnected_at
      FROM numbers(17) WHERE number IN (6, 7, 16)
    )`)
    .replace("new_vertical.account", `(
      SELECT toUInt64(number) AS id, 'instagram' AS platform, ${literal(url)} AS account_url FROM numbers(17)
      UNION ALL SELECT toUInt64(6), 'instagram', ${literal(url)}
    )`);
  const snapshot = "2026-11-03 04:00:00";
  const result = await clickHouseJson<Parameters<typeof musicianInstagramResearchCoverageResponse>[0][number]>(sql, { snapshotAt: snapshot });
  const response = musicianInstagramResearchCoverageResponse(result.data, `${snapshot.replace(" ", "T")}Z`, new Date("2026-11-03T20:00:00Z"));
  assert.deepEqual(response.tiers[0], {
    tier: 1, totalProfiles: 16,
    profilesWithInstagramUrls: 5, profilesWithCatalogInstagramUrls: 3,
    profilesWithSupportedResearchUrls: 2, profilesWithUnresolvedCandidates: 7,
    profilesWithNoSupportedMatch: 1, profilesWithUrlOrNoSupportedMatch: 6,
    processedProfiles: 12, profilesWithResearchUrls: 10,
    completedNoCandidateProfiles: 2, failedProfiles: 1, pendingProfiles: 1,
    profilesWithResearchCandidates: 10, profilesWithFailedOrIncompleteSearches: 3,
  });
  for (const row of response.tiers.slice(1)) {
    assert.equal(row.totalProfiles, 2);
    assert.equal(row.profilesWithInstagramUrls, 1);
    assert.equal(row.profilesWithSupportedResearchUrls, 1);
    assert.equal(row.profilesWithCatalogInstagramUrls, 0);
    assert.equal(row.profilesWithUnresolvedCandidates, 1);
    assert.equal(row.profilesWithNoSupportedMatch, 0);
  }
});
