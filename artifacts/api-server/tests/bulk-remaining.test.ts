import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { eligibleBrandSql, paidProfilesSql, selectBulkScopes } from "../src/lib/bulk-brand-candidates";
import { validateBulkSelection } from "../src/lib/bulk-profile-scopes";
import { StartBulkBrandRunBody, type BulkBrandCandidate, type BulkProfileType } from "@workspace/api-zod";
import { attemptedCandidateIds, bulkAttemptSnapshotPattern } from "../src/lib/bulk-run-store";

const types: BulkProfileType[] = ["brand", "creator", "artist"];
function candidate(profileId: number, profileType: BulkProfileType, accountId = String(profileId)): BulkBrandCandidate {
  return { profileId, profileType, accountId, profileName: `Profile ${profileId}`, tier: 1,
    tierRank: 1, platform: "Instagram", handle: `profile${profileId}`, url: `https://www.instagram.com/profile${profileId}/` };
}

test("remaining selection advances for each type, including beyond a full completed page; rerun is explicit", async () => {
  const completed = new Set<number>();
  const catalog = types.flatMap((type, i) => Array.from({ length: 60 }, (_, n) => candidate(i * 100 + n + 1, type)));
  const fetchPage: Parameters<typeof selectBulkScopes>[1] = async input => {
    const rows = catalog.filter(c => c.profileType === input.profileType
      && c.profileId > (input.afterId ?? 0) && (!input.remaining || !completed.has(c.profileId)));
    const profiles = rows.slice(0, input.limit);
    return { profiles, hasMore: rows.length > input.limit, nextAfterId: profiles.at(-1)?.profileId ?? 0, maxBatchSize: 25 };
  };
  const scopes = types.map(profileType => ({ profileType, limit: 8 }));
  const first = await selectBulkScopes(scopes, fetchPage);
  assert.equal(first.length, 24);
  first.forEach(c => completed.add(c.profileId));
  const frozenIds = first.map(c => c.profileId);
  for (let batch = 0; batch < 4; batch++) {
    const next = await selectBulkScopes(scopes, fetchPage);
    assert.equal(next.length, 24);
    assert.ok(next.every(c => !completed.has(c.profileId)));
    next.forEach(c => completed.add(c.profileId));
  }
  assert.deepEqual(first.map(c => c.profileId), frozenIds);
  assert.deepEqual((await selectBulkScopes(scopes, fetchPage, "rerun")).map(c => c.profileId), frozenIds);
  catalog.forEach(c => completed.add(c.profileId));
  assert.deepEqual(await selectBulkScopes(scopes, fetchPage), []);
});

test("shared accounts and profile IDs across types are selected once, paging to fill deduplicated scopes", async () => {
  const selected = await selectBulkScopes([{ profileType: "brand", limit: 1 }, { profileType: "artist", limit: 2 }], async input => {
    const profiles = input.profileType === "brand" ? [candidate(1, "brand", "shared-account")]
      : input.afterId ? [candidate(4, "artist"), candidate(5, "artist")]
      : [candidate(1, "artist"), candidate(2, "artist", "shared-account"), candidate(3, "artist", "shared-account")];
    return { profiles, hasMore: input.profileType === "artist" && !input.afterId, nextAfterId: profiles.at(-1)!.profileId, maxBatchSize: 25 };
  });
  assert.deepEqual(selected.map(c => c.profileId), [1, 4, 5]);
});

test("remaining history is all-event, fail-closed and keyed by stable profile and account IDs, not URL aliases", () => {
  const sql = eligibleBrandSql();
  assert.match(paidProfilesSql, /poc_new_verticals\.profile_bulk_events/);
  assert.match(paidProfilesSql, /'candidate', 'profileId'/);
  assert.match(paidProfilesSql, /'candidate', 'accountId'/);
  assert.match(paidProfilesSql, /'candidate', 'accounts'/);
  assert.match(paidProfilesSql, /'completed', 'failed', 'running'/);
  assert.match(paidProfilesSql, /'startedAt'/);
  assert.doesNotMatch(paidProfilesSql, /LIMIT|argMax|known_profile_url|'queued'/);
  assert.doesNotMatch(sql, /INSERT|ALTER|DELETE|UPDATE|DROP|TRUNCATE/);
  assert.doesNotMatch(eligibleBrandSql(false, false), /paid_profiles|profile_bulk_events/);
});

