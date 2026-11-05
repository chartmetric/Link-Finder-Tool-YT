import assert from "node:assert/strict";
import { test } from "node:test";
import { externalProfileUrls, canonicalIdentityUrl, hasExactIdentityCrossLink } from "../src/lib/identity-links";
import { compareIdentity, fetchIdentityMetadata, parseKnownProfileUrl } from "../src/lib/musician-search";

const spotify = "https://open.spotify.com/artist/0123456789ABCDEFGHIJKL";
const ig = "https://www.instagram.com/example.artist/";
const channelId = "UCvU9MbC4e-3A8myju8Q_o-g";

test("Instagram external_url and bio_links destinations survive metadata extraction", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return Response.json({ data: { user: { username: "example.artist", full_name: "Example Artist", biography: "Music",
      external_url: spotify, bio_links: [{ url: spotify }, { url: "https://linktr.ee/example" }] } } });
  };
  try {
    const metadata = await fetchIdentityMetadata({ platform: "instagram", url: ig, apiKey: "fixture-only" });
    assert.deepEqual(metadata?.externalUrls, [spotify, "https://linktr.ee/example"]);
    assert.equal(metadata?.bio, "Music");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/api.scrapecreators.com\/v1\/instagram\/profile/);
  } finally { globalThis.fetch = original; }
});

test("malformed, credential-bearing and non-HTTPS external links are not promoted", () => {
  assert.deepEqual(externalProfileUrls({ external_url: "javascript:alert(1)",
    bio_links: [{ url: null }, null, { url: 1 }, { url: "https://user:pass@host.example/x" }, { url: "http://host.example" }] }), []);
});

test("exact external music ID cross-link supplies identity evidence despite different handles", () => {
  const reference = { platform: "spotify", handle: "0123456789ABCDEFGHIJKL", url: spotify };
  const candidate = { platform: "instagram", handle: "example.artist", url: ig, bio: "Music", externalUrls: [spotify] };
  assert.equal(hasExactIdentityCrossLink(reference, candidate), true);
  const comparison = compareIdentity(reference, candidate);
  assert.equal(comparison.status, "likely");
  assert.ok(comparison.reasons.includes("Exact account cross-link in profile metadata"));
  assert.equal(hasExactIdentityCrossLink(reference, { ...candidate, externalUrls: [`${spotify}X`] }), false);
});

test("a free-text link-in-bio signal alone cannot manufacture a direct identity link", () => {
  const reference = { platform: "spotify", handle: "artist-id", url: spotify };
  const candidate = { platform: "instagram", handle: "different", url: ig };
  const comparison = compareIdentity(reference, candidate, ["Direct link in bio"]);
  assert.equal(comparison.score, 0);
  assert.equal(comparison.status, "mismatch");
});

test("YouTube Music normalizes only an exact profile/channel identity", () => {
  const input = `https://music.youtube.com/channel/${channelId}?feature=share`;
  assert.equal(canonicalIdentityUrl(input), `https://www.youtube.com/channel/${channelId}`);
  assert.equal(parseKnownProfileUrl(input)?.url, `https://www.youtube.com/channel/${channelId}`);
  assert.equal(parseKnownProfileUrl(input)?.channelId, channelId);
  assert.notEqual(canonicalIdentityUrl(input), canonicalIdentityUrl(input.replace(channelId, channelId.toLowerCase())));
  assert.equal(canonicalIdentityUrl("https://music.youtube.com/watch?v=123"), undefined);
  assert.equal(canonicalIdentityUrl("https://music.youtube.com.evil.example/channel/123"), undefined);
});
