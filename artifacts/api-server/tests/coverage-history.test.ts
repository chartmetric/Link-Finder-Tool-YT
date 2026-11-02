import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkCoverageSql, bulkCoverageProfilesSql } from "../src/lib/bulk-coverage";
import { coverageReferenceKeySql } from "../src/lib/coverage-reference-sql";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";

// Opt-in read-only tests against the actual query engine. All catalog/history
// tables are replaced by in-query fixtures; nothing is inserted or reclassified.
const integration = process.env.TEST_CLICKHOUSE_COVERAGE === "1";
const literal = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const platforms = ["Instagram", "TikTok", "YouTube"];
const ref = "https://instagram.com/reference";
function result(verdict = "verified", aliases = [ref]) {
  return {
    referenceProfile: { platform: "instagram", url: ref, urlAliases: aliases },
    profiles: ["TikTok", "YouTube"].map(platform => ({
      platform, url: platform === "TikTok" ? "https://tiktok.com/@reference" : "https://youtube.com/@reference",
      jevVerification: { verdict },
    })),
  };
}
function history(id: number, value: unknown, date = "2026-10-27 10:00:00", knownUrl = ref) {
  return `SELECT toUUID('00000000-0000-0000-0000-${String(id).padStart(12, "0")}') AS id,
    ${literal(knownUrl)} AS known_profile_url, ${literal(JSON.stringify(value))} AS result_json,
    toDateTime64('${date}', 3, 'UTC') AS searched_at`;
}
function fixtureSql(historyRows: string[], bulkItems: unknown[] = [], links = [ref], ambiguous = false) {
  const catalog = `SELECT toUInt64(1) AS id, 'Current name' AS name, NULL AS deleted_at, 'brand' AS profile_type,
    ['brand', 'creator'] AS profile_types, toDateTime('2026-01-01') AS updated_at`;
  const sources: Record<string, string> = {
    "poc_new_verticals.profile_bulk_events": `SELECT 'run' AS run_id, 'snapshot' AS event_type,
      toUInt64(1) AS version, ${literal(JSON.stringify({ items: bulkItems }))} AS data_json`,
    "poc_new_verticals.profile_search_history": historyRows.join(" UNION ALL "),
    "new_vertical.l_profile_account": `SELECT toUInt64(1) AS profile_id, toUInt64(10) AS account_id, NULL AS disconnected_at`,
    "new_vertical.account": `SELECT toUInt64(10) AS id, ${literal(links[0])} AS account_url`,
    "new_vertical.profile_links": links.map(url => `SELECT toUInt64(${ambiguous ? 2 : 1}) AS profile_id, 'true' AS active, ${literal(url)} AS url`).join(" UNION ALL "),
    "new_vertical.l_profile_tier": `SELECT toUInt64(1) AS profile, 'brand' AS profile_type,
      'global' AS grain, 2 AS tier, toDateTime('2026-01-01') AS computed_at, computed_at AS updated_at`,
    "new_vertical.profile": catalog,
  };
  let sql = bulkCoverageSql;
  for (const [table, source] of Object.entries(sources)) sql = sql.replaceAll(table, `(${source})`);
  return sql;
}
const covered = async (sql: string) => {
  const rows = await clickHouseJson<{ profileType: string; group: string; total: string; covered: string }>(sql);
  return Number(rows.data.find(row => row.profileType === "brand" && row.group === "all")?.covered ?? 0);
};
function bulk(verdict = "verified", date = "2026-10-27T09:00:00Z") {
  return {
    candidate: { profileId: 1 }, status: "completed", startedAt: date, completedAt: date,
    result: result(verdict),
    platforms: platforms.map(platform => ({
      platform, status: platform === "Instagram" ? "reference" : "found", evidenceUrls: [ref],
    })),
  };
}

test("single evidence uses only reference aliases and saved verified verdicts", () => {
  assert.match(bulkCoverageSql, /uniqExact\(c.profileId\) = 1/);
  assert.match(bulkCoverageSql, /argMax\(resolved, tuple\(assessedAt, sourceVersion, assessmentId\)\)/);
  assert.match(bulkCoverageSql, /'referenceProfile', 'urlAliases'/);
  assert.doesNotMatch(bulkCoverageSql, /\b(subject|displayName|profile_name)\b/);
});

