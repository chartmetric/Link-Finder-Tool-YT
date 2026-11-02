import { test } from "node:test";
import assert from "node:assert/strict";
import type { BulkBrandItem, BulkPlatformOutcome } from "@workspace/api-client-react";
import { platformSearchStatus, profileSearchStatus } from "../../musician-social-finder/src/lib/bulk-result-status";

const platforms = ["Instagram", "TikTok", "YouTube"];
const outcome = (platform: string, status: BulkPlatformOutcome["status"], evidenceUrls: string[] = []): BulkPlatformOutcome =>
  ({ platform, status, evidenceUrls, checkedAt: "2026-11-02T00:00:00Z", reason: "Saved assessment." });
const finished = (rows: BulkPlatformOutcome[]): Pick<BulkBrandItem, "status" | "platforms"> => ({ status: "completed", platforms: rows });

test("finished jobs with all searches incomplete are never presented as completed or as no accounts", () => {
  const item = finished(platforms.map(p => outcome(p, "incomplete")));
  const before = JSON.stringify(item);
  const status = profileSearchStatus(item);
  assert.equal(status.label, "Search incomplete");
  assert.equal(status.tone, "incomplete");
  assert.match(status.description, /Instagram, TikTok, YouTube.*unresolved/);
  assert.match(platformSearchStatus(item.platforms[0]).description, /exists is unknown/);
  assert.equal(JSON.stringify(item), before, "presentation must not alter saved queue state or retry behavior");
});

test("mixed search successes and failures are partial results, not a green completed card", () => {
  const status = profileSearchStatus(finished([
    outcome("Instagram", "reference"), outcome("TikTok", "found"), outcome("YouTube", "incomplete"),
  ]));
  assert.equal(status.label, "Partial results");
  assert.equal(status.tone, "partial");
});

test("finished searches with no supported match do not assert absence", () => {
  const item = finished(platforms.map(p => outcome(p, "not_found")));
  assert.equal(profileSearchStatus(item).label, "No supported matches");
  assert.equal(profileSearchStatus(item).tone, "finished");
  assert.match(platformSearchStatus(item.platforms[0]).description, /does not confirm/);
});

test("only sourced first-party absence is distinguished from unknown availability", () => {
  const sourced = outcome("Instagram", "explicit_unavailable", ["https://example.com/trusted-profile"]);
  assert.equal(platformSearchStatus(sourced).label, "No account reported");
  assert.match(platformSearchStatus(sourced).description, /trusted profile explicitly reports/);
  for (const evidence of [[], [""], ["javascript:alert(1)"]]) {
    const unsourced = outcome("Instagram", "explicit_unavailable", evidence);
    assert.equal(platformSearchStatus(unsourced).label, "Absence unverified");
    const item = finished([unsourced, outcome("TikTok", "reference"), outcome("YouTube", "reference")]);
    assert.equal(profileSearchStatus(item).label, "Needs review");
  }
  assert.equal(profileSearchStatus(finished(platforms.map(p => ({ ...sourced, platform: p })))).label, "Resolved with sources");
});

test("legacy completed cards missing platform assessments remain unresolved", () => {
  for (const rows of [[], [outcome("Instagram", "reference")]]) {
    const status = profileSearchStatus(finished(rows));
    assert.equal(status.label, "Search incomplete");
    assert.match(status.description, /no saved assessment/);
  }
});

test("queue states and review-only outcomes retain their distinct meaning", () => {
  for (const status of ["queued", "running", "failed"] as const) {
    assert.equal(profileSearchStatus({ status, platforms: [] }).label, { queued: "Queued", running: "Searching", failed: "Job failed" }[status]);
  }
  assert.equal(profileSearchStatus(finished(platforms.map(p => outcome(p, "needs_review")))).label, "Needs review");
  assert.equal(profileSearchStatus(finished(platforms.map(p => outcome(p, "found")))).label, "Links found");
});
