import test from "node:test";
import assert from "node:assert/strict";
import { checkpointCounts, progressTotals, readArtistCampaignFiles } from "../src/lib/artist-campaign-progress";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { GetArtistCampaignProgressResponse } from "@workspace/api-zod";

test("processed progress uses the whole queue; success rate uses completed identity checks", () => {
  const result = progressTotals(1000, { processed: 100, checked: 90, likely: 45, reserved: 382 }, "running", new Date().toISOString());
  assert.equal(result.processedPercent, 10);
  assert.equal(result.successRate, 50);
  assert.equal(result.incompleteArtists, 10);
  assert.equal(result.notAcceptedArtists, 45);
  assert.equal(result.reservedUsd, 3.82);
});
test("metadata alone is not processed; failed captures count as processed but never as successful", () => {
  assert.equal(checkpointCounts({ candidates: [{ status: "inconclusive", metadata: { available: true } }] }).processed, 0);
  assert.deepEqual(checkpointCounts({ candidates: [{ status: "unavailable" }] }),
    { processed: 1, checked: 0, likely: 0, reserved: 0 });
  assert.equal(checkpointCounts({ candidates: [{ recordedAnswer: {}, review: { reviewSuggestion: true } }] }).likely, 1);
});
test("no checks means no success percentage; stale progress and invalid totals are explicit", () => {
  assert.equal(progressTotals(100, { processed: 0, checked: 0, likely: 0, reserved: 0 }, "running", "2020-01-01").successRate, null);
  assert.equal(progressTotals(100, { processed: 1, checked: 1, likely: 1, reserved: 4 }, "running", "2020-01-01").stale, true);
  assert.throws(() => progressTotals(10, { processed: 1, checked: 2, likely: 1, reserved: 4 }, "running", "2020-01-01"));
});
test("live reads keep terminal counts, tolerate partial writes, and never count the same chunk twice", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "campaign-progress-"));
  const root = path.join(workspace, "generated-artifacts/next-saved-full-tiers-1-5-usd100");
  const dir = "generated-artifacts/next-saved-full-tiers-1-5-usd100-chunk-001";
  const file = path.join(workspace, dir, "execution/artist-checkpoints.jsonl");
  const json = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value));
  try {
    await mkdir(root, { recursive: true }); await mkdir(path.dirname(file), { recursive: true });
    await json("approval.json", { eligibleArtists: 1000 });
    await json("progress.json", { status: "running", activeChunk: dir });
    const first = { changes: [
      { profileId: "1", cmArtist: "101", candidates: [{ recordedAnswer: {}, review: { reviewSuggestion: true } }] },
      { profileId: "2", cmArtist: "102", candidates: [{ status: "unavailable" }] },
      { profileId: "3", cmArtist: "103", candidates: [{ status: "uninspected" }] },
    ], budget: { reservedCents: 6 } };
    await writeFile(file, JSON.stringify(first) + "\n" + '{"changes":');
    const live = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(live.processedArtists, 2); assert.equal(live.checkedArtists, 1);
    assert.equal(live.successRate, 100); assert.equal(live.incompleteArtists, 1);
    await appendFile(file, '[],"budget":{"reservedCents":8}}\n');
    const advanced = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(advanced.processedArtists, 2); assert.equal(advanced.reservedUsd, 0.08);
    await json("chunks.json", [{ dir, summary: {
      status: "completed", artistRecords: 3, evaluatedArtists: 2, likelyReviewArtists: 1, conservativeReservedCents: 10,
    } }]);
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 2);
    await json("chunks.json", [{ dir, summary: { status: "stopped", artistRecords: 500 } }]);
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 2);
    await json("progress.json", { status: "stopped", processedArtists: 500 });
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 2);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("tier details join frozen identities across completed and active chunks, not scope rows or current tiers", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "campaign-tiers-"));
  const root = path.join(workspace, "generated-artifacts/next-saved-full-tiers-1-5-usd100");
  const dir = (n: number) => `generated-artifacts/next-saved-full-tiers-1-5-usd100-chunk-00${n}`;
  const json = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value));
  const queue = [1, 2, 3, 4, 5, 6, 7].map((n, i) => ({
    profile_id: String(n), cm_artist: String(n + 100), tier: [1, 2, 2, 3, 4, 5, 5][i],
  }));
  const artist = (n: number, candidate: unknown) => ({
    profileId: String(n), cmArtist: String(n + 100), tier: 5, candidates: [candidate],
  });
  const packet = (changes: unknown[], reservedCents: number) => JSON.stringify({ changes, budget: { reservedCents } }) + "\n";
  const completed = packet([
    artist(1, { recordedAnswer: {}, review: { reviewSuggestion: true } }),
    artist(2, { recordedAnswer: {}, review: { reviewSuggestion: false } }),
    artist(3, { recordedAnswer: {}, review: { reviewSuggestion: true } }),
    artist(4, { status: "unsupported" }),
  ], 10);
  const active = packet([
    artist(5, { reason: "interrupted_or_uncertain_no_retry" }),
    artist(6, { status: "inconclusive", metadata: { available: true } }),
  ], 4);
  try {
    await mkdir(root, { recursive: true });
    await json("queue.json", queue);
    await json("approval.json", { eligibleArtists: queue.length,
      queueSha256: createHash("sha256").update(JSON.stringify(queue)).digest("hex") });
    await json("progress.json", { status: "running", activeChunk: dir(2), activeChunkArtists: 500 });
    await json("chunks.json", [{ dir: dir(1), summary: {
      status: "completed", artistRecords: 500, evaluatedArtists: 500, likelyReviewArtists: 500,
    } }]);
    for (const [n, content] of [[1, completed], [2, active]] as const) {
      await mkdir(path.join(workspace, dir(n), "execution"), { recursive: true });
      await writeFile(path.join(workspace, dir(n), "execution/artist-checkpoints.jsonl"), content);
    }
    const result = await readArtistCampaignFiles(root, workspace);
    // Local evidence is enriched with shared identity/freshness by the snapshot reader.
    GetArtistCampaignProgressResponse.parse({ progress: { ...result.progress,
      campaignId: "fixture", queueSha256: "fixture", capturedAt: new Date().toISOString(),
      workerEnvironment: "workspace", workerStatus: "recent_activity" } });
    const p = result.progress!;
    assert.equal(p.processedArtists, 5);
    assert.equal(p.checkedArtists, 3);
    assert.equal(p.likelyMatches, 2);
    assert.equal(p.reservedUsd, 0.14);
    const tiers = p.tierBreakdown!;
    assert.deepEqual(tiers.map(t => t.tier), [1, 2, 3, 4, 5]);
    assert.deepEqual(tiers.map(t => t.totalArtists), [1, 2, 1, 1, 2]);
    assert.deepEqual(tiers.map(t => t.processedArtists), [1, 2, 1, 1, 0]);
    assert.deepEqual(tiers.map(t => t.successRate), [100, 50, null, null, null]);
    assert.deepEqual(tiers.map(t => t.incompleteArtists), [0, 0, 1, 1, 0]);
    for (const key of ["totalArtists", "processedArtists", "checkedArtists", "likelyMatches", "notAcceptedArtists", "incompleteArtists"] as const)
      assert.equal(tiers.reduce((sum, t) => sum + t[key], 0), p[key]);
    // A later checkpoint replaces, rather than double counts, the same artist.
    await appendFile(path.join(workspace, dir(2), "execution/artist-checkpoints.jsonl"),
      packet([artist(6, { recordedAnswer: {}, review: { reviewSuggestion: true } })], 6));
    const next = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(next.tierBreakdown![4].processedArtists, 1);
    assert.equal(next.tierBreakdown![4].successRate, 100);
    assert.equal(next.checkedArtists, 4);
    // An active pointer also listed as a stopped chunk must not count twice.
    await json("chunks.json", [{ dir: dir(1), summary: { status: "completed" } },
      { dir: dir(2), summary: { status: "stopped", artistRecords: 500 } }]);
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 6);
    // Frozen binding failures leave exact headline counts but never guessed tiers.
    queue[0].cm_artist = "999";
    await json("queue.json", queue);
    await json("approval.json", { eligibleArtists: queue.length,
      queueSha256: createHash("sha256").update(JSON.stringify(queue)).digest("hex") });
    const unbound = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(unbound.processedArtists, 6);
    assert.equal(unbound.tierBreakdown, undefined);
    assert.match(unbound.tierBreakdownUnavailableReason!, /could not be verified/);
    // Duplicate cross-chunk identities cannot inflate either totals or tiers.
    await appendFile(path.join(workspace, dir(2), "execution/artist-checkpoints.jsonl"),
      packet([artist(1, { status: "unavailable" })], 6));
    await assert.rejects(readArtistCampaignFiles(root, workspace), /Duplicate campaign artist/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("empty tiers remain explicit; missing or invalid frozen queues never become zero tier counts", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "campaign-empty-tiers-"));
  const root = path.join(workspace, "campaign");
  const json = (name: string, value: unknown) => writeFile(path.join(root, name), JSON.stringify(value));
  try {
    await mkdir(root);
    assert.deepEqual(await readArtistCampaignFiles(root, workspace), { progress: null });
    await json("approval.json", { eligibleArtists: 0, queueSha256: createHash("sha256").update("[]").digest("hex") });
    await json("progress.json", { status: "running" });
    assert.match((await readArtistCampaignFiles(root, workspace)).progress!.tierBreakdownUnavailableReason!, /unavailable/);
    await json("queue.json", []);
    const p = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(p.tierBreakdown!.length, 5);
    assert.ok(p.tierBreakdown!.every(t => t.totalArtists === 0 && t.processedPercent === 0 && t.successRate === null));
    await json("queue.json", [{ profile_id: "1", cm_artist: "101", tier: 9 }]);
    const invalid = (await readArtistCampaignFiles(root, workspace)).progress!;
    assert.equal(invalid.tierBreakdown, undefined);
    assert.equal(invalid.processedArtists, 0);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
