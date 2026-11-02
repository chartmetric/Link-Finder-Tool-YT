import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoverageCache } from "../src/lib/coverage-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("cold reads share one calculation, including invalidation during a read", async () => {
  const read = deferred<number>();
  let calls = 0;
  const cache = createCoverageCache(() => { calls++; return read.promise; }, () => {});
  const first = cache.get();
  cache.invalidate();
  const second = cache.get();
  assert.equal(first, second);
  read.resolve(42);
  assert.equal(await first, 42);
  assert.equal(await cache.get(), 42);
  assert.equal(calls, 1);
});

test("expired coverage stays visible during refresh; concurrent readers do not fan out", async () => {
  let time = 0, calls = 0;
  const next = deferred<number>();
  const cache = createCoverageCache(() => ++calls === 1 ? Promise.resolve(10) : next.promise, () => {}, () => time);
  assert.equal(await cache.get(), 10);
  time = 300_001;
  assert.equal(await cache.get(), 10);
  cache.invalidate();
  assert.equal(await cache.get(), 10);
  assert.equal(await cache.get(), 10);
  assert.equal(calls, 2);
  next.resolve(20);
  await flush();
  assert.equal(await cache.get(), 20);
  assert.equal(calls, 2);
});

test("failed refresh keeps real counts with cooldown instead of zeros or another query storm", async () => {
  let time = 0, calls = 0, errors = 0;
  const cache = createCoverageCache(async () => {
    calls++;
    if (calls > 1) throw new Error("read timeout");
    return 73;
  }, () => { errors++; }, () => time);
  assert.equal(await cache.get(), 73);
  time = 300_001;
  assert.equal(await cache.get(), 73);
  await flush();
  assert.equal(await cache.get(), 73);
  assert.equal(errors, 1);
  assert.equal(calls, 2);
  time += 30_001;
  assert.equal(await cache.get(), 73);
  await flush();
  assert.equal(calls, 3);
});

test("cold failures propagate promptly and are briefly coalesced; recovery remains possible", async () => {
  let time = 0, calls = 0;
  const cache = createCoverageCache(async () => {
    if (++calls === 1) throw new Error("unavailable");
    return 9;
  }, () => {}, () => time);
  await assert.rejects(cache.get(), /unavailable/);
  await assert.rejects(cache.get(), /unavailable/);
  assert.equal(calls, 1);
  time = 30_001;
  assert.equal(await cache.get(), 9);
});

test("snapshots older than a day are not silently served", async () => {
  let time = 0, calls = 0;
  const cache = createCoverageCache(async () => {
    if (++calls === 1) return 1;
    throw new Error("expired snapshot");
  }, () => {}, () => time);
  await cache.get();
  time = 24 * 60 * 60_000;
  await assert.rejects(cache.get(), /expired snapshot/);
});