test("account equivalence preserves IDs, strips social tracking and rejects post URLs", { skip: !integration }, async () => {
  const pairs = [
    ["https://www.instagram.com/Reference/?utm_source=test", ref, true],
    ["https://m.youtube.com/@Reference?si=tracking", "https://youtube.com/@reference", true],
    ["https://youtube.com/channel/UCAbc", "https://youtube.com/channel/UCabc", false],
    ["https://youtube.com/watch?v=one", "https://youtube.com/watch?v=two", false],
    ["https://example.com/profile?id=one", "https://example.com/profile?id=two", false],
    ["https://instagram.com.evil.test/reference", ref, false],
  ] as const;
  for (const [left, right, equivalent] of pairs) {
    const key = coverageReferenceKeySql(literal(left));
    const rows = await clickHouseJson<{ equivalent: number }>(
      `SELECT notEmpty(${key}) AND ${key} = ${coverageReferenceKeySql(literal(right))} AS equivalent FORMAT JSON`);
    assert.equal(Boolean(rows.data[0].equivalent), equivalent, `${left} vs ${right}`);
  }
});

test("linked singles contribute once; likely, unlinked and later unresolved evidence do not", { skip: !integration }, async () => {
  assert.equal(await covered(fixtureSql([history(1, result())])), 1);
  assert.equal(await covered(fixtureSql([history(1, result())], [], [ref], true)), 0);
  assert.equal(await covered(fixtureSql([history(1, result()), history(2, result())])), 1);
  assert.equal(await covered(fixtureSql([history(1, result("likely"))])), 0);
  assert.equal(await covered(fixtureSql([history(1, result(), undefined, "https://instagram.com/other")])), 0);
  assert.equal(await covered(fixtureSql([history(1, result("likely"))], [bulk()])), 0);
  assert.equal(await covered(fixtureSql([history(1, result())], [bulk("likely")])), 1);
  assert.equal(await covered(fixtureSql([history(1, result()), history(2, result("mismatch"), "2026-10-27 11:00:00")])), 0);
  assert.equal(await covered(fixtureSql([history(1, result("likely"))], [bulk("verified", "2026-10-27T11:00:00Z")])), 1);
  const savedBulk = bulk();
  Object.assign(savedBulk.result, { historyId: "00000000-0000-0000-0000-000000000001" });
  assert.equal(await covered(fixtureSql([history(1, result("likely"))], [savedBulk])), 1,
    "the shared-history copy of a bulk result must not override its authoritative snapshot");
  const partial = { referenceProfile: result().referenceProfile, profiles: [] };
  assert.equal(await covered(fixtureSql([history(1, partial)])), 0,
    "a trusted reference alone is not full platform resolution");
});

test("confirmed aliases link without inventing channel-ID equivalence", { skip: !integration }, async () => {
  const value = result();
  value.referenceProfile = {
    platform: "youtube", url: "https://youtube.com/@reference",
    urlAliases: ["https://youtube.com/@reference", "https://youtube.com/channel/UCAbc"],
  };
  value.profiles = ["Instagram", "TikTok"].map(platform => ({
    platform, url: platform === "Instagram" ? ref : "https://tiktok.com/@reference",
    jevVerification: { verdict: "verified" },
  }));
  assert.equal(await covered(fixtureSql([history(1, value, undefined, value.referenceProfile.url)],
    [], ["https://youtube.com/channel/UCAbc"])), 1);
  assert.equal(await covered(fixtureSql([history(1, value, undefined, value.referenceProfile.url)],
    [], ["https://youtube.com/channel/UCabc"])), 0);
});

test("uncovered single-profile evidence is available from coverage buckets with its saved source", { skip: !integration }, async () => {
  const sql = fixtureSql([history(1, result("likely"))]);
  const ctes = sql.split("\nSELECT profileType,")[0];
  const detailSelect = bulkCoverageProfilesSql.slice(bulkCoverageProfilesSql.indexOf("\nSELECT profileId, profileName"));
  const rows = await clickHouseJson<{ profileId: number; sourceRunId: string; sourceHistoryId: string; state: string }>(
    ctes + detailSelect, {
      profileType: "brand", group: "all", platform: "TikTok", state: "likely_only", afterId: "0", pageSize: "26",
    });
  assert.equal(rows.data.length, 1);
  assert.equal(Number(rows.data[0].profileId), 1);
  assert.equal(rows.data[0].state, "likely_only");
  assert.equal(rows.data[0].sourceRunId, "");
  assert.equal(rows.data[0].sourceHistoryId, "00000000-0000-0000-0000-000000000001");
});
