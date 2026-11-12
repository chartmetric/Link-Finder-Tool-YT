import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_ID, CAMPAIGN_QUEUE_SHA256, createCampaignProgressReader } from "../src/lib/artist-campaign-progress";
import { createCampaignSnapshotStore, snapshotProgress, validateCampaignSnapshot, type CampaignSnapshot } from "../src/lib/artist-campaign-snapshot";
import { artistTotals } from "../src/lib/artist-campaign-model";
import { GetArtistCampaignProgressResponse } from "@workspace/api-zod";

const snapshot = (): CampaignSnapshot => ({
  version: 1, campaignId: CAMPAIGN_ID, queueSha256: CAMPAIGN_QUEUE_SHA256,
  totalArtists: 76068, processed: 100, checked: 90, likely: 45, reserved: 382,
  status: "running", updatedAt: "2026-11-11T00:00:00.000Z", capturedAt: "2026-11-11T00:00:05.000Z",
  workerEnvironment: "workspace",
});
test("new snapshots carry explicit uncapped approval while old snapshots remain capped", async () => {
  const s: CampaignSnapshot = { ...snapshot(), version: 2, maximumSpendCents: null,
    authorizationSha256: "a".repeat(64), reserved: 12000 };
  const p = snapshotProgress(s);
  assert.equal(p.maximumSpendUsd, null);
  assert.equal(p.reservedUsd, 120);
  GetArtistCampaignProgressResponse.parse({ progress: p });
  assert.equal(snapshotProgress(snapshot()).maximumSpendUsd, 100);
  assert.throws(() => validateCampaignSnapshot({ ...s, authorizationSha256: undefined }));
  assert.throws(() => validateCampaignSnapshot({ ...s, maximumSpendCents: 10000 }));
  const o = fakeObject();
  const store = createCampaignSnapshotStore(() => o.file);
  await store.publish(snapshot());
  await store.publish(s);
  assert.equal((await store.load())!.maximumSpendCents, null);
  await assert.rejects(store.publish({ ...snapshot(), reserved: 12000 }), /invalid/);
  await assert.rejects(store.publish({ ...s, reserved: 9999, maximumSpendCents: 10000 }), /approval/);
  await assert.rejects(store.publish({ ...s, authorizationSha256: "b".repeat(64) }), /approval/);
});
// Persist the object outside the API reader to model two environments/restarts.
function fakeObject() {
  let bytes: Buffer | undefined;
  let generation = 0;
  let saves = 0;
  let error: number | undefined;
  const missing = () => Object.assign(Error("missing"), { code: 404 });
  const file: any = {
    name: "snapshot.json",
    getMetadata: async () => {
      if (error) throw Object.assign(Error("unavailable"), { code: error });
      if (!bytes) throw missing();
      return [{ size: bytes.length, generation: String(generation) }];
    },
    bucket: { file: (_name: string, options: { generation: string }) => ({
      download: async () => {
        assert.equal(options.generation, String(generation));
        return [bytes];
      },
    }) },
    save: async (data: string, options: any) => {
      assert.equal(String(options.preconditionOpts.ifGenerationMatch), String(generation));
      assert.equal(options.metadata.cacheControl, "no-store");
      bytes = Buffer.from(data); generation++; saves++;
    },
  };
  return { file, saves: () => saves, fail: (code: number) => { error = code; },
    corrupt: (data: string) => { bytes = Buffer.from(data); generation++; } };
}

test("the durable snapshot survives separate environments and API reader restarts without local files or writes", async () => {
  const cloud = fakeObject();
  const writer = createCampaignSnapshotStore(() => cloud.file);
  await writer.publish(snapshot());
  const at = Date.parse("2026-11-11T00:00:10Z");
  const workspaceApi = createCampaignProgressReader(writer.load, () => at);
  const publishedApi = createCampaignProgressReader(createCampaignSnapshotStore(() => cloud.file).load, () => at);
  const a = await workspaceApi();
  assert.deepEqual(await publishedApi(), a);
  assert.deepEqual(await createCampaignProgressReader(writer.load, () => at)(), a);
  assert.equal(a.progress?.campaignId, CAMPAIGN_ID);
  assert.equal(a.progress?.totalArtists, 76068);
  assert.equal(a.progress?.processedArtists, 100);
  assert.equal(a.progress?.successRate, 50);
  assert.equal(cloud.saves(), 1); // GET/restart never publishes or runs anything.
});

