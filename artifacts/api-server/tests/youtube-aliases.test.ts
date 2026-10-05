import assert from "node:assert/strict";
import { test } from "node:test";
import { youtubeAliases, groupYouTubeAliases } from "../src/lib/youtube-aliases.ts";
import type { ProfileMatch } from "../src/lib/musician-search.ts";

const id = "UCmv1CLT6ZcFdTJMHxaR9XeA";
const handleUrl = "https://www.youtube.com/@testartist";
const idUrl = `https://www.youtube.com/channel/${id}`;
const metadata = { channelId: id, handle: "testartist", url: handleUrl };
const profile = (url: string, overrides: Partial<ProfileMatch> = {}): ProfileMatch => ({
  platform: "YouTube", category: "social", title: "Test Artist", url,
  displayUrl: url, snippet: "", confidence: 80, signals: [], methods: ["serper"], ...overrides,
});

test("handle and channel URLs resolve to the same ID and preserve both forms", () => {
  for (const url of [handleUrl, idUrl]) {
    const aliases = youtubeAliases(url, metadata);
    assert.equal(aliases?.channelId, id);
    assert.deepEqual(new Set(aliases?.urlAliases), new Set([handleUrl, idUrl]));
  }
});

test("confirmed aliases become one account with combined evidence, not an inflated score", () => {
  const result = groupYouTubeAliases([
    profile(handleUrl, { ...youtubeAliases(handleUrl, metadata), signals: ["web evidence"] }),
    profile(idUrl, { ...youtubeAliases(idUrl, metadata), confidence: 70, methods: ["gemini"], signals: ["other evidence"] }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].confidence, 80);
  assert.deepEqual(new Set(result[0].methods), new Set(["serper", "gemini"]));
  assert.deepEqual(new Set(result[0].signals), new Set(["web evidence", "other evidence"]));
  assert.equal(result[0].identityComparison, undefined);
  assert.equal(result[0].jevVerification, undefined); // Equivalence does not verify artist ownership.
  assert.deepEqual(new Set(result[0].urlAliases), new Set([handleUrl, idUrl]));
});

test("missing metadata, names alone, and differing IDs cannot merge accounts", () => {
  assert.equal(youtubeAliases(handleUrl, undefined), undefined);
  assert.equal(youtubeAliases(idUrl, { ...metadata, channelId: id.toLowerCase() }), undefined);
  assert.equal(youtubeAliases(handleUrl, { ...metadata, handle: "other", url: "https://www.youtube.com/@other" }), undefined);
  const otherId = "UCxU6nh0LHqH9H4-fxWMGsgw";
  const otherUrl = `https://www.youtube.com/channel/${otherId}`;
  assert.equal(youtubeAliases(otherUrl, metadata), undefined);
  assert.equal(groupYouTubeAliases([
    profile(handleUrl, youtubeAliases(handleUrl, metadata)),
    profile(idUrl),
    profile(otherUrl, youtubeAliases(otherUrl, { ...metadata, channelId: otherId })),
  ]).length, 3);
});

test("invalid domains, video links, malformed IDs and contradictory canonical metadata are rejected", () => {
  for (const url of ["https://youtube.com.evil.example/@testartist", "https://www.youtube.com/watch?v=123", "https://www.youtube.com/channel/UCbad"]) {
    assert.equal(youtubeAliases(url, metadata), undefined);
  }
  assert.equal(youtubeAliases(handleUrl, { ...metadata, url: `https://www.youtube.com/channel/UCxU6nh0LHqH9H4-fxWMGsgw` }), undefined);
  assert.equal(youtubeAliases(idUrl, { ...metadata, handle: id, url: idUrl })?.urlAliases.length, 1);
});

test("same-channel candidates share the readable artist comparison", () => {
  const comparison: NonNullable<ProfileMatch["identityComparison"]> = {
    status: "mismatch", score: 10, reasons: ["Different artist"],
    reference: { platform: "instagram", handle: "other", url: "https://www.instagram.com/other/" },
    candidate: { platform: "youtube", ...metadata },
  };
  const result = groupYouTubeAliases([
    profile(handleUrl, { ...youtubeAliases(handleUrl, metadata), identityComparison: comparison }),
    profile(idUrl, { ...youtubeAliases(idUrl, metadata), confidence: 99, identityVerificationNote: "Unavailable" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].identityComparison?.status, "mismatch");
  assert.equal(result[0].identityVerificationNote, undefined);
});
