import { test } from "node:test";
import assert from "node:assert/strict";
import type { BulkBrandRun } from "@workspace/api-client-react";
import { summaryRunForKind, scopedRunProgress, runKinds } from "../../musician-social-finder/src/lib/bulk";

function run(id: string, kind: "brand" | "creator" | "artist", createdAt: string, status = "completed"): BulkBrandRun {
  return {
    id, status, createdAt, updatedAt: createdAt, scopes: [{ profileType: kind, limit: 10 }],
    items: [{ candidate: { profileId: 1, profileType: kind }, status: "completed" }],
  } as BulkBrandRun;
}

test("switching profile tabs chooses the matching run, never the globally remembered other type", () => {
  const runs = [
    run("brands", "brand", "2026-11-01"),
    run("creators", "creator", "2026-11-02"),
    run("artists", "artist", "2026-10-31"),
  ];
  assert.equal(summaryRunForKind(runs, "brand", "brands")?.id, "brands");
  assert.equal(summaryRunForKind(runs, "creator", "brands")?.id, "creators");
  assert.equal(summaryRunForKind(runs, "artist", "brands")?.id, "artists");
  assert.equal(summaryRunForKind(runs, "brand", "brands")?.id, "brands");
  assert.equal(summaryRunForKind([runs[0]], "artist", "brands"), undefined);
});

test("active matching runs take priority, explicit matching selection is honored, archive chunks are excluded", () => {
  const old = run("older", "artist", "2026-10-01", "running");
  const newest = run("newest", "artist", "2026-11-02");
  const archive = { ...run("chunk", "artist", "2026-11-03"), archiveOf: "older" };
  assert.equal(summaryRunForKind([newest, old, archive], "artist")?.id, "older");
  assert.equal(summaryRunForKind([newest, old, archive], "artist", "newest")?.id, "newest");
});

test("multi-type current and archived counts remain separate; shared cap is not a per-type denominator", () => {
  const mixed = {
    ...run("mixed", "brand", "2026-11-02"),
    scopes: [{ profileType: "brand", limit: 10 }, { profileType: "artist", limit: 10 }],
    items: [
      { candidate: { profileType: "brand" }, status: "completed" },
      { candidate: { profileType: "brand" }, status: "failed" },
      { candidate: { profileType: "brand" }, status: "running" },
      { candidate: { profileType: "artist" }, status: "completed" },
      { candidate: { profileType: "artist" }, status: "queued" },
    ],
    continuous: {
      profileLimit: 500, completed: 120, failed: 13,
      cursors: [
        { profileType: "brand", completed: 100, failed: 10, exhausted: false },
        { profileType: "artist", completed: 20, failed: 3, exhausted: false },
      ],
    },
  } as BulkBrandRun;
  const brands = scopedRunProgress(mixed, "brand");
  const artists = scopedRunProgress(mixed, "artist");
  assert.deepEqual(brands.current, { completed: 1, failed: 1, skipped: 0, running: 1, queued: 0, total: 3 });
  assert.equal(brands.processed, 112);
  assert.equal(brands.overall.completed, 101);
  assert.equal(artists.processed, 24);
  assert.equal(artists.overall.failed, 3);
  assert.equal(artists.current.queued, 1);
  assert.equal(artists.current.running, 0);
  assert.equal(artists.current.total, 2);
  assert.equal(brands.cap, undefined);
  assert.equal(artists.cap, undefined);
  assert.equal(artists.sharedCap, 500);
});

test("single-type continuous runs retain their cap and archived totals even with an empty current chunk", () => {
  const single = {
    ...run("single", "artist", "2026-11-02"), items: [],
    continuous: { profileLimit: 500, completed: 24, failed: 2,
      cursors: [{ profileType: "artist", completed: 24, failed: 2, exhausted: false }] },
  } as BulkBrandRun;
  const counts = scopedRunProgress(single, "artist");
  assert.equal(counts.processed, 26);
  assert.equal(counts.cap, 500);
  assert.equal(counts.current.total, 0);
});

test("continuous cursor identity survives empty chunks and legacy untyped items remain brands", () => {
  const cursorOnly = {
    ...run("cursor", "brand", "2026-11-02"), scopes: undefined, items: [],
    continuous: { cursors: [{ profileType: "creator", completed: 3, failed: 1 }] },
  } as BulkBrandRun;
  assert.deepEqual(runKinds(cursorOnly), ["creator"]);
  assert.equal(summaryRunForKind([cursorOnly], "creator")?.id, "cursor");
  const legacy = { ...run("legacy", "brand", "2026-11-02"), scopes: undefined,
    items: [{ candidate: { profileId: 2 }, status: "failed" }] } as BulkBrandRun;
  assert.deepEqual(runKinds(legacy), ["brand"]);
  assert.equal(scopedRunProgress(legacy, "brand").processed, 1);
  assert.equal(summaryRunForKind([legacy], "artist"), undefined);
});
