import assert from "node:assert/strict";
import { test } from "node:test";
import { ListBulkBrandCandidatesQueryParams, type BulkBrandCandidate } from "@workspace/api-zod";
import { eligibleBrandSql, listEligibleBrands, profileAccountDetailsSql } from "../src/lib/bulk-brand-candidates.ts";

function candidate(id: number): BulkBrandCandidate {
  return { profileId: id, profileName: `Profile ${id}`, tier: 3, tierRank: id,
    accountId: String(id), platform: "instagram", handle: `profile${id}`, url: `https://www.instagram.com/profile${id}/` };
}

function details(rows: BulkBrandCandidate[]) {
  return rows.map(row => ({ profileId: row.profileId, tier: row.tier, tierRank: row.tierRank,
    accounts: [[row.accountId, row.platform, row.handle, row.url]] }));
}
function fixtureReader(rows: BulkBrandCandidate[]) {
  return async <T>(sql: string) => ({
    data: (sql === profileAccountDetailsSql() ? details(rows) : rows) as T[],
  });
}

test("candidate filters bind literal search text, latest tier, mapped type, cursor and lookahead limit", async () => {
  for (const [profileType, catalogType] of [["brand", "brand"], ["creator", "creator"], ["artist", "musician"]] as const) {
    const page = await listEligibleBrands({
      limit: 2, afterId: 41, profileType, search: "  @O'Reilly_%  ", tier: 3,
    }, async <T>(sql: string, params?: Record<string, string>, timeout?: number) => {
      if (sql === profileAccountDetailsSql()) {
        assert.deepEqual(params, { ids: "[42,44,51]", profileType: catalogType });
        return { data: details([candidate(42), candidate(44), candidate(51)]) as T[] };
      }
      assert.equal(sql, eligibleBrandSql(false, false, { search: true, tier: true }));
      assert.doesNotMatch(sql, /O'Reilly/);
      assert.deepEqual(params, {
        ids: "[]", profileType: catalogType, afterId: "41", rowLimit: "3", search: "O'Reilly_%", tier: "3",
      });
      assert.equal(timeout, 20_000);
      return { data: [candidate(42), candidate(44), candidate(51)] as T[] };
    });
    assert.deepEqual(page.profiles.map(c => c.profileId), [42, 44]);
    assert.ok(page.profiles.every(c => c.profileType === profileType));
    assert.equal(page.nextAfterId, 44);
    assert.equal(page.hasMore, true);
  }
});

test("omitted and blank filters retain all tiers; empty/final pages keep correct cursors", async () => {
  for (const search of [undefined, "", "   ", " @ "]) {
    const empty = await listEligibleBrands({ limit: 10, afterId: 44, search }, async <T>(_sql: string, params?: Record<string, string>) => {
      assert.equal(params?.search, "");
      assert.equal(params?.tier, "0");
      assert.equal(params?.profileType, "brand");
      return { data: [] as T[] };
    });
    assert.deepEqual(empty, { profiles: [], hasMore: false, nextAfterId: 44, maxBatchSize: 25 });
  }
  const final = await listEligibleBrands({ limit: 2 }, fixtureReader([candidate(45), candidate(46)]));
  assert.equal(final.hasMore, false);
  assert.equal(final.nextAfterId, 46);
});

test("filtering never changes selected-ID revalidation bounds or invokes discovery", async () => {
  const page = await listEligibleBrands({ limit: 25, profileIds: [42], profileType: "artist" },
    async <T>(sql: string, params?: Record<string, string>) => {
      if (sql === profileAccountDetailsSql()) return { data: details([candidate(42)]) as T[] };
      assert.match(sql, /id IN \{ids:Array\(UInt64\)\}/);
      assert.equal(params?.ids, "[42]");
      assert.equal(params?.rowLimit, "26");
      return { data: [candidate(42)] as T[] };
    });
  assert.equal(page.profiles.length, 1);
});

test("filters match latest names, any current linked handle and latest tiers before limiting the broader catalog", () => {
  const sql = eligibleBrandSql(false, true, { search: true, tier: true });
  assert.match(sql, /GROUP BY profile HAVING tupleElement\(assignment, 1\) = \{tier:UInt8\}/);
  assert.match(sql, /argMax\(tuple\(tier, tier_rank\), tuple\(computed_at, updated_at\)\)/);
  assert.match(sql, /argMax\(tuple\(handle, is_active\), modified_at\)/);
  assert.match(sql, /GROUP BY id HAVING tupleElement\(account, 2\) = 1/);
  assert.match(sql, /positionCaseInsensitiveUTF8\(ifNull\(tupleElement\(account, 1\), ''\), \{search:String\}\)/);
  assert.match(sql, /GROUP BY id HAVING tupleElement\(link, 3\) IS NULL/);
  assert.match(sql, /tupleElement\(link, 2\) IN \(SELECT id FROM matching_accounts\)/);
  assert.match(sql, /argMax\(tuple\(name\), updated_at\) AS name_data/);
  assert.match(sql, /GROUP BY id HAVING positionCaseInsensitiveUTF8\(ifNull\(tupleElement\(name_data, 1\), ''\), \{search:String\}\)/);
  assert.match(sql, /SELECT id FROM matching_names\s+UNION DISTINCT SELECT tupleElement\(link, 1\) FROM matching_links/);
  assert.match(sql, /has\(tupleElement\(data, 4\), \{profileType:String\}\)/);
  assert.match(sql, /id <= \{upperId:UInt64\}/);
  assert.ok(sql.indexOf("AND id IN (SELECT profile FROM matching_tiers)") < sql.indexOf("LIMIT {rowLimit:UInt32}"));
  assert.doesNotMatch(sql, /uniqExact|single_accounts/);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|ALTER|DELETE|DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /ILIKE|LIKE/); // % and _ are literal, never wildcards.
  // Unfiltered pages must retain the incoming bounded-enrichment fast path.
  assert.doesNotMatch(eligibleBrandSql(), /matching_names|matching_accounts|matching_links|matching_tiers/);
});

