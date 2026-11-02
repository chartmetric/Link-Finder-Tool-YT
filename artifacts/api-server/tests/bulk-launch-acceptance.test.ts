import assert from "node:assert/strict";
import { test } from "node:test";
import { startBulkRun, resumeBulkRun, getBulkRun } from "../src/lib/bulk-brand-runner";
import { postgresOwnershipStore } from "../src/lib/bulk-ownership-store";
import { MemoryStore } from "./helpers/bulk-memory-store";
import type { BulkBrandRun } from "@workspace/api-zod";

test("accepted starts and resumes persist once; delayed duplicate requests cannot pay again", async () => {
  // Intercept both storage transports. Never touch real claim tables or providers.
  const memory = new MemoryStore();
  const originalStore = { ...postgresOwnershipStore };
  let rejectNextClaim = false;
  postgresOwnershipStore.transact = (id, work) => memory.transact(id, tx => {
    const generation = tx.record?.run.resumeVersion;
    const result = work(tx);
    if (tx.record && tx.record.run.resumeVersion !== generation) {
      if (rejectNextClaim) { rejectNextClaim = false; throw new Error("Coordinator commit rejected"); }
      // Simulate Stop immediately after acceptance: no catalog candidate or paid request.
      tx.record.run.stopRequested = true;
    }
    return result;
  });
  postgresOwnershipStore.read = memory.read.bind(memory);
  postgresOwnershipStore.attempted = memory.attempted.bind(memory);
  const keys = ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD", "SERPERDEV_API_KEY", "OPENROUTER_API_KEY", "SCRAPECREATORS_API_KEY"];
  const previous = keys.map(key => process.env[key]);
  for (const key of keys) process.env[key] = key === "CLICKHOUSE_VERT_HOST" ? "https://bulk-history-test.invalid" : "test-only";
  const snapshots = new Map<string, BulkBrandRun>();
  let writes = 0;
  const network = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).hostname, "bulk-history-test.invalid", "no external request may escape this test");
    const sql = String(init?.body);
    if (sql.includes("CREATE TABLE")) return new Response("");
    if (sql.includes("INSERT INTO")) {
      assert.match(sql, /INSERT INTO poc_new_verticals\.profile_bulk_events/);
      const event = JSON.parse(sql.split("FORMAT JSONEachRow\n")[1]);
      snapshots.set(event.run_id, JSON.parse(event.data_json));
      writes++;
      return new Response("");
    }
    if (sql.includes("max(id)")) return Response.json({ data: [{ maxId: 100 }] });
    if (sql.includes("argMaxIf")) return Response.json({ data: [] });
    throw new Error("Unexpected query in no-paid-work test");
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 100 && (await getBulkRun(id))?.status === "running"; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await getBulkRun(id))?.status, "stopped");
    await new Promise(resolve => setImmediate(resolve));
  };
  try {
    const id = "aabbccdd-0000-4000-a000-000000000010";
    const settings = { paidAcknowledged: true, scopes: [{ profileType: "creator" as const, limit: 2 }], continuous: true, profileLimit: 8, workersPerType: 3, launchSource: "automatic_launcher" as const };
    const [first, duplicate] = await Promise.all([
      startBulkRun(id.toUpperCase(), settings),
      startBulkRun(id, { ...settings, launchSource: "multi_type_widget" }),
    ]);
    assert.deepEqual(first.launchHistory, duplicate.launchHistory);
    await settle(id);
    await assert.rejects(startBulkRun(id, { ...settings, profileLimit: 99 }), /different brand selection/);
    const beforeDuplicate = writes;
    const delayed = await startBulkRun(id, settings);
    assert.equal(writes, beforeDuplicate);
    assert.equal(delayed.launchHistory!.length, 1);
    assert.equal(delayed.launchHistory![0].settings.profileLimit, 8);
    assert.equal(delayed.launchHistory![0].settings.workersPerType, 3);
    assert.equal(delayed.launchHistory![0].source, "automatic_launcher");
    const requestId = "aabbccdd-0000-4000-a000-000000000011";
    const generation = delayed.resumeVersion;
    const [resumed, replay] = await Promise.all([
      resumeBulkRun(id, { requestId, resumeVersion: generation, launchSource: "run_monitor" }),
      resumeBulkRun(id, { requestId, resumeVersion: generation, launchSource: "multi_type_widget" }),
    ]);
    assert.deepEqual(resumed.launchHistory, replay.launchHistory);
    await settle(id);
    const afterResume = writes;
    assert.equal((await resumeBulkRun(id, { requestId, resumeVersion: generation })).launchHistory!.length, 2);
    assert.equal(writes, afterResume);
    assert.equal((await getBulkRun(id))!.launchHistory![1].source, "run_monitor");
    rejectNextClaim = true;
    const nextRequest = "aabbccdd-0000-4000-a000-000000000012";
    const nextGeneration = (await getBulkRun(id))!.resumeVersion;
    await assert.rejects(resumeBulkRun(id, { requestId: nextRequest, resumeVersion: nextGeneration }), /commit rejected/);
    assert.equal((await getBulkRun(id))!.launchHistory!.length, 2);
    await resumeBulkRun(id, { requestId: nextRequest, resumeVersion: nextGeneration });
    await settle(id);
    const restored = (await getBulkRun(id))!;
    assert.equal(restored.launchHistory!.length, 3);
    assert.equal(restored.launchHistory![2].source, "unknown");
    assert.equal(restored.launchHistory![2].settings.profileLimit, 8);
    assert.equal(restored.launchHistory![2].settings.workersPerType, 3);
  } finally {
    Object.assign(postgresOwnershipStore, originalStore);
    globalThis.fetch = network;
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});
