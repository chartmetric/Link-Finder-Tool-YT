import test from "node:test";
import assert from "node:assert/strict";
import { youtubeTestCoverage, type SavedYoutubeTest } from "../src/lib/youtube-test-coverage";
import { combineCampaignCoverage } from "../src/lib/campaign-coverage";
import { youtubeCoverageSql } from "../src/lib/musician-platform-coverage";

const at = "2026-11-17T22:54:00.000Z";
const id = "UC" + "A".repeat(22);
const other = "UC" + "B".repeat(22);
function candidate(profile = "1", topic = false, channel = id) {
  const url = `https://www.youtube.com/channel/${channel}`;
  return { status: "review_suggestion", url, capture: { status: 200,
    body: { channelId: channel, displayName: topic ? "Artist - Topic" : "Artist" },
    bodySha256: "a".repeat(64), rawReceiptSha256: "b".repeat(64) },
    assessment: { profileId: profile, cmArtist: "101", youtubeUrl: url,
      modelAssessment: { category: topic ? "topic_identity_supported" : "artist_representation_supported" },
      decision: { reviewSuggestion: true, verified: false } } };
}
function row(candidates: unknown[], profile = "1"): SavedYoutubeTest {
  return { profile_id: profile, cm_artist: "101", checked_at: at,
    status: "review_processed", candidates_json: candidates };
}

test("batch suggestions are artist-level, deduplicated, and Topic-only is a disjoint category", () => {
  assert.equal(youtubeTestCoverage([row([candidate(), candidate(), candidate("1", true, other)])])[0].status, "test_likely");
  assert.equal(youtubeTestCoverage([row([candidate("1", true), candidate("1", true)])])[0].status, "test_topic");
  // jsonb changes key order; stored worker receipt references stay attached.
  const c = candidate();
  c.capture.body = { displayName: "Artist", channelId: id };
  assert.equal(youtubeTestCoverage([row([c])])[0].status, "test_likely");
});

test("raw, held, rejected, unbound and conflicting channels never become link coverage", () => {
  for (const c of [
    { ...candidate(), status: "uncertain" }, { ...candidate(), status: "held" },
    { ...candidate(), sharedChannelConflict: true }, candidate("999"),
    { ...candidate(), url: `https://www.youtube.com/watch?v=not-a-channel` },
    { ...candidate(), capture: { ...candidate().capture, status: 500 } },
    { ...candidate(), assessment: { ...candidate().assessment, cmArtist: "999" } },
    { ...candidate(), assessment: { ...candidate().assessment, decision: { reviewSuggestion: false } } },
  ]) assert.equal(youtubeTestCoverage([row([c])])[0].status, "candidates_found");
  assert.equal(youtubeTestCoverage([row([{ status: "not_a_match" }])])[0].status, "no_match");
  assert.equal(youtubeTestCoverage([row([])])[0].status, "no_match");
  const shared = youtubeTestCoverage([row([candidate()]), row([candidate("2")], "2")]);
  assert.ok(shared.every(r => r.status === "candidates_found"));
});

test("prepared and unknown states are incomplete; malformed source data fails explicitly", () => {
  assert.equal(youtubeTestCoverage([{ ...row([]), status: "review_prepared" }])[0].status, "admitted");
  assert.equal(youtubeTestCoverage([{ ...row([]), status: "failed" }])[0].status, "failed");
  assert.throws(() => youtubeTestCoverage([{ ...row([]), profile_id: "bad" }]), /Invalid/);
  assert.throws(() => youtubeTestCoverage([{ ...row([]), candidates_json: null }]), /Invalid/);
});

test("saved handle aliases and legacy Topic support retain their original review-only meaning", () => {
  const c = { ...candidate(), url: "https://www.youtube.com/@Artist",
    capture: { ...candidate().capture, requestedUrl: "https://www.youtube.com/@Artist" } };
  assert.equal(youtubeTestCoverage([row([c])])[0].status, "test_likely");
  assert.equal(youtubeTestCoverage([row([{ ...c, url: "https://www.youtube.com/@Different" }])])[0].status, "candidates_found");
  assert.equal(youtubeTestCoverage([row([{ ...c, url: `https://www.youtube.com/channel/${other}`,
    capture: { ...c.capture, requestedUrl: `https://www.youtube.com/channel/${other}` } }])])[0].status, "candidates_found");
  const topic = candidate("1", true);
  const legacy = { ...topic, assessment: { ...topic.assessment,
    version: "youtube-combined-ownership-offline-v1",
    decision: { status: "experimental_topic_support", reviewSuggestion: false, verified: false } } };
  assert.equal(youtubeTestCoverage([{ ...row([legacy]), status: "source_processed" }])[0].status, "test_topic");
  assert.equal(youtubeTestCoverage([row([{ ...legacy, status: "held" }])])[0].status, "candidates_found");
});

test("current tier membership gives catalog and campaign priority, with each artist counted once", () => {
  const value = combineCampaignCoverage({
    platform: "youtube", snapshotAt: at, generatedAt: at, testObservedAt: at,
    profiles: ["catalog", "supported", "test_likely", "test_topic", "test_topic", "candidates"].map((state, i) => ({
      profile_id: String(i + 1), cm_artist: "101", tier: 5,
      state: state as "catalog" | "supported" | "test_likely" | "test_topic" | "candidates",
    })),
  }, { status: "paused", observedAt: at, artists: [{ profile_id: "5", cm_artist: "101" }] }, new Date(at));
  const t = value.tiers[0];
  assert.equal(t.totalProfiles, 6);
  assert.equal(t.testLikelyUrls, 1);
  assert.equal(t.testTopicUrls, 1);
  assert.equal(t.campaignLikelyUrls, 1);
  assert.equal(t.catalogUrls + t.supportedResearchUrls + t.testLikelyUrls! + t.testTopicUrls!
    + t.campaignLikelyUrls! + t.unresolvedCandidates, t.totalProfiles);
  assert.equal(value.testObservedAt, at);
  const sql = youtubeCoverageSql([]);
  assert.match(sql, /LEFT JOIN pilot y ON y.profile_id=p.id AND y.cm_artist=p.cm_source_id/);
  assert.match(sql, /pilot_status='test_topic'/);
  assert.match(sql, /countIf\(state='test_likely'\)/);
});