test("generated contracts reject invalid bounds and internal callers fail before reading the catalog", async () => {
  for (const input of [
    { limit: 0 }, { limit: 26 }, { limit: 2.5 }, { afterId: -1 }, { afterId: 1.5 },
    { afterId: Number.MAX_SAFE_INTEGER + 1 }, { tier: 0 }, { tier: 6 }, { tier: 1.5 },
    { search: "x".repeat(121) }, { profileType: "musician" }, { tier: "NaN" },
  ]) {
    assert.equal(ListBulkBrandCandidatesQueryParams.safeParse(input).success, false, JSON.stringify(input));
    await assert.rejects(listEligibleBrands({ limit: 10, ...input } as Parameters<typeof listEligibleBrands>[0],
      async () => { assert.fail("Invalid input must not read the catalog"); }));
  }
  for (const profileIds of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 26 }, (_, i) => i + 1)]) {
    await assert.rejects(listEligibleBrands({ limit: 25, profileIds },
      async () => { assert.fail("Invalid IDs must not read the catalog"); }));
  }
  assert.equal(ListBulkBrandCandidatesQueryParams.safeParse({
    limit: "25", afterId: String(Number.MAX_SAFE_INTEGER), search: "x".repeat(120), tier: "5", profileType: "artist",
  }).success, true);
});

test("bounded continuous catalog reads retain their larger internal page size without expanding public bounds", async () => {
  const page = await listEligibleBrands({ limit: 250, maxProfileId: 10000 },
    async <T>(sql: string, params?: Record<string, string>) => {
      assert.equal(params?.rowLimit, "251");
      assert.equal(params?.upperId, "10000");
      assert.match(sql, /id <= \{upperId:UInt64\}/);
      return { data: [] as T[] };
    });
  assert.equal(page.hasMore, false);
  for (const input of [{ limit: 251, maxProfileId: 10000 }, { limit: 10, maxProfileId: -1 },
    { limit: 10, maxProfileId: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(listEligibleBrands(input, async () => { assert.fail("Invalid internal bounds"); }));
  }
});

test("unlinked, unranked and multi-account profiles survive filtering without making unusable profiles runnable", async () => {
  const rows = [{ profileId: 1, profileName: "Unlinked" }, { profileId: 2, profileName: "Multi" }];
  const page = await listEligibleBrands({ limit: 10, search: "profile" }, async <T>(sql: string) => ({
    data: (sql === profileAccountDetailsSql() ? [
      { profileId: 1, tier: null, tierRank: null, accounts: [] },
      { profileId: 2, tier: 3, tierRank: 10, accounts: [
        ["1", "instagram", "one", "https://www.instagram.com/one/"],
        ["2", "tiktok", "two", "https://www.tiktok.com/@two"],
      ] },
    ] : rows) as T[],
  }));
  assert.equal(page.profiles.length, 2);
  assert.equal(page.profiles[0].tier, null);
  assert.equal(page.profiles[0].accountCount, 0);
  assert.equal(page.profiles[0].canInvestigate, false);
  assert.equal(page.profiles[1].accountCount, 2);
  assert.equal(page.profiles[1].canInvestigate, true);
});

test("catalog failures remain visible rather than returning a false empty page", async () => {
  await assert.rejects(listEligibleBrands({ limit: 10, search: "missing" }, async () => {
    throw new Error("catalog unavailable");
  }), /catalog unavailable/);
});
