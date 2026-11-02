import assert from "node:assert/strict";
import { test } from "node:test";
import { startBulkRun, resumeBulkRun, getBulkRun } from "../src/lib/bulk-brand-runner";
import type { BulkBrandRun } from "@workspace/api-zod";

test("accepted starts and resumes persist once; delayed duplicate requests cannot pay again", async () => {
  // Every network call is intercepted. No catalog writes or paid providers are used.
  for (const key of ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD", "SERPERDEV_API_KEY", "OPENROUTER_API_KEY", "SCRAPECREATORS_API_KEY"]) {
    process.env[key] = key === "CLICKHOUSE_VERT_HOST" ? "https://bulk-history-test.invalid" : "test-only";
  }
  const snapshots = new Map<string, BulkBrandRun>();
  let writes = 0;
  let rejectNextWrite = false;
  const network = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "bulk-history-test.invalid", "no real external request may escape this test");
    const sql = String(init?.body);
    if (sql.includes("CREATE TABLE")) return new Response("");
    if (sql.includes("INSERT INTO")) {
      assert.match(sql, /INSERT INTO poc_new_verticals\.profile_bulk_events/, "only application-owned history may be written");
      if (rejectNextWrite) { rejectNextWrite = false; return new Response("", { status: 503 }); }
      const event = JSON.parse(sql.split("FORMAT JSONEachRow\n")[1]);
      assert.equal(event.event_type, "snapshot");
      snapshots.set(event.run_id, JSON.parse(event.data_json));
      writes++;
      return new Response("");
    }
    if (sql.includes("max(id)")) return Response.json({ data: [{ maxId: 100 }] });
    if (sql.includes("argMaxIf")) {
      const id = new URL(String(url)).searchParams.get("param_id");
      const runs = id ? [snapshots.get(id)].filter(Boolean) : [...snapshots.values()];
      return Response.json({ data: runs.map(run => ({
        state: JSON.stringify(run),
        // Stop the empty coordinator before any candidate or provider request.
        stopVersion: run!.resumeVersion + 1,
      })) });
    }
    throw new Error("Unexpected query in no-paid-work test");
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 100 && snapshots.get(id)?.status === "running"; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(snapshots.get(id)?.status, "stopped");
    await new Promise(resolve => setImmediate(resolve)); // allow worker finally to release ownership
  };
  try {
    const id = "aabbccdd-0000-4000-a000-000000000010";
    const settings = { scopes: [{ profileType: "creator" as const, limit: 2 }], continuous: true, profileLimit: 8, workersPerType: 3, launchSource: "automatic_launcher" as const };
    const [first, duplicate] = await Promise.all([
      startBulkRun(id.toUpperCase(), settings),
      startBulkRun(id, { ...settings, launchSource: "multi_type_widget", profileLimit: 99 }),
    ]);
    assert.deepEqual(first.launchHistory, duplicate.launchHistory);
    await settle(id);
    const beforeDuplicate = writes;
    const delayed = await startBulkRun(id, settings);
    assert.equal(writes, beforeDuplicate);
    assert.equal(delayed.launchHistory!.length, 1);
    assert.equal(delayed.launchHistory![0].settings.profileLimit, 8);
    assert.equal(delayed.launchHistory![0].settings.workersPerType, 3);
    assert.equal(delayed.launchHistory![0].source, "automatic_launcher");

    const requestId = "aabbccdd-0000-4000-a000-000000000011";
    const [resumed, replay] = await Promise.all([
      resumeBulkRun(id, { requestId, launchSource: "run_monitor" }),
      resumeBulkRun(id, { requestId, launchSource: "multi_type_widget" }),
    ]);
    assert.deepEqual(resumed.launchHistory, replay.launchHistory);
    await settle(id);
    const afterResume = writes;
    assert.equal((await resumeBulkRun(id, { requestId })).launchHistory!.length, 2);
    assert.equal(writes, afterResume, "a delayed duplicate resume must not launch another worker");
    assert.equal((await getBulkRun(id))!.launchHistory![1].source, "run_monitor");

    rejectNextWrite = true;
    const nextRequest = "aabbccdd-0000-4000-a000-000000000012";
    await assert.rejects(resumeBulkRun(id, { requestId: nextRequest }), /persist bulk progress/);
    assert.equal((await getBulkRun(id))!.launchHistory!.length, 2, "rejected persistence cannot leave a phantom accepted resume");
    await resumeBulkRun(id, { requestId: nextRequest });
    await settle(id);
    const restored = JSON.parse(JSON.stringify(snapshots.get(id))) as BulkBrandRun;
    assert.equal(restored.launchHistory!.length, 3);
    assert.equal(restored.launchHistory![2].source, "unknown");
    assert.equal(restored.launchHistory![2].settings.profileLimit, 8, "resume retains accepted cap");
    assert.equal(restored.launchHistory![2].settings.workersPerType, 3, "resume retains accepted concurrency");
  } finally {
    globalThis.fetch = network;
  }
});
