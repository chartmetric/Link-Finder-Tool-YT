import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, SearchProfilesResponse, type BulkBrandCandidate, type BulkBrandRun, type BulkProfileType } from "@workspace/api-zod";
import { commitContinuousArchive, continuousArchive, continuousLimitReached, nextContinuousChunk, type ContinuousProgress } from "../src/lib/bulk-continuous.ts";
import { validateBulkSelection } from "../src/lib/bulk-profile-scopes.ts";
import { eligibleBrandSql } from "../src/lib/bulk-brand-candidates.ts";

const scopes = [{ profileType: "brand" as const, limit: 1 }];
const fresh = (): ContinuousProgress => ({
  upperProfileId: 100, batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
  cursors: [{ profileType: "brand", afterId: 0, exhausted: false, completed: 0, failed: 0 }],
});
const candidate = (id: number, profileType: BulkProfileType = "brand", runnable = true): BulkBrandCandidate => ({
  profileId: id, profileName: `Profile ${id}`, profileType, tier: null, tierRank: null,
  accountId: String(id), handle: `profile${id}`, platform: "instagram",
  url: runnable ? `https://www.instagram.com/profile${id}/` : "", canInvestigate: runnable,
});
const response = (profiles: BulkBrandCandidate[], hasMore = false) => ({
  profiles, hasMore, nextAfterId: profiles.at(-1)?.profileId ?? 0, maxBatchSize: 25,
});
const noPriorAttempts = async () => new Set<number>();
function root(): BulkBrandRun {
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000000001", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    workerId: "test", resumeVersion: 1, stopRequested: false, estimatedCostUsd: 0, scopes,
    continuous: fresh(), items: [],
  });
}
const result = () => SearchProfilesResponse.parse({
  subject: "Test", query: "Test", searchedAt: new Date().toISOString(), profiles: [], sources: [],
  totalFound: 0, highConfidenceCount: 0, estimatedCostUsd: 0.01, methodsUsed: [],
});

test("continuous launch requires scopes and validates optional total profile caps", () => {
  assert.ok(validateBulkSelection({ continuous: true, profileIds: [1] }));
  assert.ok(validateBulkSelection({ scopes, profileLimit: 2 }));
  assert.ok(validateBulkSelection({ scopes, continuous: true, profileLimit: 1.5 }));
  assert.ok(validateBulkSelection({ scopes, continuous: true, profileLimit: 0 }));
  assert.equal(validateBulkSelection({ paidAcknowledged: true, scopes, continuous: true, profileLimit: 2 }), undefined);
});

test("a requested chunk can actually fill all 1000 slots through bounded catalog pages", async () => {
  const state = fresh();
  state.upperProfileId = 2000;
  let reads = 0;
  const next = await nextContinuousChunk(state, [{ profileType: "brand", limit: 1000 }], async input => {
    reads++;
    assert.ok(input.limit <= 250);
    return response(Array.from({ length: input.limit }, (_, i) => candidate((input.afterId ?? 0) + i + 1)), true);
  }, noPriorAttempts);
  assert.equal(next.candidates.length, 1000);
  assert.equal(new Set(next.candidates.map(row => row.profileId)).size, 1000);
  assert.equal(next.cursors[0].afterId, 1000);
  assert.equal(reads, 4);
});

test("remaining selection skips attempted and unlinked profiles without skipping the next unconsumed candidate", async () => {
  const state = fresh();
  const next = await nextContinuousChunk(state, scopes,
    async input => {
      assert.equal(input.maxProfileId, 100);
      return response([candidate(1, "brand", false), candidate(2), candidate(3), candidate(4)]);
    },
    async () => new Set([2]));
  assert.deepEqual(next.candidates.map(row => row.profileId), [3]);
  assert.equal(next.cursors[0].afterId, 3);
  assert.equal(next.cursors[0].exhausted, false);
  assert.equal(state.cursors[0].afterId, 0, "live checkpoint is not mutated until selection succeeds");
});

test("duplicate catalog identities across types cannot be billed twice in one chunk", async () => {
  const state = fresh();
  state.cursors.push({ profileType: "artist", afterId: 0, exhausted: false, completed: 0, failed: 0 });
  const next = await nextContinuousChunk(state, [...scopes, { profileType: "artist", limit: 1 }],
    async input => response(input.profileType === "brand" ? [candidate(1)] : [candidate(1, "artist"), candidate(2, "artist")]), noPriorAttempts);
  assert.deepEqual(next.candidates.map(row => row.profileId), [1, 2]);
  assert.ok(next.cursors.every(cursor => cursor.exhausted));
});

