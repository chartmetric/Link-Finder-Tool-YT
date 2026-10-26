import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { catalogProfileType, runScopedQueue, validateBulkSelection } from "../src/lib/bulk-profile-scopes.ts";
import { selectBulkScopes } from "../src/lib/bulk-brand-candidates.ts";
import { GetBulkBrandRunResponse, StartBulkBrandRunBody, type BulkProfileType } from "@workspace/api-zod";

test("Artists map to musician catalog records, with other cohorts unchanged", () => {
  assert.equal(catalogProfileType("artist"), "musician");
  assert.equal(catalogProfileType("creator"), "creator");
  assert.equal(catalogProfileType("brand"), "brand");
});

test("legacy brand selections, typed manual selections, and bounded combined scopes are accepted", () => {
  assert.equal(validateBulkSelection({ profileIds: [1, 2] }), undefined);
  assert.equal(validateBulkSelection({ profileIds: [1], profileTypes: ["artist"] }), undefined);
  assert.equal(validateBulkSelection({ scopes: [
    { profileType: "brand", limit: 8 }, { profileType: "creator", limit: 8 }, { profileType: "artist", limit: 9 },
  ] }), undefined);
});

test("ambiguous input, duplicate scopes, fractional limits, invalid types and over-budget batches are rejected", () => {
  for (const input of [
    {}, { profileIds: [] }, { profileIds: [1, 1] }, { profileIds: [1.1] },
    { profileIds: [1], scopes: [{ profileType: "brand", limit: 1 }] },
    { scopes: [{ profileType: "brand", limit: 1 }, { profileType: "brand", limit: 1 }] },
    { scopes: [{ profileType: "brand", limit: 15 }, { profileType: "artist", limit: 15 }] },
    { scopes: [{ profileType: "creator", limit: 2.5 }] },
    { scopes: [{ profileType: "brand", limit: 0 }] },
    { profileIds: [1], profileTypes: ["creator", "artist"] },
    { scopes: [{ profileType: "actor", limit: 1 }] },
  ]) assert.ok(validateBulkSelection(input as Parameters<typeof validateBulkSelection>[0]), JSON.stringify(input));
});

test("generated request contracts accept scopes and reject unsupported types", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  assert.ok(StartBulkBrandRunBody.safeParse({ requestId, scopes: [{ profileType: "artist", limit: 1 }] }).success);
  assert.equal(StartBulkBrandRunBody.safeParse({ requestId, scopes: [{ profileType: "actor", limit: 1 }] }).success, false);
});

const types: BulkProfileType[] = ["brand", "creator", "artist"];
function queue() {
  return types.flatMap(profileType => [1, 2].map(id => ({
    id: `${profileType}-${id}`, candidate: { profileType }, status: "queued",
  })));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("three types run simultaneously, with at most one active item per type", async () => {
  const items = queue();
  const gates = Object.fromEntries(types.map(type => [type, deferred()]));
  const activeByType = new Map<string, number>();
  const started: string[] = [];
  let active = 0, peak = 0;
  const work = runScopedQueue(items, async () => false, async item => {
    const type = item.candidate.profileType;
    activeByType.set(type, (activeByType.get(type) ?? 0) + 1);
    assert.equal(activeByType.get(type), 1);
    peak = Math.max(peak, ++active);
    started.push(item.id);
    if (item.id.endsWith("-1")) await gates[type].promise;
    item.status = "completed";
    activeByType.set(type, activeByType.get(type)! - 1);
    active--;
  });
  await setImmediate();
  assert.equal(peak, 3);
  assert.deepEqual(new Set(started), new Set(types.map(type => `${type}-1`)));
  for (const gate of Object.values(gates)) gate.resolve();
  await work;
  assert.equal(started.length, 6);
  assert.ok(items.every(item => item.status === "completed"));
});

test("Stop lets current lookups finish but starts no further profile of any type", async () => {
  const items = queue();
  const gate = deferred();
  let stop = false;
  const started: string[] = [];
  const work = runScopedQueue(items, async () => stop, async item => {
    started.push(item.id);
    await gate.promise;
    item.status = "completed";
  });
  await setImmediate();
  stop = true;
  gate.resolve();
  await work;
  assert.equal(started.length, 3);
  assert.equal(items.filter(item => item.status === "queued").length, 3);
});

test("a persistence failure stops new work and waits for other in-flight lanes before returning", async () => {
  const items = queue();
  const gate = deferred();
  let returned = false;
  const started: string[] = [];
  const work = runScopedQueue(items, async () => false, async item => {
    started.push(item.id);
    if (item.candidate.profileType === "brand") throw new Error("storage unavailable");
    await gate.promise;
    item.status = "completed";
  }).catch(error => {
    returned = true;
    assert.match(error.message, /storage unavailable/);
  });
  await setImmediate();
  assert.equal(returned, false);
  gate.resolve();
  await work;
  assert.equal(returned, true);
  assert.ok(started.every(id => id.endsWith("-1")));
});

test("resume skips completed profiles and legacy candidates run sequentially as brands", async () => {
  const items = [
    { candidate: {}, status: "completed" },
    { candidate: {}, status: "queued" },
    { candidate: {}, status: "queued" },
  ];
  let active = 0, calls = 0;
  await runScopedQueue(items, async () => false, async item => {
    assert.equal(++active, 1);
    await setImmediate();
    item.status = "completed";
    active--;
    calls++;
  });
  assert.equal(calls, 2);
});

test("cross-type auto-selection deduplicates the same catalog identity and respects each scope limit", async () => {
  const candidates = await selectBulkScopes([
    { profileType: "brand", limit: 1 }, { profileType: "creator", limit: 2 }, { profileType: "artist", limit: 1 },
  ], async input => ({
    profiles: (input.profileType === "brand" ? [1, 2] : input.profileType === "creator" ? [1, 3, 4] : []).map(profileId => ({
      profileId, profileName: `Profile ${profileId}`, profileType: input.profileType,
      tier: 1, tierRank: 1, accountId: String(profileId), platform: "instagram",
      handle: `profile${profileId}`, url: `https://www.instagram.com/profile${profileId}/`,
    })),
    hasMore: false, nextAfterId: 4, maxBatchSize: 25,
  }));
  assert.deepEqual(candidates.map(c => [c.profileId, c.profileType]), [[1, "brand"], [3, "creator"], [4, "creator"]]);
});

test("legacy snapshots remain valid; requested multi-type scopes round-trip in saved runs", () => {
  const snapshot = {
    id: "00000000-0000-4000-8000-000000000001", status: "completed",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    workerId: "test", resumeVersion: 1, stopRequested: false, estimatedCostUsd: 0, items: [],
  };
  assert.equal(GetBulkBrandRunResponse.parse(snapshot).scopes, undefined);
  assert.deepEqual(GetBulkBrandRunResponse.parse({ ...snapshot, scopes: [{ profileType: "artist", limit: 1 }] }).scopes, [{ profileType: "artist", limit: 1 }]);
});
