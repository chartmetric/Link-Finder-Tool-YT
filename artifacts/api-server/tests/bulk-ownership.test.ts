import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, SearchProfilesResponse, type BulkBrandRun } from "@workspace/api-zod";
import {
  BulkOwnership, LEASE_MS, selectionFingerprint,
  type OwnershipTransactionOptions, type Transaction,
} from "../src/lib/bulk-ownership";
import { MemoryStore } from "./helpers/bulk-memory-store";
import { executeBulkRun, type WorkerDependencies } from "../src/lib/bulk-worker";
import { providerFetch, withPaidRequestGuard } from "../src/lib/paid-request-guard";
import { createPostgresOwnershipStore } from "../src/lib/bulk-ownership-store";
import { withBulkLaunch } from "../src/lib/bulk-launch-history";

function fixture(id = 1, count = 3): BulkBrandRun {
  const now = new Date().toISOString();
  return GetBulkBrandRunResponse.parse({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    status: "running", createdAt: now, updatedAt: now, heartbeatAt: now,
    workerId: "unclaimed", resumeVersion: 0, stopRequested: false, estimatedCostUsd: 0,
    items: Array.from({ length: count }, (_, i) => ({
      candidate: { profileId: i + 1, profileName: `Brand ${i}`, tier: 1, tierRank: i,
        accountId: `account-${i}`, platform: "instagram", handle: `brand${i}`, url: `https://www.instagram.com/brand${i}/` },
      status: "queued", platforms: [],
    })),
  });
}
const fingerprint = (run: BulkBrandRun) => selectionFingerprint(run.items.map(item => item.candidate.profileId));
async function claim(owner: BulkOwnership, run = fixture(), worker = "worker-a", expected?: number) {
  return owner.claim(run, worker, fingerprint(run), expected);
}
function deps(ownership: BulkOwnership, calls: number[]): WorkerDependencies {
  return {
    ownership, archive: async () => {}, saveHistory: async () => {}, warn: () => {},
    processItem: async item => {
      calls.push(item.candidate.profileId);
      item.result = SearchProfilesResponse.parse({
        subject: item.candidate.profileName, query: item.candidate.profileName,
        searchedAt: new Date().toISOString(), profiles: [], sources: [],
        totalFound: 0, highConfidenceCount: 0, methodsUsed: [], estimatedCostUsd: 0.01,
      });
      item.status = "completed";
      item.completedAt = new Date().toISOString();
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
class RecordingStore extends MemoryStore {
  readonly transactionOptions: OwnershipTransactionOptions[] = [];
  override async transact<T>(id: string, work: (tx: Transaction) => T, options: OwnershipTransactionOptions = {}) {
    this.transactionOptions.push(options);
    return super.transact(id, work);
  }
}

test("worker guards and run writes use shared queue locks with per-run write locks", async () => {
  const store = new RecordingStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  store.transactionOptions.length = 0;

  await owner.guard(first.lease!);
  assert.deepEqual(store.transactionOptions.at(-1), { queueLock: "shared" });

  await owner.admit(first.lease!, 0);
  assert.deepEqual(store.transactionOptions.at(-1), { queueLock: "shared", recordLock: "update" });

  const saved = structuredClone(first.run);
  saved.items[0].status = "completed";
  await owner.save(first.lease!, saved, 0);
  assert.deepEqual(store.transactionOptions.at(-1), { queueLock: "shared", recordLock: "update" });
});

test("two workers race for one global queue: only one claim launches", async () => {
  const store = new MemoryStore();
  const a = new BulkOwnership(store), b = new BulkOwnership(store);
  const results = await Promise.allSettled([claim(a), claim(b, fixture(2), "worker-b")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const calls: number[] = [];
  for (const result of results) if (result.status === "fulfilled") {
    await executeBulkRun(result.value.run, result.value.lease!, deps(a, calls));
  }
  assert.deepEqual(calls, [1, 2, 3]);
});

test("concurrent request retries are idempotent and changed selections are rejected", async () => {
  const store = new MemoryStore();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(new BulkOwnership(store), fixture(), `worker-${i}`)));
  assert.equal(results.filter(r => r.launched).length, 1);
  assert.equal(new Set(results.map(r => r.run.resumeVersion)).size, 1);
  await assert.rejects(claim(new BulkOwnership(store), fixture(1, 2)), /different brand selection/);
});

test("25-brand cap is enforced in the atomic claim as well as the route", async () => {
  const owner = new BulkOwnership(new MemoryStore());
  await assert.rejects(claim(owner, fixture(1, 26)), /1–25/);
  await assert.rejects(claim(owner, fixture(1, 0)), /1–25/);
  assert.equal((await claim(owner, fixture(1, 25))).run.items.length, 25);
});

test("expired leases cannot renew, dispatch, admit, or save even before a successor claims", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  store.now += LEASE_MS;
  await assert.rejects(owner.renew(first.lease!), /lease lost/);
  await assert.rejects(owner.guard(first.lease!), /lease lost/);
  await assert.rejects(owner.admit(first.lease!, 0), /lease lost/);
  await assert.rejects(owner.save(first.lease!, first.run), /lease lost/);
  assert.equal((await owner.read(first.run.id))[0].status, "interrupted");
  const second = await claim(new BulkOwnership(store), fixture(2), "worker-b");
  assert.ok(second.lease!.token > first.lease!.token);
  await assert.rejects(owner.save(first.lease!, first.run, undefined, true), /lease lost/);
  assert.equal(store.queue.owner!.runId, second.run.id);
});

test("successful heartbeats extend the shared lease using the store clock", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  store.now += LEASE_MS - 1;
  await owner.renew(first.lease!);
  store.now += 2;
  await owner.guard(first.lease!);
  await assert.rejects(claim(new BulkOwnership(store), fixture(2), "worker-b"), /queue is active/);
});

test("a lost claim response is safely retrieved, not launched again by the request retry", async () => {
  class LostResponseStore extends MemoryStore {
    loseResponse = true;
    override async transact<T>(id: string, work: (tx: Transaction) => T) {
      const result = await super.transact(id, work);
      if (this.loseResponse) { this.loseResponse = false; throw new Error("Commit response lost"); }
      return result;
    }
  }
  const store = new LostResponseStore(), owner = new BulkOwnership(store);
  await assert.rejects(claim(owner), /response lost/);
  const retried = await claim(new BulkOwnership(store), fixture(), "worker-b");
  assert.equal(retried.launched, false);
  store.now += LEASE_MS + 1;
  const resumed = await claim(owner, retried.run, "worker-c", retried.run.resumeVersion);
  const calls: number[] = [];
  await executeBulkRun(resumed.run, resumed.lease!, deps(owner, calls));
  assert.deepEqual(calls, [1, 2, 3]);
});

test("crash before admission requires manual resume; reading or restarting launches nothing", async () => {
  const store = new MemoryStore(), a = new BulkOwnership(store);
  const first = await claim(a);
  store.now += LEASE_MS + 1;
  const restarted = new BulkOwnership(store);
  assert.equal((await restarted.read(first.run.id))[0].status, "interrupted");
  const calls: number[] = [];
  assert.deepEqual(calls, []);
  const resumed = await claim(restarted, first.run, "worker-b", first.run.resumeVersion);
  await executeBulkRun(resumed.run, resumed.lease!, deps(restarted, calls));
  assert.deepEqual(calls, [1, 2, 3]);
});

test("crash after provider dispatch preserves completed work and quarantines uncertain work", async () => {
  const store = new MemoryStore(), a = new BulkOwnership(store);
  const first = await claim(a);
  await a.admit(first.lease!, 0);
  first.run.items[0].status = "completed";
  first.run.items[0].completedAt = new Date().toISOString();
  await a.save(first.lease!, first.run, 0);
  await a.admit(first.lease!, 1); // Worker dies after this durable admission.
  store.now += LEASE_MS + 1;
  const b = new BulkOwnership(store);
  const resumed = await claim(b, first.run, "worker-b", first.run.resumeVersion);
  assert.equal(resumed.run.items[0].status, "completed");
  assert.equal(resumed.run.items[1].status, "failed");
  assert.equal(resumed.run.items[1].retryBlocked, true);
  assert.match(resumed.run.items[1].error!, /Outcome unknown/);
  const calls: number[] = [];
  await executeBulkRun(resumed.run, resumed.lease!, deps(b, calls));
  assert.deepEqual(calls, [3]);
  assert.equal((await b.read(first.run.id))[0].items[0].status, "completed");
  await assert.rejects(a.save(first.lease!, first.run), /lease lost/);
});

test("a crash on the final brand is finalized without repeating the uncertain request", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner, fixture(1, 1));
  await owner.admit(first.lease!, 0);
  store.now += LEASE_MS + 1;
  const resumed = await claim(owner, first.run, "worker-b", first.run.resumeVersion);
  assert.equal(resumed.launched, false);
  assert.equal(resumed.run.items[0].retryBlocked, true);
  assert.equal((await owner.read(first.run.id))[0].status, "stopped");
});