test("polls and observer uploads cannot impersonate fresh worker activity", async () => {
  const s = snapshot();
  s.capturedAt = "2026-11-11T04:00:00Z"; // observer still alive, worker stopped reporting
  const p = snapshotProgress(s, Date.parse("2026-11-11T04:00:01Z"));
  assert.equal(p.stale, true);
  assert.equal(p.workerStatus, "stale");
  let now = Date.parse(s.updatedAt) + 119_999;
  const reader = createCampaignProgressReader(async () => snapshot(), () => now);
  assert.equal((await reader()).progress?.stale, false);
  now += 2; // cache still fresh, worker evidence is not
  assert.equal((await reader()).progress?.stale, true);
  s.status = "stopped";
  assert.equal(snapshotProgress(s).workerStatus, "not_running");
});

test("continuation preparation outcomes preserve counters without implying worker liveness", async () => {
  for (const status of ["continuation_requested", "continuation_launching",
    "continuation_preparation_failed", "continuation_preparation_interrupted"]) {
    const s = {...snapshot(), status};
    const p = snapshotProgress(s, Date.parse(s.updatedAt) + 1000);
    GetArtistCampaignProgressResponse.parse({progress:p});
    assert.equal(p.status, status);
    assert.equal(p.workerStatus, "not_running");
    assert.equal(p.processedArtists, 100);
    assert.equal(p.checkedArtists, 90);
    assert.equal(p.likelyMatches, 45);
    assert.equal(p.reservedUsd, 3.82);
    assert.equal(p.stale, false);
  }
});

test("a launch failure before coordinator claim replaces requested evidence without regressing its clock", async () => {
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  const requested = {...snapshot(), status:"continuation_requested"};
  await store.publish(requested);
  const failed = {...requested, status:"continuation_preparation_failed",
    updatedAt:"2026-11-11T00:00:01.000Z"};
  await store.publish(failed);
  const saved = (await store.load())!;
  assert.equal(saved.status, failed.status);
  assert.equal(snapshotProgress(saved).workerStatus, "not_running");
  assert.equal(saved.processed, requested.processed);
  assert.equal(saved.reserved, requested.reserved);
});

test("missing snapshots are empty; storage failures and corrupt data fail explicitly", async () => {
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  assert.equal(await store.load(), null);
  cloud.corrupt("{");
  await assert.rejects(store.load);
  cloud.corrupt("x".repeat(4097));
  await assert.rejects(store.load, /counter-only limit/);
  cloud.fail(403);
  await assert.rejects(store.load);
});

test("snapshots reject foreign approvals, corrupt totals and regressing evidence", async () => {
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), campaignId: "other" }));
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), queueSha256: "other" }));
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), likely: 91 }));
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), updatedAt: "invalid" }));
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), reserved: 10001 }));
  assert.throws(() => validateCampaignSnapshot({ ...snapshot(), updatedAt: "2027-01-01" }));
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  await store.publish(snapshot());
  for (const changes of [{ processed: 99 }, { checked: 89 }, { likely: 44 }, { reserved: 381 },
    { totalArtists: 500 }, { updatedAt: "2026-11-10T00:00:00Z" }]) {
    await assert.rejects(() => store.publish({ ...snapshot(), ...changes }), /older or conflicting/);
  }
  assert.equal(cloud.saves(), 1);
});

