import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, ResumeBulkBrandRunBody, StartBulkBrandRunBody, type BulkBrandRun } from "@workspace/api-zod";
import { acceptedBulkRequest, withBulkLaunch } from "../src/lib/bulk-launch-history";
import { decodeBulkSnapshot } from "../src/lib/bulk-run-store";
import { continuousArchive, commitContinuousArchive } from "../src/lib/bulk-continuous";
import { bulkRequest, completeBulkRequest } from "../../musician-social-finder/src/lib/bulk-requests";
import { sourceLabel } from "../../musician-social-finder/src/lib/bulk-launch-label";

const id = "aabbccdd-0000-4000-a000-000000000001";
const resumeId = "aabbccdd-0000-4000-a000-000000000002";
function fixture(): BulkBrandRun {
  return {
    id, status: "stopped", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(), workerId: "test", resumeVersion: 100,
    stopRequested: false, estimatedCostUsd: 0, items: [],
    scopes: [{ profileType: "brand", limit: 2 }, { profileType: "artist", limit: 1 }],
    continuous: {
      upperProfileId: 100, profileLimit: 10, batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
      cursors: [{ profileType: "brand", afterId: 0, exhausted: false, completed: 0, failed: 0 }],
    },
  };
}

test("accepted settings are detached, persistent, append-only and duplicate IDs stay recognized", () => {
  const original = fixture();
  const run = withBulkLaunch(original, "start", id, "multi_type_widget");
  const first = structuredClone(run.launchHistory![0]);
  run.scopes![0].limit = 9;
  run.continuous!.profileLimit = 20;
  assert.deepEqual(run.launchHistory![0], first, "progress or settings objects cannot mutate accepted history");
  assert.equal(original.launchHistory, undefined);
  const resumed = withBulkLaunch(run, "resume", resumeId, "run_monitor");
  assert.deepEqual(resumed.launchHistory![0], first);
  assert.equal(resumed.launchHistory!.length, 2);
  const restored = decodeBulkSnapshot({ state: JSON.stringify(resumed), stopVersion: 0 });
  assert.deepEqual(restored.launchHistory, resumed.launchHistory);
  assert.equal(acceptedBulkRequest(restored, resumeId.toUpperCase()), true);
  assert.equal(acceptedBulkRequest(restored, id), true);
  assert.equal(acceptedBulkRequest(restored, crypto.randomUUID()), false);
});

test("chunk continuation inherits history without another Start, and archives freeze earlier context", () => {
  let run = withBulkLaunch(fixture(), "start", id, "automatic_launcher");
  const archive = continuousArchive(run);
  commitContinuousArchive(run);
  assert.equal(run.launchHistory!.length, 1);
  assert.equal(archive.launchHistory![0].action, "start");
  run = withBulkLaunch(run, "resume", resumeId, "multi_type_widget");
  assert.equal(run.launchHistory![1].chunkNumber, 2);
  assert.equal(archive.launchHistory!.length, 1);
  assert.equal(archive.archiveOf, run.id);
});

test("older runs never infer a launcher from profile type, and missing labels stay unknown", () => {
  const old = GetBulkBrandRunResponse.parse(fixture());
  assert.equal(old.launchHistory, undefined);
  const resumed = withBulkLaunch(old, "resume", resumeId, undefined);
  assert.equal(resumed.launchHistory![0].source, "unknown");
  assert.equal(resumed.launchHistory!.some(event => event.action === "start"), false);
  assert.equal(sourceLabel(undefined), "Unknown source");
  assert.equal(sourceLabel("untrusted-label"), "Unknown source");
  const manual = withBulkLaunch({ ...old, continuous: undefined }, "start", id, "manual_selection", {
    scopes: [{ profileType: "creator", limit: 2 }], continuous: false, profileIds: [17, 18],
  });
  assert.equal(sourceLabel(manual.launchHistory![0].source), "Manual selection");
  assert.deepEqual(manual.launchHistory![0].settings.profileIds, [17, 18]);
});

test("resume requires a stable ID; source labels are bounded metadata and extra personal fields are discarded", () => {
  assert.equal(ResumeBulkBrandRunBody.safeParse({}).success, false);
  assert.equal(ResumeBulkBrandRunBody.safeParse({ requestId: resumeId, launchSource: "admin" }).success, false);
  assert.equal(ResumeBulkBrandRunBody.safeParse({ requestId: resumeId }).success, false);
  const body = ResumeBulkBrandRunBody.parse({ requestId: resumeId, resumeVersion: 100, actor: "not-stored", ip: "not-stored" });
  assert.deepEqual(body, { requestId: resumeId, resumeVersion: 100 });
  assert.equal(StartBulkBrandRunBody.parse({ requestId: id, paidAcknowledged: true }).launchSource, undefined);
});

test("uncertain browser requests survive reloads and cross-type navigation without launching work", async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  const key = "manual:creator:17";
  // A saved request from before a page reload (no matching in-memory entry).
  storage.set("bulk-profiles:pending:" + key, JSON.stringify({ requestId: id, launchSource: "manual_selection" }));
  assert.equal(bulkRequest(key, "manual_selection").requestId, id);
  const artist = bulkRequest("manual:artist:17", "manual_selection");
  assert.notEqual(artist.requestId, id);
  assert.equal(bulkRequest(key, "manual_selection").requestId, id);
  const pendingResume = bulkRequest("resume:" + id, "run_monitor");
  assert.deepEqual(bulkRequest("resume:" + id, "multi_type_widget"), pendingResume, "a second surface cannot relabel an uncertain request");
  completeBulkRequest(key, artist.requestId);
  assert.equal(bulkRequest(key, "manual_selection").requestId, id, "an old callback cannot clear another request");
  completeBulkRequest(key, id);
  assert.notEqual(bulkRequest(key, "manual_selection").requestId, id, "next explicit action receives a fresh ID");
  delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
});
