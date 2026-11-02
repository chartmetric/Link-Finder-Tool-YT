import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, type BulkBrandCandidate, type BulkBrandRun } from "@workspace/api-zod";
import { BulkOwnership, LEASE_MS } from "../src/lib/bulk-ownership";
import { postgresOwnershipStore } from "../src/lib/bulk-ownership-store";
import { getBulkRun, startBulkRun, stopBulkRun } from "../src/lib/bulk-brand-runner";
import { preparationCatalogRead } from "../src/lib/bulk-preparation";
import { clickHouseJson } from "../src/lib/clickhouse-profiles";
import { eligibleBrandSql, listEligibleBrands, selectBulkScopes } from "../src/lib/bulk-brand-candidates";
import { executeBulkRun, type WorkerDependencies } from "../src/lib/bulk-worker";
import { MemoryStore } from "./helpers/bulk-memory-store";

function candidate(id: number): BulkBrandCandidate {
  return { profileId: id, profileName: `Test ${id}`, tier: 1, tierRank: id,
    accountId: `test-${id}`, platform: "instagram", handle: `test${id}`, url: `https://www.instagram.com/test${id}/` };
}
function run(): BulkBrandRun {
  const now = new Date().toISOString();
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000000099", status: "running",
    createdAt: now, updatedAt: now, heartbeatAt: now, workerId: "test",
    resumeVersion: 0, stopRequested: false, estimatedCostUsd: 0, items: [],
    scopes: [{ profileType: "brand", limit: 1000 }], workersPerType: 20,
    preparation: { status: "selecting", mode: "one_chunk", requested: 1000, selected: 0, message: "Preparing" },
  });
}
function deps(owner: BulkOwnership, calls: number[]): WorkerDependencies {
  return {
    ownership: owner, archive: async () => {}, saveHistory: async () => {}, warn: () => {},
    processItem: async item => { calls.push(item.candidate.profileId); item.status = "completed"; },
  };
}
async function settle(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) { await new Promise(resolve => setImmediate(resolve)); return; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail("Background preparation did not settle");
}

