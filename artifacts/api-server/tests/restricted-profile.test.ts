import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, type BulkBrandRun } from "@workspace/api-zod";
import { isRestrictedInstagramProfile, RestrictedProfileError } from "../src/lib/restricted-profile";
import { resolveKnownProfileIdentity } from "../src/lib/musician-search";
import { BulkOwnership, selectionFingerprint } from "../src/lib/bulk-ownership";
import { executeBulkRun } from "../src/lib/bulk-worker";
import { MemoryStore } from "./helpers/bulk-memory-store";
import { commitContinuousArchive, continuousLimitReached } from "../src/lib/bulk-continuous";
import { canResume, overallCounts, overallKindCounts } from "../../musician-social-finder/src/lib/bulk";
import { profileSearchStatus } from "../../musician-social-finder/src/lib/bulk-result-status";

const restricted = { success: true, error: "forbidden", errorStatus: 403, age_restricted: true, message: "Profile is age restricted" };
const audienceRestricted = { success: true, error: "not_found", errorStatus: 404, message: "Profile is restricted" };

test("only explicit Instagram restrictions are skipped, never generic failures or absence", () => {
  assert.equal(isRestrictedInstagramProfile(403, restricted), true);
  assert.equal(isRestrictedInstagramProfile(404, audienceRestricted), true);
  assert.equal(isRestrictedInstagramProfile(200, { ...audienceRestricted, success: false }), true);
  for (const [status, body] of [
    [403, { message: "Forbidden" }],
    [403, { error: { message: "Invalid API key" } }],
    [404, { error: "not_found", errorStatus: 404, message: "Profile is unavailable on Instagram" }],
    [404, { error: "not_found", errorStatus: 404, message: "Account doesn't exist" }],
    [500, restricted], [429, restricted], [403, undefined],
  ] as const) assert.equal(isRestrictedInstagramProfile(status, body), false);
});

test("confirmed restricted metadata makes one request and never falls through to search", async t => {
  let calls = 0;
  let response = Response.json(restricted, { status: 403 });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    assert.match(url, /api\.scrapecreators\.com\/v1\/instagram\/profile/);
    return response;
  });
  for (const [status, body] of [[403, restricted], [404, audienceRestricted], [200, { ...audienceRestricted, success: false }]] as const) {
    response = Response.json(body, { status });
    await assert.rejects(resolveKnownProfileIdentity("https://www.instagram.com/restrictedbrand/", "test-key"),
      error => error instanceof RestrictedProfileError && /Availability remains unknown/i.test(error.message));
  }
  assert.equal(calls, 3, "one call per profile; no retries or other providers");
});

function fixture(): BulkBrandRun {
  const now = new Date().toISOString();
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000009901", status: "running", createdAt: now, updatedAt: now,
    heartbeatAt: now, workerId: "unclaimed", resumeVersion: 0, stopRequested: false, estimatedCostUsd: 0,
    items: [1, 2, 3].map(id => ({
      candidate: { profileId: id, profileName: `Brand ${id}`, accountId: `account-${id}`,
        platform: "instagram", handle: `brand${id}`, url: `https://www.instagram.com/brand${id}/`,
        tier: null, tierRank: null },
      status: "queued", platforms: [],
    })),
  });
}

test("restricted profiles persist as skipped, queue continues, and resume never retries them", async () => {
  const owner = new BulkOwnership(new MemoryStore());
  const run = fixture();
  const first = await owner.claim(run, "worker", selectionFingerprint([1, 2, 3]));
  const calls: number[] = [];
  await executeBulkRun(first.run, first.lease!, {
    ownership: owner, archive: async saved => { GetBulkBrandRunResponse.parse(saved); },
    saveHistory: async () => {}, warn: error => { throw error; },
    processItem: async item => {
      calls.push(item.candidate.profileId);
      if (item.candidate.profileId === 1) throw new RestrictedProfileError();
      if (item.candidate.profileId === 2) throw new Error("Metadata lookup failed (500)");
      item.status = "completed";
    },
  });
  const saved = (await owner.read(run.id))[0];
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.items.map(item => item.status), ["skipped", "failed", "completed"]);
  assert.equal(saved.items[0].retryBlocked, true);
  assert.ok(saved.items[0].platforms.every(outcome => outcome.status === "incomplete" && !outcome.evidenceUrls.length));
  assert.equal(profileSearchStatus(saved.items[0]).label, "Skipped · restricted");
  assert.deepEqual(overallCounts(saved), { queued: 0, running: 0, completed: 1, failed: 1, skipped: 1 });
  const resumed = await owner.claim(saved, "worker-next", "", saved.resumeVersion);
  assert.deepEqual(resumed.run.items.map(item => item.status), ["skipped", "queued", "completed"]);
  const resumedCalls: number[] = [];
  await executeBulkRun(resumed.run, resumed.lease!, {
    ownership: owner, archive: async () => {}, saveHistory: async () => {}, warn: error => { throw error; },
    processItem: async item => { resumedCalls.push(item.candidate.profileId); item.status = "completed"; },
  });
  assert.deepEqual(resumedCalls, [2]);
  assert.equal(canResume((await owner.read(run.id))[0]), false);
});

test("skipped profiles survive continuous archival and count toward the profile cap, not success", () => {
  const run = fixture();
  run.items = [{ ...run.items[0], status: "skipped", retryBlocked: true }];
  run.continuous = {
    upperProfileId: 100, profileLimit: 1, batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
    cursors: [{ profileType: "brand", afterId: 1, exhausted: false, completed: 0, failed: 0 }],
  };
  commitContinuousArchive(run);
  assert.equal(run.continuous.skipped, 1);
  assert.equal(run.continuous.completed, 0);
  assert.equal(run.continuous.failed, 0);
  assert.equal(continuousLimitReached(run.continuous), true);
  assert.equal(overallKindCounts(run, "brand").skipped, 1);
});