test("empty bounded scan windows advance durably without falsely declaring catalog exhaustion", async () => {
  const next = await nextContinuousChunk(fresh(), scopes, async input =>
    response([candidate((input.afterId ?? 0) + 1, "brand", false)], true), noPriorAttempts);
  assert.equal(next.candidates.length, 0);
  assert.equal(next.cursors[0].afterId, 4);
  assert.equal(next.cursors[0].exhausted, false);
});

test("empty final pages complete a scope and failed history reads cannot fall back to paid repeats", async () => {
  const state = fresh();
  const next = await nextContinuousChunk(state, scopes, async () => response([]), noPriorAttempts);
  assert.equal(next.cursors[0].exhausted, true);
  await assert.rejects(nextContinuousChunk(state, scopes, async () => response([candidate(1)]),
    async () => { throw new Error("history unavailable"); }), /history unavailable/);
  assert.equal(state.cursors[0].afterId, 0);
});

test("bad pagination stops the selector instead of looping or starting repeated work", async () => {
  await assert.rejects(nextContinuousChunk(fresh(), scopes, async () => response([], true), noPriorAttempts), /did not advance/);
  const state = fresh();
  state.cursors[0].afterId = 5;
  await assert.rejects(nextContinuousChunk(state, scopes, async () => response([candidate(4)]), noPriorAttempts), /backwards/);
});

test("a total profile cap is respected across chunks even when the catalog has millions remaining", async () => {
  const run = root();
  run.continuous!.profileLimit = 2;
  const fakePage = async (input: { afterId?: number }) =>
    response([1, 2, 3, 4].filter(id => id > (input.afterId ?? 0)).map(id => candidate(id)), true);
  const charged: number[] = [];
  const archiveIds: string[] = [];
  for (let i = 0; !continuousLimitReached(run.continuous!) && i < 5; i++) {
    const next = await nextContinuousChunk(run.continuous!, scopes, fakePage, noPriorAttempts);
    run.continuous!.cursors = next.cursors;
    run.items = next.candidates.map(row => {
      charged.push(row.profileId);
      return { candidate: row, status: "completed", platforms: [], result: result() };
    });
    const archive = continuousArchive(run);
    archiveIds.push(archive.id);
    assert.equal(GetBulkBrandRunResponse.parse(archive).archiveOf, run.id);
    commitContinuousArchive(run);
  }
  assert.deepEqual(charged, [1, 2]);
  assert.equal(new Set(archiveIds).size, 2);
  assert.equal(run.continuous!.batches, 2);
  assert.equal(run.continuous!.completed, 2);
  assert.equal(run.continuous!.completedCostUsd, 0.02);
  assert.equal(run.items.length, 0, "root snapshots remain bounded to current chunk");
  assert.equal(run.continuous!.cursors[0].exhausted, false, "cap completion is distinct from catalog exhaustion");
});

test("caps apply across types and failed profiles count toward the total", async () => {
  const state = fresh();
  state.profileLimit = 2;
  state.completed = 1;
  state.cursors.push({ profileType: "artist", afterId: 0, exhausted: false, completed: 0, failed: 0 });
  const next = await nextContinuousChunk(state, [{ profileType: "brand", limit: 10 }, { profileType: "artist", limit: 10 }],
    async input => response([candidate(1, input.profileType), candidate(2, input.profileType)]), noPriorAttempts);
  assert.equal(next.candidates.length, 1);
  const run = root();
  run.continuous = state;
  run.items = [{ candidate: next.candidates[0], status: "failed", platforms: [], error: "provider timeout" }];
  commitContinuousArchive(run);
  assert.equal(continuousLimitReached(run.continuous!), true);
  assert.equal(run.continuous!.failed, 1);
});

test("archive identity is deterministic after a crash and committing preserves counts without double counting", () => {
  const run = root();
  run.items = [
    { candidate: candidate(1), status: "completed", platforms: [], result: result() },
    { candidate: candidate(2), status: "failed", platforms: [], error: "timeout" },
  ];
  const archive = continuousArchive(run);
  const retry = continuousArchive(GetBulkBrandRunResponse.parse(JSON.parse(JSON.stringify(run))));
  assert.equal(archive.id, retry.id);
  assert.notEqual(archive.id, run.id);
  assert.equal(archive.batchNumber, 1);
  assert.equal(archive.items.length, 2);
  assert.equal(archive.continuous, undefined);
  commitContinuousArchive(run);
  assert.equal(run.continuous!.completed, 1);
  assert.equal(run.continuous!.failed, 1);
  assert.equal(run.continuous!.cursors[0].completed, 1);
  assert.equal(run.items.length, 0);
  assert.equal(archive.items.length, 2, "clearing root does not clear the saved archive");
});

test("continuous catalog scanning has a parameter-bound frozen upper ID", () => {
  assert.match(eligibleBrandSql(false, true), /id <= \{upperId:UInt64\}/);
  assert.doesNotMatch(eligibleBrandSql(), /upperId/);
});