test("a paused old worker's late provider result cannot replace recovered results", async () => {
  const store = new MemoryStore(), a = new BulkOwnership(store), b = new BulkOwnership(store);
  const first = await claim(a);
  const entered = deferred(), respond = deferred(), calls: number[] = [];
  let oldArchiveWrites = 0;
  const d = deps(a, calls);
  d.processItem = async item => {
    calls.push(item.candidate.profileId);
    entered.resolve();
    await respond.promise; // Represents an already dispatched request during a pause.
    item.status = "completed";
  };
  d.archive = async () => { oldArchiveWrites++; };
  const oldExecution = executeBulkRun(first.run, first.lease!, d);
  await entered.promise;
  const writesBeforeExpiry = oldArchiveWrites;
  store.now += LEASE_MS + 1;
  const resumed = await claim(b, first.run, "worker-b", first.run.resumeVersion);
  await executeBulkRun(resumed.run, resumed.lease!, deps(b, calls));
  respond.resolve();
  await oldExecution;
  const saved = (await b.read(first.run.id))[0];
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(oldArchiveWrites, writesBeforeExpiry);
  assert.equal(saved.resumeVersion, resumed.run.resumeVersion);
  assert.equal(saved.items[0].retryBlocked, true);
  assert.deepEqual(saved.items.map(item => item.status), ["failed", "completed", "completed"]);
});

