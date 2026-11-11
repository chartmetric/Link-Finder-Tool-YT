import test from "node:test";
import assert from "node:assert/strict";
import { checkpointCounts, progressTotals, readArtistCampaignFiles } from "../src/lib/artist-campaign-progress";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
      { profileId: "1", candidates: [{ recordedAnswer: {}, review: { reviewSuggestion: true } }] },
      { profileId: "2", candidates: [{ status: "unavailable" }] },
      { profileId: "3", candidates: [{ status: "uninspected" }] },
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
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 3);
    await json("chunks.json", [{ dir, summary: { status: "stopped", artistRecords: 500 } }]);
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 2);
    await json("progress.json", { status: "stopped", processedArtists: 500 });
    assert.equal((await readArtistCampaignFiles(root, workspace)).progress!.processedArtists, 2);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
