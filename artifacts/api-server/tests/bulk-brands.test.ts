import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, SearchProfilesResponse, type ProfileMatch } from "@workspace/api-zod";
import { eligibleBrandSql } from "../src/lib/bulk-brand-candidates.ts";
import { derivePlatformOutcomes, explicitAbsenceStatement } from "../src/lib/bulk-platform-outcomes.ts";
import { decodeBulkSnapshot, mergeBulkRunView } from "../src/lib/bulk-run-store.ts";

const url = "https://www.instagram.com/testbrand/";
function result(options: { failed?: boolean; bio?: string; web?: boolean; profiles?: ProfileMatch[] } = {}) {
  return SearchProfilesResponse.parse({
    subject: "Test Brand", query: "Test Brand", searchedAt: new Date().toISOString(),
    profiles: options.profiles ?? [], sources: [], totalFound: options.profiles?.length ?? 0,
    highConfidenceCount: 0, estimatedCostUsd: 0.01,
    referenceProfile: { platform: options.web ? "web" : "instagram", handle: "testbrand", url, bio: options.bio },
    methodsUsed: ["serper", "gemini"].map(method => ({
      method, label: method, costNote: "Test fixture",
      status: options.failed && method === "gemini" ? "failed" : "used",
      durationMs: 5, results: [], estimatedCostUsd: 0.005,
    })),
  });
}
function candidate(extra: Partial<ProfileMatch> = {}): ProfileMatch {
  return { platform: "TikTok", category: "social", title: "Brand", url: "https://www.tiktok.com/@testbrand",
    displayUrl: "tiktok.com/@testbrand", snippet: "", confidence: 90, signals: [], methods: ["serper"], ...extra };
}