test("Stop finishes the current mocked provider, leaves the rest queued, and Resume retries only unfinished work", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  const entered = deferred(), finish = deferred(), calls: number[] = [];
  const dependencies = deps(owner, calls);
  dependencies.processItem = async item => {
    calls.push(item.candidate.profileId);
    entered.resolve();
    await finish.promise;
    item.status = "completed";
  };
  const running = executeBulkRun(first.run, first.lease!, dependencies);
  await entered.promise;
  await owner.stop(first.run.id, first.run.resumeVersion);
  finish.resolve();
  await running;
  assert.deepEqual(calls, [1]);
  const stopped = (await owner.read(first.run.id))[0];
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stopRequested, true);
  const attempts = await Promise.all([
    claim(owner, stopped, "worker-b", stopped.resumeVersion),
    claim(new BulkOwnership(store), stopped, "worker-c", stopped.resumeVersion),
  ]);
  assert.equal(attempts.filter(result => result.launched).length, 1);
  const resumed = attempts.find(result => result.launched)!;
  assert.equal(resumed.run.stopRequested, false);
  await assert.rejects(owner.stop(stopped.id, stopped.resumeVersion), /run changed/);
  await executeBulkRun(resumed.run, resumed.lease!, deps(owner, calls));
  assert.deepEqual(calls, [1, 2, 3]);
  // Delayed HTTP retry after completion must NOT start another generation.
  const retry = await claim(owner, stopped, "worker-d", stopped.resumeVersion);
  assert.equal(retry.launched, false);
  assert.equal(retry.run.status, "completed");
});

test("known provider failures require explicit resume and retrying that resume cannot spend twice", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner, fixture(1, 1));
  const d = deps(owner, []);
  d.processItem = async () => { throw new Error("Mock provider failed"); };
  await executeBulkRun(first.run, first.lease!, d);
  const failed = (await owner.read(first.run.id))[0];
  assert.equal(failed.items[0].status, "failed");
  const resumed = await claim(owner, failed, "worker-b", failed.resumeVersion);
  const calls: number[] = [];
  await executeBulkRun(resumed.run, resumed.lease!, deps(owner, calls));
  const retry = await claim(owner, failed, "worker-c", failed.resumeVersion);
  assert.equal(retry.launched, false);
  assert.deepEqual(calls, [1]);
});

test("concurrent resume request IDs append launch context atomically and remain idempotent after later generations", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const source = fixture(1, 1);
  const first = await claim(owner, withBulkLaunch(source, "start", source.id, "manual_selection"));
  const d = deps(owner, []);
  d.processItem = async () => { throw new Error("Mock provider failed"); };
  await executeBulkRun(first.run, first.lease!, d);
  const failed = (await owner.read(first.run.id))[0];
  const request = { requestId: fixture(2).id, resumeVersion: failed.resumeVersion, launchSource: "run_monitor" as const };
  const resumed = await Promise.all(["b", "c"].map(worker => owner.claim(failed, worker, "", request.resumeVersion, request)));
  assert.equal(resumed.filter(run => run.launched).length, 1);
  const active = resumed.find(run => run.launched)!;
  assert.deepEqual(active.run.launchHistory!.map(event => event.source), ["manual_selection", "run_monitor"]);
  await owner.stop(active.run.id, active.run.resumeVersion);
  await executeBulkRun(active.run, active.lease!, deps(owner, []));
  const stopped = (await owner.read(active.run.id))[0];
  const nextRequest = { requestId: fixture(3).id, resumeVersion: stopped.resumeVersion, launchSource: "multi_type_widget" as const };
  const next = await owner.claim(stopped, "d", "", nextRequest.resumeVersion, nextRequest);
  const calls: number[] = [];
  await executeBulkRun(next.run, next.lease!, deps(owner, calls));
  const delayed = await owner.claim(failed, "e", "", request.resumeVersion, request);
  assert.equal(delayed.launched, false);
  assert.equal(delayed.run.launchHistory!.length, 3);
  assert.equal(delayed.run.status, "completed");
  assert.deepEqual(calls, [1]);
});

