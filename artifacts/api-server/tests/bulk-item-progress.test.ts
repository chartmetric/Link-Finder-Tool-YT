import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, type BulkBrandItem } from "@workspace/api-zod";
import { advanceItemStage, clearItemStage } from "../src/lib/bulk-item-progress";
import { decodeBulkSnapshot } from "../src/lib/bulk-run-store";
import { findProfiles } from "../src/lib/musician-search";

function item(): BulkBrandItem {
  return {
    candidate: { profileId: 1, profileName: "Example", tier: null, tierRank: null,
      accountId: "example", platform: "instagram", handle: "example", url: "https://www.instagram.com/example/" },
    status: "running", platforms: [],
  };
}

test("progress is bounded to three monotonic transitions per running attempt", () => {
  const row = item();
  assert.equal(advanceItemStage(row, "reading_reference"), true);
  const started = row.stageStartedAt;
  assert.equal(advanceItemStage(row, "reading_reference"), false);
  assert.equal(row.stageStartedAt, started);
  assert.equal(advanceItemStage(row, "searching_platforms"), true);
  assert.equal(advanceItemStage(row, "reading_reference"), false);
  assert.equal(advanceItemStage(row, "verifying_candidates"), true);
  assert.equal(advanceItemStage(row, "searching_platforms"), false);
  assert.equal(advanceItemStage(row, "verifying_candidates"), false);
});

test("terminal and resume cleanup removes stages; queued/terminal items ignore late updates", () => {
  for (const status of ["queued", "completed", "failed"] as const) {
    const row = item();
    advanceItemStage(row, "verifying_candidates");
    row.status = status;
    clearItemStage(row);
    assert.equal(advanceItemStage(row, "searching_platforms"), false);
    assert.equal(row.stage, undefined);
    assert.equal(row.stageStartedAt, undefined);
    if (status === "queued") {
      row.status = "running";
      assert.equal(advanceItemStage(row, "reading_reference"), true);
    }
  }
});

test("saved stages round-trip through the API decoder and legacy snapshots remain readable", () => {
  const row = item();
  advanceItemStage(row, "searching_platforms");
  const now = new Date().toISOString();
  const run = {
    id: "00000000-0000-4000-8000-000000000001", status: "running",
    createdAt: now, updatedAt: now, heartbeatAt: now, workerId: "test-worker", resumeVersion: 100,
    stopRequested: false, estimatedCostUsd: 0, items: [row],
  };
  const restored = decodeBulkSnapshot({ state: JSON.stringify(run), stopVersion: 0 });
  assert.equal(restored.items[0].stage, "searching_platforms");
  assert.equal(restored.items[0].stageStartedAt, row.stageStartedAt);
  clearItemStage(row);
  assert.equal(GetBulkBrandRunResponse.parse(run).items[0].stage, undefined);
});

test("search and verification stages precede provider calls; a verifier timeout keeps candidates without retry", async () => {
  const originalFetch = globalThis.fetch;
  const stages: string[] = [];
  const calls: { target: string; stage: string | undefined; signal: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push({ target, stage: stages.at(-1), signal: init?.signal });
    if (target.includes("serper.dev")) {
      const query = JSON.parse(String(init?.body)).q as string;
      return Response.json({ organic: [{ title: "Example",
        link: query.includes("youtube.com") ? "https://www.youtube.com/@example" : "https://www.tiktok.com/@example",
        snippet: "Official Example profile" }] });
    }
    if (target.includes("find-social-profiles")) return Response.json({ profiles: [] });
    if (target.includes("scrapecreators.com")) {
      return Response.json(target.includes("youtube")
        ? { name: "Example", handle: "@example" }
        : { user: { uniqueId: "example", nickname: "Example" } });
    }
    throw new DOMException("Timed out", "TimeoutError");
  };
  try {
    const result = await findProfiles({
      subject: "Example", handle: "example", handlePlatform: "instagram",
      knownProfileUrl: "https://www.instagram.com/example/",
      referenceMetadata: { platform: "instagram", handle: "example", displayName: "Example", url: "https://www.instagram.com/example/" },
      excludeReferencePlatform: true, methods: ["serper"],
      serperApiKey: "test", scrapeCreatorsApiKey: "test", openrouterApiKey: "test",
      onProgress: stage => { stages.push(stage); },
    });
    assert.deepEqual(stages, ["searching_platforms", "verifying_candidates"]);
    assert.equal(calls.filter(call => call.target.includes("serper.dev")).length, 2);
    assert.equal(calls.filter(call => call.target.includes("find-social-profiles")).length, 1);
    assert.equal(calls.filter(call => call.target.includes("scrapecreators.com")).length, 3);
    assert.equal(calls.length, 6);
    for (const call of calls) {
      assert.ok(call.signal instanceof AbortSignal);
      assert.equal(call.stage, call.target.includes("serper.dev") || call.target.includes("find-social-profiles")
        ? "searching_platforms" : "verifying_candidates");
    }
    assert.equal(result.profiles.length, 2);
    assert.equal(result.methodsUsed.find(method => method.method === "jev")?.status, "failed");
  } finally { globalThis.fetch = originalFetch; }
});

test("empty searches do not announce candidate verification", async () => {
  const originalFetch = globalThis.fetch;
  const stages: string[] = [];
  globalThis.fetch = async () => Response.json({ organic: [] });
  try {
    const result = await findProfiles({
      subject: "Example", methods: ["serper"], serperApiKey: "test",
      onProgress: stage => { stages.push(stage); },
    });
    assert.deepEqual(stages, ["searching_platforms"]);
    assert.equal(result.profiles.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
