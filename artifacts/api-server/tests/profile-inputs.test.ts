import assert from "node:assert/strict";
import { test } from "node:test";
import { findProfiles, parseKnownProfileUrl, resolveKnownProfileIdentity } from "../src/lib/musician-search.ts";
import { isProfileUrl } from "../../musician-social-finder/src/lib/profile-input.ts";
import { SearchProfilesResponse } from "@workspace/api-zod";

const presets = [
  "youtube.com/channel/UCmv1CLT6ZcFdTJMHxaR9XeA",
  "https://www.instagram.com/tribbs",
  "https://www.tiktok.com/@iamchasematthew",
  "https://www.youtube.com/channel/UChumNJVpgIOi3sd3j3Y8kpQ",
  "https://www.tiktok.com/@aimyon_official",
  "https://www.youtube.com/channel/UCxU6nh0LHqH9H4-fxWMGsgw",
  "https://open.spotify.com/artist/6nxWCVXbOlEVRexSbLsTer",
  "https://www.instagram.com/tribedaloca",
  "https://www.tiktok.com/@raja_kumari",
  "https://www.instagram.com/latinmafia",
  "https://www.youtube.com/channel/UCZGBua-dvwfSdcF9AskDIgw",
];

test("all eleven user presets are accepted by frontend and backend", () => {
  for (const url of presets) {
    assert.equal(isProfileUrl(url), true, url);
    assert.ok(parseKnownProfileUrl(url), url);
  }
  const channel = parseKnownProfileUrl(presets[0]);
  assert.equal(channel?.url, `https://${presets[0]}`);
  assert.equal(channel?.channelId, "UCmv1CLT6ZcFdTJMHxaR9XeA");
});

test("posts, videos, Spotify tracks, malformed IDs and other hosts remain invalid", () => {
  for (const url of [
    "https://www.instagram.com/p/abc",
    "https://www.tiktok.com/@tribbs/video/123",
    "https://www.youtube.com/watch?v=123",
    "https://www.youtube.com/channel/not-a-channel",
    "https://open.spotify.com/track/6nxWCVXbOlEVRexSbLsTer",
    "https://open.spotify.com/artist/short",
    "https://instagram.com.evil.example/tribbs",
    "ftp://instagram.com/tribbs",
    "https://user:password@instagram.com/tribbs",
  ]) {
    assert.equal(isProfileUrl(url), false, url);
    assert.equal(parseKnownProfileUrl(url), undefined, url);
  }
});

test("channel lookup preserves channel ID case and resolves its canonical handle", async t => {
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    assert.equal(url.searchParams.get("channelId"), "UCmv1CLT6ZcFdTJMHxaR9XeA");
    assert.equal(url.searchParams.has("handle"), false);
    return Response.json({ channelId: "UCmv1CLT6ZcFdTJMHxaR9XeA", channel: "https://www.youtube.com/@testartist", name: "Test Artist" });
  });
  const identity = await resolveKnownProfileIdentity(presets[0], "test-key");
  assert.equal(identity?.subject, "Test Artist");
  assert.equal(identity?.handle, "testartist");
  assert.equal(identity?.knownProfileUrl, `https://${presets[0]}`);
});

test("channel lookup rejects metadata for a different channel", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ channelId: "UCwrong", channel: "https://www.youtube.com/@wrong", name: "Wrong Artist" }));
  assert.equal(await resolveKnownProfileIdentity(presets[0], "test-key"), undefined);
});

test("Spotify resolves the artist name without treating its ID as a social handle", async t => {
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    assert.equal(url.origin, "https://open.spotify.com");
    assert.equal(url.searchParams.get("url"), presets[6]);
    return Response.json({ provider_name: "Spotify", title: "Flume", thumbnail_url: "https://example.com/image.png" });
  });
  const identity = await resolveKnownProfileIdentity(presets[6], "test-key");
  assert.equal(identity?.subject, "Flume");
  assert.equal(identity?.handlePlatform, "spotify");
  assert.equal(identity?.handle, undefined);
  assert.equal(identity?.knownProfileUrl, presets[6]);
});

test("Spotify failures surface instead of creating an identity from the ID", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("Unavailable", { status: 503 }));
  await assert.rejects(() => resolveKnownProfileIdentity(presets[6], "test-key"), /Spotify artist lookup failed/);
});

test("Spotify references search all three social platforms through external discovery", async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (value: string, init: RequestInit) => {
    assert.equal(new URL(value).hostname, "google.serper.dev");
    queries.push(JSON.parse(init.body as string).q);
    return Response.json({ organic: [] });
  });
  await findProfiles({ subject: "Flume", handlePlatform: "spotify", knownProfileUrl: presets[6], excludeReferencePlatform: true, methods: ["serper"], serperApiKey: "test-key" });
  assert.equal(queries.length, 3);
  assert.ok(queries.every(query => query.includes("Flume") && !query.includes("6nxWCVXbOlEVRexSbLsTer")));
});