test("duplicate admission and coordinator outages cannot start paid work", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  assert.equal(await owner.admit(first.lease!, 0), true);
  await assert.rejects(owner.admit(first.lease!, 0), /already admitted/);
  store.unavailable = true;
  const calls: number[] = [];
  await executeBulkRun(first.run, first.lease!, deps(owner, calls));
  assert.deepEqual(calls, []);
});

test("archive failure stops before the next provider while the acknowledged result stays durable", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  const calls: number[] = [], d = deps(owner, calls);
  d.archive = async snapshot => {
    if (snapshot.items.some(item => item.status === "completed")) throw new Error("ClickHouse unavailable");
  };
  await executeBulkRun(first.run, first.lease!, d);
  assert.deepEqual(calls, [1]);
  const saved = (await owner.read(first.run.id))[0];
  assert.equal(saved.items[0].status, "completed");
  assert.equal(saved.items[0].result?.estimatedCostUsd, 0.01);
  assert.equal(saved.estimatedCostUsd, 0.01);
  assert.equal(saved.items[1].status, "queued");
  assert.equal(saved.status, "stopped");
});

test("every nested provider fetch is guarded and stale workers cannot dispatch after recovery", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("{}"); };
  try {
    await withPaidRequestGuard(() => owner.guard(first.lease!), async () => {
      await providerFetch("https://mock.invalid/resolve");
      store.now += LEASE_MS + 1;
      await claim(new BulkOwnership(store), fixture(2), "worker-b");
      await assert.rejects(providerFetch("https://mock.invalid/discover"), /lease lost/);
    });
    assert.equal(calls, 1);
    // Non-bulk requests have no guard attached.
    await providerFetch("https://mock.invalid/ordinary");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test("parallel lanes drain on Stop without losing fenced results or starting queued profiles", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const source = fixture();
  source.workersPerType = 2;
  const first = await claim(owner, source);
  const entered = deferred(), finish = deferred(), calls: number[] = [];
  const d = deps(owner, calls);
  d.processItem = async (item, progress) => {
    calls.push(item.candidate.profileId);
    progress("searching_platforms");
    if (calls.length === 2) entered.resolve();
    await finish.promise;
    item.status = "completed";
  };
  const running = executeBulkRun(first.run, first.lease!, d);
  await entered.promise;
  await owner.stop(first.run.id, first.run.resumeVersion);
  finish.resolve();
  await running;
  const saved = (await owner.read(first.run.id))[0];
  assert.deepEqual(calls.sort(), [1, 2]);
  assert.deepEqual(saved.items.map(item => item.status), ["completed", "completed", "queued"]);
  assert.equal(saved.workersPerType, 2);
  assert.equal(saved.status, "stopped");
  assert.ok(saved.items.every(item => !item.stage));
});

function continuousFixture() {
  const run = fixture();
  run.items = [];
  run.scopes = [{ profileType: "brand", limit: 2 }];
  run.continuous = {
    upperProfileId: 100, batches: 0, completed: 0, failed: 0, completedCostUsd: 0, profileLimit: 3,
    cursors: [{ profileType: "brand", afterId: 0, exhausted: false, completed: 0, failed: 0 }],
  };
  return run;
}