test("eligible selection is brands across all tiers, latest versions, one distinct active account", () => {
  const sql = eligibleBrandSql();
  assert.match(sql, /profile_type = 'brand'/);
  assert.doesNotMatch(sql, /tier BETWEEN|pt\.tier\s*=/);
  assert.match(sql, /argMax\(tuple\(tier, tier_rank\)/);
  assert.match(sql, /argMax\(tuple\(profile_id, account_id, disconnected_at\), modified_at\)/);
  assert.match(sql, /HAVING uniqExact\(a.id\) = 1/);
  assert.match(sql, /tupleElement\(account, 4\) = 1/);
  assert.match(eligibleBrandSql(true), /profile IN \{ids:Array\(UInt64\)\}/);
  assert.doesNotMatch(sql, /INSERT|ALTER|DELETE|UPDATE|DROP|TRUNCATE/);
});

test("completed searches without candidates mean not found, never confirmed unavailable", () => {
  const outcomes = derivePlatformOutcomes(result(), "instagram");
  assert.equal(outcomes.find(o => o.platform === "Instagram")?.status, "reference");
  assert.equal(outcomes.find(o => o.platform === "TikTok")?.status, "not_found");
  assert.equal(outcomes.find(o => o.platform === "YouTube")?.status, "not_found");
  assert.match(outcomes[1].reason, /not proof/);
});

test("failed or unavailable discovery is incomplete, not absence", () => {
  const outcomes = derivePlatformOutcomes(result({ failed: true }), "instagram");
  assert.equal(outcomes[1].status, "incomplete");
  assert.equal(outcomes[2].status, "incomplete");
});

test("explicit first-party no-account statements include the reference source and timestamp", () => {
  const outcomes = derivePlatformOutcomes(result({ bio: "We are not on TikTok. All updates are here." }), "instagram");
  const tiktok = outcomes.find(o => o.platform === "TikTok")!;
  assert.equal(tiktok.status, "explicit_unavailable");
  assert.deepEqual(tiktok.evidenceUrls, [url]);
  assert.ok(Date.parse(tiktok.checkedAt));
  assert.match(tiktok.reason, /not a guarantee/);
  assert.equal(outcomes.find(o => o.platform === "YouTube")?.status, "not_found");
});

test("Google snippets and quoted or conditional claims cannot confirm account absence", () => {
  assert.equal(derivePlatformOutcomes(result({ web: true, bio: "We are not on TikTok." }), "web")[1].status, "not_found");
  for (const text of ['"We are not on TikTok"', "If we are not on TikTok, ask us", "We are not on TikTok but that may change"]) {
    assert.equal(explicitAbsenceStatement(text, "TikTok"), undefined);
  }
  assert.ok(explicitAbsenceStatement("We do not have an official YouTube account", "YouTube"));
  assert.equal(explicitAbsenceStatement("We are not on TikTok", "Instagram"), undefined);
});

test("found accounts require identity support and retain confirmed URL aliases", () => {
  const p = candidate({
    urlAliases: ["https://www.tiktok.com/@testbrand", "https://www.tiktok.com/@testbrand/"],
    jevVerification: { verdict: "likely", sameIdentityProbability: 0.9, verdictConfidence: 0.8, probabilities: {} },
  });
  const outcome = derivePlatformOutcomes(result({ profiles: [p] }), "instagram")[1];
  assert.equal(outcome.status, "found");
  assert.equal(outcome.evidenceUrls.length, 2);
});

test("discovery-only candidates and uncertain JEV remain reviewable, not absence", () => {
  assert.equal(derivePlatformOutcomes(result({ profiles: [candidate()] }), "instagram")[1].status, "needs_review");
  const metadata = { platform: "instagram", handle: "testbrand", url };
  const uncertain = candidate({
    identityComparison: { status: "mismatch", score: 10, reasons: [], reference: metadata, candidate: metadata },
    jevVerification: { verdict: "uncertain", sameIdentityProbability: 0.5, verdictConfidence: 0.5, probabilities: {} },
  });
  assert.equal(derivePlatformOutcomes(result({ profiles: [uncertain] }), "instagram")[1].status, "needs_review");
});

test("rejected candidates are preserved as evidence but never approved", () => {
  const rejected = candidate({ jevVerification: { verdict: "mismatch", sameIdentityProbability: 0.1, verdictConfidence: 0.9, probabilities: {} } });
  const outcome = derivePlatformOutcomes(result({ profiles: [rejected] }), "instagram")[1];
  assert.equal(outcome.status, "not_found");
  assert.deepEqual(outcome.evidenceUrls, [rejected.url]);
});

function snapshot() {
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000000001", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(), workerId: "test-worker", resumeVersion: 100,
    stopRequested: false, estimatedCostUsd: 0, items: [],
  });
}
test("append-only stop events survive newer snapshots and old stops do not stop resumed runs", () => {
  const run = snapshot();
  assert.equal(decodeBulkSnapshot({ state: JSON.stringify(run), stopVersion: 101 }).status, "stopping");
  run.resumeVersion = 102;
  assert.equal(decodeBulkSnapshot({ state: JSON.stringify(run), stopVersion: 101 }).status, "running");
});

test("expired worker heartbeat requires explicit resume, never automatic paid work", () => {
  const run = snapshot();
  run.heartbeatAt = new Date(Date.now() - 180_000).toISOString();
  const restored = decodeBulkSnapshot({ state: JSON.stringify(run), stopVersion: 0 });
  assert.equal(restored.status, "interrupted");
  assert.match(restored.error!, /Resume explicitly/);
});

test("polling an old stopped snapshot while resume commits cannot stop the new generation", () => {
  const stored = snapshot();
  stored.stopRequested = true;
  stored.status = "stopped";
  const resumed = snapshot();
  resumed.resumeVersion = stored.resumeVersion + 100;
  resumed.stopRequested = false;
  const merged = mergeBulkRunView(resumed, stored)!;
  assert.equal(merged.status, "running");
  assert.equal(merged.stopRequested, false);
  assert.equal(merged.resumeVersion, resumed.resumeVersion);
});

test("same-generation stop controls are honored, and a newer persisted generation wins", () => {
  const local = snapshot();
  const stored = snapshot();
  stored.stopRequested = true;
  assert.equal(mergeBulkRunView(local, stored)?.stopRequested, true);
  const newer = snapshot();
  newer.resumeVersion = local.resumeVersion + 100;
  assert.equal(mergeBulkRunView(local, newer)?.resumeVersion, newer.resumeVersion);
});