test("discovered YouTube handle and ID URLs group before verification and survive history JSON validation", async t => {
  const channelId = "UCmv1CLT6ZcFdTJMHxaR9XeA";
  const handleUrl = "https://www.youtube.com/@testartist";
  const idUrl = `https://www.youtube.com/channel/${channelId}`;
  const metadataLookups: string[] = [];
  t.mock.method(globalThis, "fetch", async (value: string, init?: RequestInit) => {
    const url = new URL(value);
    if (url.hostname === "google.serper.dev") {
      const query = JSON.parse(init?.body as string).q as string;
      return Response.json({ organic: query.includes("youtube") ? [
        { title: "Test Artist", link: handleUrl, snippet: "Official Test Artist channel" },
        { title: "Test Artist", link: idUrl, snippet: "Official Test Artist channel" },
      ] : [] });
    }
    assert.equal(url.hostname, "api.scrapecreators.com");
    metadataLookups.push(url.search);
    return Response.json({ channelId, handle: "@testartist", channel: handleUrl, name: "Test Artist" });
  });
  const result = await findProfiles({
    subject: "Test Artist", handlePlatform: "instagram", knownProfileUrl: "https://www.instagram.com/testartist/",
    referenceMetadata: { platform: "instagram", handle: "testartist", displayName: "Test Artist", url: "https://www.instagram.com/testartist/" },
    excludeReferencePlatform: true, methods: ["serper"], serperApiKey: "test-key", scrapeCreatorsApiKey: "test-key",
  });
  assert.equal(metadataLookups.length, 2);
  assert.ok(metadataLookups.some(query => query.includes(`channelId=${channelId}`)));
  assert.ok(metadataLookups.some(query => query.includes("handle=testartist")));
  const saved = SearchProfilesResponse.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(saved.profiles.length, 1);
  assert.equal(saved.totalFound, 1);
  assert.equal(saved.profiles[0].channelId, channelId);
  assert.deepEqual(new Set(saved.profiles[0].urlAliases), new Set([handleUrl, idUrl]));
  assert.equal(saved.profiles[0].identityComparison?.candidate.channelId, channelId);
  assert.equal(saved.profiles[0].jevVerification, undefined); // Alias resolution alone never verifies the artist.
});

test("YouTube starting-profile aliases also survive saved-history validation", async t => {
  const channelId = "UCmv1CLT6ZcFdTJMHxaR9XeA";
  const handleUrl = "https://www.youtube.com/@testartist";
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    return url.hostname === "api.scrapecreators.com"
      ? Response.json({ channelId, handle: "@testartist", channel: handleUrl, name: "Test Artist" })
      : Response.json({ organic: [] });
  });
  const identity = await resolveKnownProfileIdentity(`https://www.youtube.com/channel/${channelId}`, "test-key");
  assert.ok(identity);
  const result = await findProfiles({ ...identity, excludeReferencePlatform: true, methods: ["serper"], serperApiKey: "test-key" });
  const saved = SearchProfilesResponse.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(saved.referenceProfile?.channelId, channelId);
  assert.deepEqual(new Set(saved.referenceProfile?.urlAliases), new Set([handleUrl, `https://www.youtube.com/channel/${channelId}`]));
});

test("a failed channel lookup keeps both candidates and preserves the completed handle result", async t => {
  const channelId = "UCmv1CLT6ZcFdTJMHxaR9XeA";
  const handleUrl = "https://www.youtube.com/@testartist";
  const idUrl = `https://www.youtube.com/channel/${channelId}`;
  t.mock.method(globalThis, "fetch", async (value: string, init?: RequestInit) => {
    const url = new URL(value);
    if (url.hostname === "google.serper.dev") {
      return Response.json({ organic: JSON.parse(init?.body as string).q.includes("youtube") ? [
        { title: "Test Artist", link: handleUrl }, { title: "Test Artist", link: idUrl },
      ] : [] });
    }
    if (url.searchParams.has("channelId")) return new Response("Unavailable", { status: 503 });
    return Response.json({ channelId, handle: "@testartist", channel: handleUrl, name: "Test Artist" });
  });
  const result = await findProfiles({
    subject: "Test Artist", handlePlatform: "instagram", knownProfileUrl: "https://www.instagram.com/testartist/",
    referenceMetadata: { platform: "instagram", handle: "testartist", displayName: "Test Artist", url: "https://www.instagram.com/testartist/" },
    excludeReferencePlatform: true, methods: ["serper"], serperApiKey: "test-key", scrapeCreatorsApiKey: "test-key",
  });
  assert.equal(result.profiles.length, 2);
  assert.equal(result.profiles.find(p => p.url === handleUrl)?.channelId, channelId);
  assert.ok(result.profiles.find(p => p.url === idUrl)?.identityVerificationNote);
});

test("null follower counts and verification flags are omitted rather than invalidating saved results", async t => {
  const channelId = "UCmv1CLT6ZcFdTJMHxaR9XeA";
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const path = new URL(value).pathname;
    if (path.includes("/instagram/")) return Response.json({ data: { user: {
      username: "testbrand", full_name: "Test Brand", edge_followed_by: { count: null }, is_verified: null,
    } } });
    if (path.includes("/tiktok/")) return Response.json({
      user: { uniqueId: "testbrand", nickname: "Test Brand", verified: null }, stats: { followerCount: null },
    });
    return Response.json({
      handle: "@testbrand", channel: "https://www.youtube.com/@testbrand", channelId,
      name: "Test Brand", subscriberCount: null, isVerified: null,
    });
  });
  for (const url of [
    "https://www.instagram.com/testbrand/", "https://www.tiktok.com/@testbrand", "https://www.youtube.com/@testbrand",
  ]) {
    const resolved = await resolveKnownProfileIdentity(url, "test-key");
    assert.ok(resolved, url);
    assert.equal(resolved.referenceMetadata.followers, undefined, url);
    assert.equal("verified" in resolved.referenceMetadata, false, url);
  }
});
