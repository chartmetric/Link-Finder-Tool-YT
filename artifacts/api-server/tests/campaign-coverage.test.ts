import test from "node:test";
import assert from "node:assert/strict";
import { combineCampaignCoverage, createCampaignCoverageReader, campaignCoverageSql,
  type CoverageProfile, type CampaignCoverage } from "../src/lib/campaign-coverage";

const at = "2026-11-11T18:00:00.000Z";
const now = new Date(at);
const profile = (id: number, state: CoverageProfile["state"], tier = 2): CoverageProfile =>
  ({ profile_id: String(id), cm_artist: String(id + 100), state, tier });
const base = {
  platform: "instagram" as const, snapshotAt: "2026-11-11T01:00:00.000Z", generatedAt: at,
  profiles: [profile(1, "catalog"), profile(2, "supported"), profile(3, "candidates"), profile(4, "no_match"),
    profile(5, "pending"), profile(6, "failed"), profile(7, "candidates"), profile(8, "not_searched", 3)],
};
const campaign: CampaignCoverage = {
  status: "running", observedAt: at,
  artists: [1, 2, 3, 3, 4, 8, 9, 10].map(id => ({ profile_id: String(id), cm_artist: String(id + 100) }))
    .concat([{ profile_id: "7", cm_artist: "999" }]),
};

test("combined coverage increases without counting catalog/research overlaps or duplicate candidate URLs twice", () => {
  const value = combineCampaignCoverage(base, campaign, now);
  assert.equal(value.tiers.reduce((s, t) => s + t.totalProfiles, 0), 8);
  const [t2, t3] = value.tiers;
  assert.equal(t2.catalogUrls, 1);
  assert.equal(t2.supportedResearchUrls, 1);
  assert.equal(t2.campaignLikelyUrls, 2);
  assert.equal(t2.noSupportedMatch, 0); // A later likely match is not also a no-match.
  assert.equal(t2.unresolvedCandidates, 1); // Wrong cm_artist identity remains unresolved.
  assert.equal(t2.pending, 1);
  assert.equal(t2.failed, 1);
  assert.equal(t3.campaignLikelyUrls, 1); // Uses current membership tier, not frozen campaign tier.
  for (const t of value.tiers) assert.equal(
    t.catalogUrls + t.supportedResearchUrls + (t.campaignLikelyUrls ?? 0) + t.noSupportedMatch
      + t.unresolvedCandidates + t.failed + t.pending + t.notSearched, t.totalProfiles);
});

test("catalog and campaign timestamps remain independent, with no fabricated zero on campaign failure", () => {
  const value = combineCampaignCoverage(base, null, now);
  assert.equal(value.campaignIncluded, false);
  assert.match(value.campaignError!, /unavailable/);
  assert.equal(value.catalogGeneratedAt, base.generatedAt);
  assert.equal(value.campaignObservedAt, null);
  assert.match(combineCampaignCoverage(base, { ...campaign, observedAt: "2026-11-11T17:00:00Z" }, now).campaignError!, /stale/);
});

test("invalid, duplicate or stale tier membership never inflates coverage", () => {
  assert.throws(() => combineCampaignCoverage({ ...base, profiles: [profile(1, "catalog"), profile(1, "catalog")] }, campaign, now), /Duplicate/);
  assert.throws(() => combineCampaignCoverage({ ...base, profiles: [profile(1, "catalog", 0)] }, campaign, now), /Invalid/);
  assert.deepEqual(combineCampaignCoverage({ ...base, snapshotAt: "2026-11-01T00:00:00Z" }, campaign, now).tiers, []);
});

test("both read-only queries exclude unfinished, unchecked and known shared-channel results", () => {
  for (const platform of ["instagram", "youtube"] as const) {
    const sql = campaignCoverageSql(platform);
    assert.match(sql, /a.status='completed' AND a.checked AND a.likely/);
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /channel_reused_across_catalog_artists/);
    assert.match(sql, /WHERE r.id=\$1/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/);
  }
});

test("fresh polls use new campaign evidence and retain last good membership on a failed refresh", async () => {
  let clock = now.getTime(), calls = 0, fail = false;
  const read = createCampaignCoverageReader(async () => base, async () => {
    calls++;
    if (fail) throw Error("Offline simulated read failure");
    return calls === 1 ? { ...campaign, artists: [] } : campaign;
  }, () => clock);
  const [a, b] = await Promise.all([read("instagram"), read("instagram")]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.tiers[0].campaignLikelyUrls, 0);
  clock += 15_000;
  assert.equal((await read("instagram")).tiers[0].campaignLikelyUrls, 2);
  fail = true;
  clock += 15_000;
  const retained = await read("instagram");
  assert.equal(retained.tiers[0].campaignLikelyUrls, 2);
  assert.match(retained.campaignError!, /last saved/);
});