test("snapshot allowlist discards evidence and refresh failures retain counters explicitly", async () => {
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  await store.publish({ ...snapshot(), privateEvidence: "not stored" } as any);
  assert.equal("privateEvidence" in (await store.load())!, false);
  let now = 0;
  const reader = createCampaignProgressReader(store.load, () => now);
  await reader();
  now = 5000;
  cloud.fail(500);
  const retained = await reader();
  assert.equal(retained.progress?.processedArtists, 100);
  assert.equal(retained.progress?.snapshotUnavailable, true);
  assert.equal(cloud.saves(), 1);
});

test("uncapped publication exceeds the retired cap offline and cannot regress to it", async () => {
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  await store.publish(snapshot()); // legacy capped snapshot
  const uncapped = { ...snapshot(), version: 2 as const, maximumSpendCents: null,
    authorizationSha256: "a".repeat(64), reserved: 12456 };
  await store.publish(uncapped);
  const loaded = await store.load();
  assert.equal(loaded?.maximumSpendCents, null);
  const result = await createCampaignProgressReader(store.load)();
  GetArtistCampaignProgressResponse.parse(result);
  assert.equal(result.progress?.maximumSpendUsd, null);
  assert.equal(result.progress?.reservedUsd, 124.56);
  await assert.rejects(store.publish({ ...uncapped, maximumSpendCents: 10000, reserved: 9999 }), /approval/);
  assert.throws(() => validateCampaignSnapshot({ ...uncapped, maximumSpendCents: -1 }));
  assert.throws(() => validateCampaignSnapshot({ ...uncapped, maximumSpendCents: "unlimited" }));
  assert.equal(cloud.saves(), 2);
});

test("missing refresh keeps last evidence without refreshing the worker clock and recovers", async () => {
  let now = Date.parse(snapshot().capturedAt);
  let value: CampaignSnapshot | null = snapshot();
  const reader = createCampaignProgressReader(async () => value, () => now);
  await reader();
  value = null; now += 180_000;
  const retained = await reader();
  assert.equal(retained.progress?.processedArtists, 100);
  assert.equal(retained.progress?.snapshotUnavailable, true);
  assert.equal(retained.progress?.updatedAt, snapshot().updatedAt);
  assert.equal(retained.progress?.capturedAt, snapshot().capturedAt);
  assert.equal(retained.progress?.workerStatus, "stale");
  value = { ...snapshot(), processed: 101, capturedAt: new Date(now).toISOString() };
  now += 5000;
  const recovered = await reader();
  assert.equal(recovered.progress?.processedArtists, 101);
  assert.equal(recovered.progress?.snapshotUnavailable, false);
});

test("shared snapshots retain frozen tier counters across API restarts without local evidence", async () => {
  const s = snapshot();
  s.tierBreakdown = [1, 2, 3, 4, 5].map(tier => ({ tier,
    ...artistTotals(tier === 1 ? s.totalArtists : 0, tier === 1
      ? { processed: s.processed, checked: s.checked, likely: s.likely, reserved: 0 }
      : { processed: 0, checked: 0, likely: 0, reserved: 0 }),
  }));
  const cloud = fakeObject();
  const store = createCampaignSnapshotStore(() => cloud.file);
  await store.publish(s);
  const result = await createCampaignProgressReader(store.load)();
  GetArtistCampaignProgressResponse.parse(result);
  assert.deepEqual(result.progress?.tierBreakdown, s.tierBreakdown);
  assert.equal(result.progress?.tierBreakdownUnavailableReason, undefined);
  assert.deepEqual((await createCampaignProgressReader(store.load)()).progress?.tierBreakdown, s.tierBreakdown);
  assert.ok(JSON.stringify(await store.load()).length < 4096);
  assert.equal(cloud.saves(), 1);
});

test("legacy or corrupt optional tier counters preserve headlines with an explicit unavailable reason", () => {
  for (const tierBreakdown of [undefined, [], [{ tier: 1, totalArtists: 500 }]]) {
    const p = snapshotProgress({ ...snapshot(), tierBreakdown } as CampaignSnapshot);
    assert.equal(p.processedArtists, 100);
    assert.equal(p.tierBreakdown, undefined);
    assert.match(p.tierBreakdownUnavailableReason!, /could not be verified/);
  }
});