test("history/catalog failure cannot silently fall back to rerun selection", async () => {
  await assert.rejects(selectBulkScopes([{ profileType: "brand", limit: 1 }], async () => {
    throw new Error("history unavailable");
  }), /history unavailable/);
});

test("saved attempts block aliases, changed reference accounts, and shared cross-type identities without conflating names", () => {
  const alias = { ...candidate(2, "creator", "paid-account"), url: "https://www.instagram.com/renamed/" };
  const changedSeed = { ...candidate(3, "artist", "new-reference"), accounts: [
    { accountId: "paid-account", platform: "YouTube", handle: "renamed", url: "https://www.youtube.com/@renamed" },
  ] };
  const untouched = candidate(4, "brand");
  const byProfile = candidate(1, "artist", "replacement-account");
  const attempted = attemptedCandidateIds([byProfile, alias, changedSeed, untouched], [
    { profile_id: 1, account_id: "paid-account" },
  ]);
  assert.deepEqual([...attempted], [1, 2, 3]);
});

test("history identity prefilter allows whitespace and escaped account IDs without dropping saved attempts", () => {
  const accountId = 'account".+[\\test';
  const pattern = new RegExp(bulkAttemptSnapshotPattern([123], [accountId]));
  for (const json of [
    JSON.stringify({ items: [{ candidate: { profileId: 123 } }] }),
    JSON.stringify({ items: [{ candidate: { profileId: 123 } }] }, null, 2),
    JSON.stringify({ items: [{ candidate: { profileId: 999, accountId } }] }),
    JSON.stringify({ items: [{ candidate: { profileId: 999, accounts: [{ accountId }] } }] }, null, 2),
  ]) assert.ok(pattern.test(json), json);
  assert.equal(pattern.test(JSON.stringify({ candidate: { profileId: 1234, accountId: "other" } })), false);
});

test("manual and automatic reruns require explicit paid acknowledgement at the server boundary", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  const manual = { requestId, profileIds: [1], selectionMode: "rerun" as const };
  assert.equal(StartBulkBrandRunBody.safeParse(manual).success, false);
  assert.match(validateBulkSelection({ ...manual, paidAcknowledged: false })!, /acknowledge/);
  assert.equal(validateBulkSelection({ ...manual, paidAcknowledged: true }), undefined);
  assert.match(validateBulkSelection({ profileIds: [1], paidAcknowledged: true })!, /rerun/);
  assert.match(validateBulkSelection({ scopes: [{ profileType: "artist", limit: 1 }], selectionMode: "rerun", paidAcknowledged: false })!, /acknowledge/);
  assert.match(validateBulkSelection({ scopes: [{ profileType: "artist", limit: 1 }], selectionMode: "rerun", paidAcknowledged: true, continuous: true })!, /Continuous runs use remaining/);
});

test("page mount and navigation only restore state; paid starts occur only in explicit submit handlers", () => {
  for (const path of [
    "artifacts/musician-social-finder/src/components/bulk/launch-widget.tsx",
    "artifacts/musician-social-finder/src/components/bulk/auto-launcher.tsx",
    "artifacts/musician-social-finder/src/pages/BulkBrands.tsx",
  ]) {
    const source = readFileSync(`${process.cwd().endsWith("api-server") ? "../../" : ""}${path}`, "utf8");
    assert.match(source, /const \[ack, setAck\] = useState\(false\)/);
    assert.match(source, /const submit = \(\) => \{/);
    assert.match(source, /onClick=\{submit\}/);
    assert.equal((source.match(/start\.mutate\(/g) ?? []).length, 1);
    assert.doesNotMatch(source, /useEffect\([^;]*start\.mutate/s);
    assert.match(source, /paidAcknowledged: ack/);
  }
});