test("continuous chunk transitions retain caps, archives, fences and durable attempted IDs", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const first = await claim(owner, continuousFixture());
  const calls: number[] = [], archives: BulkBrandRun[] = [], d = deps(owner, calls);
  let page = 0;
  d.nextChunk = async progress => {
    page++;
    const candidates = fixture().items.slice(0, page === 1 ? 2 : 1).map((item, index) => ({
      ...item.candidate, profileId: page === 1 ? index + 1 : 3, profileType: "brand" as const,
    }));
    return { candidates, cursors: progress.cursors.map(cursor => ({ ...cursor, afterId: page === 1 ? 2 : 3 })) };
  };
  d.archiveChunk = async archive => { archives.push(archive); };
  await executeBulkRun(first.run, first.lease!, d);
  const saved = (await owner.read(first.run.id))[0];
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(saved.status, "completed");
  assert.equal(saved.items.length, 0);
  assert.equal(saved.continuous!.completed, 3);
  assert.equal(saved.continuous!.batches, 2);
  assert.equal(saved.estimatedCostUsd, 0.03);
  assert.deepEqual(archives.map(run => run.items.length), [2, 1]);
  assert.equal(new Set(archives.map(run => run.id)).size, 2);
  assert.deepEqual([...(await owner.attempted([1, 2, 3, 4]))], [1, 2, 3]);
});

test("a crash after chunk archival never repeats paid jobs or double-counts archived counters", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const source = continuousFixture();
  source.items = fixture().items.slice(0, 2);
  source.continuous!.profileLimit = 2;
  const first = await claim(owner, source);
  const delivered = new Set<string>(), calls: number[] = [], d = deps(owner, calls);
  d.archiveChunk = async archive => { delivered.add(archive.id); store.unavailable = true; };
  await executeBulkRun(first.run, first.lease!, d);
  store.unavailable = false;
  store.now += LEASE_MS + 1;
  const resumed = await claim(new BulkOwnership(store), first.run, "worker-b", first.run.resumeVersion);
  const recovery = deps(owner, calls);
  recovery.archiveChunk = async archive => { assert.ok(delivered.has(archive.id)); };
  await executeBulkRun(resumed.run, resumed.lease!, recovery);
  const saved = (await owner.read(first.run.id))[0];
  assert.deepEqual(calls, [1, 2]);
  assert.equal(delivered.size, 1);
  assert.equal(saved.continuous!.completed, 2);
  assert.equal(saved.continuous!.batches, 1);
  assert.equal(saved.status, "completed");
  assert.equal((await owner.attempted([1, 2])).size, 2);
});

test("real PostgreSQL connections serialize claims and persist fencing across adapter restarts", {
  skip: process.env.BULK_COORDINATION_DB_TEST !== "1",
}, async () => {
  // Unique test-only tables: no live claim/result/catalog data is modified.
  const { pool } = await import("@workspace/db");
  const prefix = `bulk_test_${process.pid}_${Date.now()}`;
  const a = new BulkOwnership(createPostgresOwnershipStore(async () => pool, prefix));
  const b = new BulkOwnership(createPostgresOwnershipStore(async () => pool, prefix));
  try {
    const same = await Promise.all([claim(a), claim(b, fixture(), "worker-b")]);
    assert.equal(same.filter(result => result.launched).length, 1);
    const first = same.find(result => result.launched)!;
    await assert.rejects(claim(b, fixture(2), "worker-b"), /queue is active/);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT state FROM ${prefix}_queue WHERE id = 1 FOR SHARE`);
      const operations = Promise.all([
        ...Array.from({ length: 20 }, () => a.guard(first.lease!)),
        a.admit(first.lease!, 0),
      ]);
      const completedWithoutExclusiveLock = await Promise.race([
        operations.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000)),
      ]);
      assert.equal(completedWithoutExclusiveLock, true, "worker operations should not wait for an exclusive global queue lock");
      await operations;
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      blocker.release();
    }
    assert.deepEqual([...(await b.attempted([1, 99]))], [1]);
    // Deterministic crash simulation: expire only this test's lease, without sleeping.
    await pool.query(`UPDATE ${prefix}_queue SET state = jsonb_set(state, '{owner,until}', '0')`);
    const restarted = new BulkOwnership(createPostgresOwnershipStore(async () => pool, prefix));
    const next = await claim(restarted, first.run, "worker-c", first.run.resumeVersion);
    assert.ok(next.lease!.token > first.lease!.token);
    assert.equal(next.run.items[0].retryBlocked, true);
    await assert.rejects(a.save(first.lease!, first.run, 0, true), /lease lost/);
    const calls: number[] = [];
    await executeBulkRun(next.run, next.lease!, deps(restarted, calls));
    assert.deepEqual(calls, [2, 3]);
    const saved = (await b.read(first.run.id))[0];
    assert.deepEqual(saved.items.map(item => item.status), ["failed", "completed", "completed"]);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_claims; DROP TABLE IF EXISTS ${prefix}_queue; DROP TABLE IF EXISTS ${prefix}_attempts`);
    await pool.end();
  }
});