test("1000-profile launch acknowledges before a blocked catalog read; duplicate and stop cannot dispatch paid work", async () => {
  const memory = new MemoryStore();
  const previousStore = { ...postgresOwnershipStore }, network = globalThis.fetch;
  const keys = ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD", "SERPERDEV_API_KEY", "OPENROUTER_API_KEY", "SCRAPECREATORS_API_KEY"];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === "CLICKHOUSE_VERT_HOST" ? "https://preparation-test.invalid" : "test-only"; });
  postgresOwnershipStore.transact = memory.transact.bind(memory);
  postgresOwnershipStore.read = memory.read.bind(memory);
  postgresOwnershipStore.attempted = memory.attempted.bind(memory);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let catalogReads = 0, providerCalls = 0;
  let readSignal: AbortSignal | undefined;
  const cancelledQueries: string[] = [];
  globalThis.fetch = async (url, init) => {
    const host = new URL(String(url)).hostname;
    if (host !== "preparation-test.invalid") { providerCalls++; throw new Error("Paid network request blocked by test"); }
    const sql = String(init?.body);
    if (sql.startsWith("KILL QUERY")) {
      cancelledQueries.push(new URL(String(url)).searchParams.get("param_queryId")!);
      return new Response("denied", { status: 403 });
    }
    if (sql.includes("CREATE TABLE") || sql.includes("INSERT INTO")) return new Response("");
    catalogReads++;
    readSignal = init?.signal ?? undefined;
    await blocked;
    return Response.json({ data: [] });
  };
  const settings = { scopes: [{ profileType: "brand" as const, limit: 1000 }], workersPerType: 20, paidAcknowledged: true };
  const id = run().id;
  try {
    const accepted = await startBulkRun(id, settings);
    assert.equal(accepted.preparation?.status, "selecting");
    assert.equal(accepted.items.length, 0);
    assert.equal(accepted.workersPerType, 20);
    await settle(async () => catalogReads === 1);
    const duplicate = await startBulkRun(id, settings);
    assert.equal(duplicate.resumeVersion, accepted.resumeVersion);
    assert.equal(duplicate.launchHistory?.length, 1);
    await assert.rejects(startBulkRun(id, { ...settings, workersPerType: 19 }), /different brand selection/);
    await stopBulkRun(id, accepted.resumeVersion);
    await settle(async () => (await getBulkRun(id))?.status === "stopped");
    assert.equal(readSignal?.aborted, true);
    assert.equal(cancelledQueries.length, 1);
    assert.match(cancelledQueries[0], /^bulk-preparation-/);
    assert.equal(catalogReads, 1, "Stop must not retry even if the transport ignores abort");
    assert.equal(memory.queue.owner, undefined);
    const saved = (await getBulkRun(id))!;
    assert.match(saved.error!, /No paid provider requests/);
    assert.equal(providerCalls, 0);
    assert.equal(memory.attempts.size, 0);
    assert.equal((await startBulkRun(id, settings)).resumeVersion, accepted.resumeVersion);
  } finally {
    release();
    Object.assign(postgresOwnershipStore, previousStore);
    globalThis.fetch = network;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("cross-process Stop aborts a blocked read within the preparation poll interval", { timeout: 4_000 }, async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store), remote = new BulkOwnership(store);
  const claimed = await owner.claim(run(), "worker", "settings"), calls: number[] = [];
  let started!: () => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined, attempts = 0;
  const worker = executeBulkRun(claimed.run, claimed.lease!, {
    ...deps(owner, calls),
    prepare: async (_run, checkpoint, abort) => {
      signal = abort;
      await preparationCatalogRead(checkpoint, async () => {
        attempts++;
        started();
        return new Promise<never>(() => {});
      }, undefined, abort)("SELECT 1");
      return true;
    },
  });
  await reading;
  await remote.stop(run().id, claimed.lease!.token);
  await worker;
  assert.equal(signal?.aborted, true);
  assert.equal(attempts, 1);
  assert.equal((await owner.read(run().id))[0].status, "stopped");
  assert.equal(store.queue.owner, undefined);
  assert.deepEqual(calls, []);
  assert.equal(store.attempts.size, 0);
});

test("Stop during retry backoff does not start another catalog attempt", async () => {
  const controller = new AbortController();
  let attempts = 0, waiting!: () => void;
  const backoff = new Promise<void>(resolve => { waiting = resolve; });
  const read = preparationCatalogRead(async () => {}, async () => {
    attempts++;
    throw new DOMException("slow", "TimeoutError");
  }, async () => { waiting(); await new Promise(() => {}); }, controller.signal);
  const pending = read("SELECT 1");
  await backoff;
  controller.abort(new Error("User Stop"));
  await assert.rejects(pending, /User Stop/);
  assert.equal(attempts, 1);
});

test("local Stop notifications are generation scoped and occur only after commit", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const claimed = await owner.claim(run(), "worker", "settings");
  let stopped = 0, stale = 0;
  const unsubscribe = owner.onStop(claimed.lease!, () => {
    assert.equal(store.records.get(run().id)?.run.stopRequested, true);
    stopped++;
  });
  const removeStale = owner.onStop({ ...claimed.lease!, token: 0 }, () => { stale++; });
  await assert.rejects(owner.stop(run().id, 0), /Refresh before stopping/);
  assert.equal(stopped, 0);
  store.unavailable = true;
  await assert.rejects(owner.stop(run().id, claimed.lease!.token), /Coordinator unavailable/);
  store.unavailable = false;
  assert.equal(stopped, 0, "failed Stop must not notify a worker");
  await owner.stop(run().id, claimed.lease!.token);
  assert.equal(stopped, 1);
  assert.equal(stale, 0);
  unsubscribe();
  removeStale();
  await owner.stop(run().id, claimed.lease!.token);
  assert.equal(stopped, 1);
});

