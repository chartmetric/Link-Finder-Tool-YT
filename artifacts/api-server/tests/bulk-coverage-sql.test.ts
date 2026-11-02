import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkCoverageSql, bulkCoverageProfilesSql, coverageResponse } from "../src/lib/bulk-coverage";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";

// Opt-in read-only ClickHouse check: all table sources are replaced with inline
// fixtures. Nothing is inserted, and no discovery/verification provider is used.
test("coverage SQL counts and pages share active, latest, platform-specific evidence", {
  skip: process.env.RUN_COVERAGE_SQL_TESTS !== "1",
}, async () => {
  const outcome = (platform: string, status: string, evidenceUrls = ["https://example.com/evidence"]) =>
    ({ platform, status, evidenceUrls, reason: status, checkedAt: "2026-10-27T00:00:00Z" });
  const ref = outcome("Instagram", "reference");
  const found = outcome("TikTok", "found");
  const absent = outcome("YouTube", "explicit_unavailable");
  const noMatch = outcome("YouTube", "not_found", []);
  const item = (id: number, platforms: unknown[], candidates: unknown[] = [], status = "completed", startedAt = "2026-10-27T00:00:00Z") => ({
    candidate: { profileId: id, profileType: "brand", tier: 1, url: "https://example.com/reference" },
    status, platforms, startedAt, completedAt: status === "completed" ? startedAt : "",
    result: { profiles: candidates }, error: status === "failed" ? "Provider failed" : "",
  });
  const verified = { platform: "TikTok", jevVerification: { verdict: "verified" } };
  const likely = { platform: "TikTok", jevVerification: { verdict: "likely" } };
  const events = [
    { run_id: "old", version: 1, data_json: JSON.stringify({ items: [item(2, [ref, found, absent], [verified], "completed", "2026-10-26")] }) },
    { run_id: "root", version: 2, data_json: JSON.stringify({ items: [
      item(1, [ref, found, absent], [verified]),
      item(2, [ref, found, noMatch], [likely]),
      item(3, [ref, outcome("TikTok", "needs_review"), absent]),
      item(4, [], [], "failed"),
      item(5, [ref], [], "running"),
      item(6, [ref, found, noMatch], [likely]), // deleted catalog ID
      item(7, [], [], "failed"), // no longer a brand in the active catalog
      item(8, [ref, outcome("TikTok", "incomplete", []), noMatch]),
      item(9, [ref, found, outcome("YouTube", "explicit_unavailable", [])], [likely]),
      { candidate: { profileId: 10 }, status: "queued", platforms: [] }, // not yet investigated
      item(11, [ref, found, absent], [verified]), // multi-type artist + creator
    ] }) },
    // Repeated archived evidence is the same profile, not an extra count.
    { run_id: "archive", version: 3, data_json: JSON.stringify({ archiveOf: "root", items: [item(2, [ref, found, noMatch], [likely])] }) },
    { run_id: "superseded", version: 1, data_json: JSON.stringify({ items: [item(12, [ref, found, absent], [verified])] }) },
    { run_id: "superseded", version: 4, data_json: JSON.stringify({ items: [item(12, [], [], "failed", "2026-10-28")] }) },
  ];
  const catalog = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1, name: `Current name ${i + 1}`, deleted: i + 1 === 6,
    profile_type: i + 1 === 7 ? "creator" : i + 1 === 11 ? "musician" : "brand",
    profile_types: i + 1 === 11 ? ["musician", "creator"] : [], updated_at: 1,
  }));
  const tiers = [
    ...[1, 2, 5, 8, 9, 12].map(profile => ({ profile, profile_type: "brand", tier: 2 })),
    { profile: 3, profile_type: "brand", tier: 4 },
    { profile: 7, profile_type: "creator", tier: 3 },
    { profile: 11, profile_type: "musician", tier: 1 },
    { profile: 11, profile_type: "creator", tier: 5 },
  ];
  const fixtureSql = (sql: string) => sql
    .replaceAll("poc_new_verticals.profile_search_history", `(
      SELECT toUUID('00000000-0000-0000-0000-000000000000') AS id, '' AS known_profile_url,
        '{}' AS result_json, toDateTime64('2026-01-01', 3, 'UTC') AS searched_at WHERE 0)`)
    .replaceAll("new_vertical.l_profile_account", `(
      SELECT toUInt64(0) AS profile_id, toUInt64(0) AS account_id, NULL AS disconnected_at WHERE 0)`)
    .replaceAll("new_vertical.account", `(SELECT toUInt64(0) AS id, '' AS account_url WHERE 0)`)
    .replaceAll("new_vertical.profile_links", `(SELECT toUInt64(0) AS profile_id, 'false' AS active, '' AS url WHERE 0)`)
    .replace("poc_new_verticals.profile_bulk_events", `(
      SELECT JSONExtractString(row, 'run_id') AS run_id, JSONExtractRaw(row, 'data_json') AS data_json,
        JSONExtractUInt(row, 'version') AS version, 'snapshot' AS event_type
      FROM (SELECT arrayJoin(JSONExtractArrayRaw({events:String})) AS row))`)
    .replace("new_vertical.profile GROUP", `(
      SELECT JSONExtractUInt(row, 'id') AS id, JSONExtractString(row, 'name') AS name,
        if(JSONExtractBool(row, 'deleted'), toNullable('deleted'), NULL) AS deleted_at,
        JSONExtractString(row, 'profile_type') AS profile_type,
        JSONExtract(row, 'profile_types', 'Array(String)') AS profile_types,
        JSONExtractUInt(row, 'updated_at') AS updated_at
      FROM (SELECT arrayJoin(JSONExtractArrayRaw({catalog:String})) AS row)) GROUP`)
    .replace("new_vertical.l_profile_tier", `(
      SELECT JSONExtractUInt(row, 'profile') AS profile, JSONExtractString(row, 'profile_type') AS profile_type,
        JSONExtractUInt(row, 'tier') AS tier, 'global' AS grain, 1 AS computed_at, 1 AS updated_at
      FROM (SELECT arrayJoin(JSONExtractArrayRaw({tiers:String})) AS row))`);
  const params = {
    events: JSON.stringify(events.map(event => ({ ...event, data_json: JSON.parse(event.data_json) }))),
    catalog: JSON.stringify(catalog), tiers: JSON.stringify(tiers),
  };
  const counts = await clickHouseJson<Parameters<typeof coverageResponse>[0][number]>(fixtureSql(bulkCoverageSql), params, 60_000);
  const result = coverageResponse(counts.data);
  const brand = result.types.find(t => t.profileType === "brand")!;
  const all = brand.buckets.find(b => b.group === "all")!;
  assert.equal(all.total, 9); // excludes deleted and reclassified IDs
  assert.equal(all.covered, 1);
  assert.equal(all.investigated, 8);
  assert.equal(all.uncoveredInvestigated, 7);
  assert.equal(brand.buckets.find(b => b.group === "tiers_1_3")!.total, 6);
  assert.equal(brand.buckets.find(b => b.group === "tiers_1_5")!.total, 7);
  const count = (platform: string, state: string) => all.platformBreakdown
    .find(p => p.platform === platform)!.states.find(s => s.state === state)!.count;
  assert.equal(count("TikTok", "likely_only"), 2);
  assert.equal(count("TikTok", "needs_review"), 1);
  assert.equal(count("TikTok", "provider_failure"), 3);
  assert.equal(count("TikTok", "unresolved"), 1);
  assert.equal(count("YouTube", "no_match"), 2);
  assert.equal(count("YouTube", "explicit_absence"), 1); // fully covered ID 1 excluded
  assert.equal(count("YouTube", "needs_review"), 1); // unsourced absence excluded
  assert.equal(result.types.find(t => t.profileType === "artist")!.buckets[0].covered, 1);
  assert.equal(result.types.find(t => t.profileType === "creator")!.buckets[2].total, 2);

  // Exact membership from the drill-down agrees with every summary count, for
  // every type/tier group/platform/state, including zeroes and unranked records.
  // Compare all bucket memberships in one read-only grouped query.
  const detailSource = fixtureSql(bulkCoverageProfilesSql).split("\nSELECT profileId, profileName")[0];
  const details = await clickHouseJson<{ profileType: string; group: string; platform: string; state: string; ids: number[] }>(`${detailSource}
    SELECT profileType, \`group\`, platform, evidenceState AS state, groupArray(profileId) AS ids
    FROM platform_evidence WHERE investigated = 1 AND resolved = 0 AND notEmpty(evidenceState)
    GROUP BY profileType, \`group\`, platform, evidenceState FORMAT JSON`, params);
  for (const type of result.types) for (const bucket of type.buckets) {
    for (const p of bucket.platformBreakdown) for (const s of p.states) {
      const ids = details.data.find(d => d.profileType === type.profileType && d.group === bucket.group
        && d.platform === p.platform && d.state === s.state)?.ids ?? [];
      assert.equal(ids.length, s.count, `${type.profileType}/${bucket.group}/${p.platform}/${s.state}`);
    }
  }
  const page = await clickHouseJson<{ profileId: number; profileName: string; state: string }>(fixtureSql(bulkCoverageProfilesSql), {
    ...params, profileType: "brand", group: "all", platform: "TikTok", state: "likely_only",
    afterId: "0", pageSize: "1",
  });
  assert.deepEqual(page.data.map(p => Number(p.profileId)), [2]);
  assert.equal(page.data[0].profileName, "Current name 2");
  const next = await clickHouseJson<{ profileId: number }>(fixtureSql(bulkCoverageProfilesSql), {
    ...params, profileType: "brand", group: "all", platform: "TikTok", state: "likely_only",
    afterId: "2", pageSize: "2",
  });
  assert.deepEqual(next.data.map(p => Number(p.profileId)), [9]);
});
