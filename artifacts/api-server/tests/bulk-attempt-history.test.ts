import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionAttemptHistory, withBulkAttemptHistory } from "../src/lib/bulk-attempt-history";
import { allPaidProfilesSql } from "../src/lib/bulk-attempt-sql";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";

test("selection reuses one archive read across pages and retains profiles without account IDs", async () => {
  let reads = 0;
  await withBulkAttemptHistory(async () => {
    const read = async () => { reads++; return [{ profile_id: 7, account_ids: [] }, { profile_id: 8, account_ids: ["stable", ""] }]; };
    const one = selectionAttemptHistory(read)!;
    const two = selectionAttemptHistory(read)!;
    assert.equal(one, two);
    const index = await one;
    assert.ok(index.profiles.has(7));
    assert.ok(index.accounts.has("stable"));
    assert.equal(index.accounts.has(""), false);
    assert.equal(reads, 1);
  });
  assert.equal(selectionAttemptHistory(async () => []), undefined);
});

test("history never leaks across concurrent selections, resumes or next paid chunks", async () => {
  let reads = 0;
  const read = async () => [{ profile_id: ++reads, account_ids: [] }];
  const result = await Promise.all([1, 2].map(() => withBulkAttemptHistory(async () =>
    [...(await selectionAttemptHistory(read)!).profiles][0])));
  assert.deepEqual(result.sort(), [1, 2]);
  await withBulkAttemptHistory(async () => assert.ok((await selectionAttemptHistory(read)!).profiles.has(3)));
});

test("failed history reads remain fail-closed for that selection, with a fresh read on explicit new selection", async () => {
  let reads = 0;
  await withBulkAttemptHistory(async () => {
    const read = async () => { reads++; throw new Error("unavailable"); };
    await assert.rejects(selectionAttemptHistory(read)!, /unavailable/);
    await assert.rejects(selectionAttemptHistory(read)!, /unavailable/);
    assert.equal(reads, 1);
  });
  await withBulkAttemptHistory(async () => {
    assert.equal((await selectionAttemptHistory(async () => [])!).profiles.size, 0);
  });
});

test("archive query scans all historical admissions but extracts no provider result payloads", () => {
  assert.match(allPaidProfilesSql, /'completed', 'failed', 'running'/);
  assert.match(allPaidProfilesSql, /notEmpty\(entry.startedAt\)/);
  assert.doesNotMatch(allPaidProfilesSql, /LIMIT|argMax|historyPattern|JSONExtractArrayRaw|result_json|INSERT|UPDATE|DELETE/);
});

test("typed archive SQL preserves historical admissions, aliases and missing optional identity fields", {
  skip: process.env.RUN_BULK_ATTEMPT_SQL !== "1",
}, async () => {
  const item = (profileId: number, status: string, rest = {}) => ({
    candidate: { profileId }, status, ...rest,
    result: { profiles: [{ candidate: { profileId: 9999 }, status: "running" }], padding: "x".repeat(5000) },
  });
  const snapshots = [
    JSON.stringify({ items: [item(1, "running"), item(2, "failed"), item(3, "completed"),
      item(4, "queued"), item(5, "queued", { startedAt: "2026-11-02" }),
      item(6, "completed", { candidate: { profileId: 6, accountId: 'alias"\\id', accounts: [{ accountId: "shared" }] } }),
    ] }),
    // A newer queued/reset snapshot must not erase an earlier admission.
    JSON.stringify({ items: [item(1, "queued"), item(2, "queued")] }),
  ];
  const fixtureSql = allPaidProfilesSql
    .replace("poc_new_verticals.profile_bulk_events", `(SELECT arrayJoin(JSONExtract(base64Decode({fixtures:String}), 'Array(String)')) AS data_json, 'snapshot' AS event_type)`)
    .replace("PREWHERE", "WHERE");
  const rows = await clickHouseJson<{ profile_id: number; account_ids: string[] }>(`${fixtureSql} FORMAT JSON`,
    { fixtures: Buffer.from(JSON.stringify(snapshots)).toString("base64") }, 15_000);
  assert.deepEqual(rows.data.map(row => Number(row.profile_id)).sort((a, b) => a - b), [1, 2, 3, 5, 6]);
  assert.deepEqual(rows.data.find(row => Number(row.profile_id) === 1)?.account_ids, []);
  assert.deepEqual(new Set(rows.data.find(row => Number(row.profile_id) === 6)?.account_ids), new Set(['alias"\\id', "shared"]));
});