test("cancelled response bodies use exact-query cancellation without delaying rejection", async () => {
  const network = globalThis.fetch;
  const keys = ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD"];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === keys[0] ? "https://preparation-test.invalid" : "test-only"; });
  let bodyStarted!: () => void;
  const body = new Promise<void>(resolve => { bodyStarted = resolve; });
  const requests: { url: URL; sql: string }[] = [];
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(String(url)), sql: String(init?.body) });
    if (requests.length > 1) return new Promise<Response>(() => {}); // cancellation server unavailable
    return { ok: true, json: async () => { bodyStarted(); return new Promise(() => {}); } } as Response;
  };
  try {
    const pending = clickHouseJson("SELECT 1", {}, 45_000, undefined, { signal: controller.signal, maxExecutionSeconds: 40 });
    await body;
    controller.abort(new Error("User Stop"));
    await assert.rejects(pending, /User Stop/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url.searchParams.get("max_execution_time"), "40");
    assert.equal(requests[0].url.searchParams.get("timeout_overflow_mode"), "throw");
    assert.equal(requests[1].url.searchParams.get("param_queryId"), requests[0].url.searchParams.get("query_id"));
    assert.match(requests[1].sql, /query_id = \{queryId:String\} AND user = currentUser\(\) ASYNC/);
  } finally {
    globalThis.fetch = network;
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

for (const phase of ["boundary", "profiles", "accounts", "attempts"] as const) {
  test(`Stop cancels the ${phase} preparation read without waiting for its response`, async () => {
    const memory = new MemoryStore(), network = globalThis.fetch, previousStore = { ...postgresOwnershipStore };
    const keys = ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD", "SERPERDEV_API_KEY", "OPENROUTER_API_KEY", "SCRAPECREATORS_API_KEY"];
    const previous = keys.map(key => process.env[key]);
    keys.forEach(key => { process.env[key] = key === keys[0] ? "https://preparation-test.invalid" : "test-only"; });
    postgresOwnershipStore.transact = memory.transact.bind(memory);
    postgresOwnershipStore.read = memory.read.bind(memory);
    postgresOwnershipStore.attempted = memory.attempted.bind(memory);
    let blocked = false, paid = 0, release!: () => void;
    const cancelledIds: (string | null)[] = [];
    const response = new Promise<void>(resolve => { release = resolve; });
    let signal: AbortSignal | undefined, queryId: string | null = null;
    const queries: string[] = [];
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url)), sql = String(init?.body);
      if (target.hostname !== "preparation-test.invalid") { paid++; throw new Error("Paid network blocked"); }
      if (sql.startsWith("KILL QUERY")) {
        cancelledIds.push(target.searchParams.get("param_queryId"));
        return new Response("");
      }
      if (sql.includes("CREATE TABLE") || sql.includes("INSERT INTO")) return new Response("");
      const current = sql.includes("argMaxIf") ? "archive"
        : sql.includes("SELECT max(id)") ? "boundary"
        : sql.includes("AS attemptedItem") ? "attempts"
        : sql.includes("current_relationships") ? "accounts" : "profiles";
      queries.push(current);
      if (current === phase) {
        blocked = true;
        signal = init?.signal ?? undefined;
        queryId = target.searchParams.get("query_id");
        await response; // deliberately ignores abort; a late result must be harmless
      }
      return Response.json({ data: current === "boundary" ? [{ maxId: 1 }]
        : current === "profiles" ? [{ profileId: 1, profileName: "Test" }]
        : current === "accounts" ? [{ profileId: 1, tier: 1, tierRank: 1, accounts: [["test-1", "instagram", "test1", "https://www.instagram.com/test1/"]] }]
        : [] });
    };
    try {
      const accepted = await startBulkRun(run().id, { scopes: [{ profileType: "brand", limit: 1 }], paidAcknowledged: true });
      await settle(async () => blocked);
      const before = queries.length;
      await stopBulkRun(accepted.id, accepted.resumeVersion);
      await settle(async () => (await getBulkRun(accepted.id))?.status === "stopped");
      assert.equal(signal?.aborted, true);
      assert.deepEqual(cancelledIds, [queryId]);
      assert.ok(queryId);
      assert.equal(memory.queue.owner, undefined);
      assert.equal(memory.attempts.size, 0);
      release();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(queries.length, before, "a late response cannot continue selection");
      assert.equal(paid, 0);
    } finally {
      release();
      Object.assign(postgresOwnershipStore, previousStore);
      globalThis.fetch = network;
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
  });
}

test("a lost preparation lease aborts the old read without changing or dispatching the resumed generation", { timeout: 4_000 }, async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store), successor = new BulkOwnership(store);
  const first = await owner.claim(run(), "old-worker", "settings"), calls: number[] = [];
  let started!: () => void, oldSignal: AbortSignal | undefined;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const worker = executeBulkRun(first.run, first.lease!, {
    ...deps(owner, calls),
    prepare: async (_run, checkpoint, signal) => {
      oldSignal = signal;
      await preparationCatalogRead(checkpoint, async () => {
        started();
        return new Promise<never>(() => {});
      }, undefined, signal)("SELECT 1");
      return true;
    },
  });
  await reading;
  store.now += LEASE_MS + 1;
  const resumed = await successor.claim(first.run, "new-worker", "settings", first.lease!.token);
  await worker;
  assert.equal(oldSignal?.aborted, true);
  assert.equal((await successor.read(run().id))[0].resumeVersion, resumed.lease!.token);
  assert.equal((await successor.read(run().id))[0].status, "running");
  assert.equal(store.attempts.size, 0);
  assert.deepEqual(calls, []);
  await executeBulkRun(resumed.run, resumed.lease!, {
    ...deps(successor, calls),
    prepare: async saved => {
      saved.items = [{ candidate: candidate(1), status: "queued", platforms: [] }];
      saved.preparation!.status = "ready";
      return true;
    },
  });
  assert.deepEqual(calls, [1]);
  const duplicate = await successor.claim(first.run, "duplicate-worker", "settings", first.lease!.token);
  assert.equal(duplicate.launched, false);
  assert.equal(duplicate.run.resumeVersion, resumed.lease!.token);
});

test("preparation failure is durable and empty queues can explicitly resume without duplicating a launch", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store), calls: number[] = [];
  const first = await owner.claim(run(), "test-worker", "settings");
  await executeBulkRun(first.run, first.lease!, {
    ...deps(owner, calls),
    prepare: async () => { throw new DOMException("Catalog timed out", "TimeoutError"); },
  });
  const stopped = (await owner.read(run().id))[0];
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.preparation?.status, "selecting");
  assert.match(stopped.error!, /explicitly resume/);
  assert.deepEqual(calls, []);
  const resumed = await owner.claim(stopped, "next-worker", "settings", stopped.resumeVersion);
  assert.equal(resumed.launched, true);
  await executeBulkRun(resumed.run, resumed.lease!, {
    ...deps(owner, calls),
    prepare: async saved => {
      saved.items = [{ candidate: candidate(1), status: "queued", platforms: [] }];
      saved.preparation!.status = "ready";
      saved.preparation!.selected = 1;
      return true;
    },
  });
  assert.deepEqual(calls, [1]);
  assert.equal((await owner.read(run().id))[0].status, "completed");
  assert.equal((await owner.claim(stopped, "replay-worker", "settings", stopped.resumeVersion)).launched, false);
});

test("the authoritative coordinator forbids paid admission while a partial selection exists", async () => {
  const owner = new BulkOwnership(new MemoryStore()), partial = run();
  partial.items = [{ candidate: candidate(1), status: "queued", platforms: [] }];
  const claimed = await owner.claim(partial, "test-worker", "settings");
  await assert.rejects(owner.admit(claimed.lease!, 0), /selection is not complete/);
});

test("legacy restoration retains results and uncertain admissions without launching any new work", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const claimed = await owner.claim(run(), "test-worker", "settings");
  const legacy = run();
  delete legacy.preparation;
  legacy.items = [
    { candidate: candidate(1), status: "completed", platforms: [] },
    { candidate: candidate(2), status: "running", platforms: [] },
  ];
  const restored = await owner.restoreArchived(claimed.lease!, legacy);
  assert.equal(restored.items[0].status, "completed");
  assert.equal(restored.status, "stopped");
  assert.deepEqual(store.records.get(run().id)!.uncertain, [1]);
  assert.equal(store.queue.owner, undefined);
  const resumed = await owner.claim(restored, "next-worker", "settings", restored.resumeVersion);
  assert.equal(resumed.launched, false);
  assert.equal(resumed.run.items[1].retryBlocked, true);
});

test("only transient read failures receive bounded retries; permission failures do not retry", async () => {
  let reads = 0;
  const messages: string[] = [];
  const read = preparationCatalogRead(async message => { messages.push(message); },
    async <T>(_sql: string, _params?: Record<string, string>, timeout?: number) => {
      assert.equal(timeout, 45_000);
      if (++reads < 3) throw new DOMException("slow", "TimeoutError");
      return { data: [{ ok: true }] as T[] };
    }, async () => {});
  assert.deepEqual(await read("SELECT 1"), { data: [{ ok: true }] });
  assert.equal(reads, 3);
  assert.match(messages[1], /retrying read 2\/3/);
  reads = 0;
  const denied = preparationCatalogRead(async () => {}, async () => { reads++; throw new Error("CLICKHOUSE_QUERY_FAILED:403:denied"); }, async () => {});
  await assert.rejects(denied("SELECT 1"), /403/);
  assert.equal(reads, 1);
});

test("obsolete-only bounded pages advance the scan cursor without loading any account details", async () => {
  let reads = 0;
  const page = await listEligibleBrands({ limit: 1, afterId: 40 }, async <T>(sql: string) => {
    reads++;
    assert.equal(sql, eligibleBrandSql());
    assert.ok(sql.indexOf("LIMIT {rowLimit:UInt32}") < sql.indexOf("current_profiles AS"));
    return { data: [{ profileId: 0, profileName: "", scanAfterId: 50, scanCount: 2 }] as T[] };
  });
  assert.equal(reads, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextAfterId, 50);
  assert.deepEqual(page.profiles, []);
});

test("1000-profile selections use four bounded pages and checkpoint their selection counts", async () => {
  const counts: number[] = [], cursors: number[] = [];
  const selected = await selectBulkScopes([{ profileType: "brand", limit: 1000 }],
    async input => {
      assert.equal(input.limit, 250);
      assert.equal(input.maxProfileId, 1000);
      cursors.push(input.afterId ?? 0);
      const end = (input.afterId ?? 0) + 250;
      return { profiles: Array.from({ length: 250 }, (_, i) => candidate((input.afterId ?? 0) + i + 1)),
        hasMore: end < 1000, nextAfterId: end, maxBatchSize: 25 };
    }, "remaining", 1000, async profiles => { counts.push(profiles.length); });
  assert.equal(selected.length, 1000);
  assert.deepEqual(cursors, [0, 250, 500, 750]);
  assert.deepEqual(counts, [250, 500, 750, 1000]);
});
