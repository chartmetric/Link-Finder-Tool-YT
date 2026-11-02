import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchProfilesBody } from "@workspace/api-zod";
import { findProfiles } from "../src/lib/musician-search";

test("text discovery accepts a name without a reference and validates target platforms", () => {
  assert.equal(SearchProfilesBody.safeParse({ subject: "Virat Kohli cricketer", targetPlatforms: ["instagram"] }).success, true);
  for (const targetPlatforms of [[], ["espn"], ["instagram", "youtube", "tiktok", "instagram"]]) {
    assert.equal(SearchProfilesBody.safeParse({ subject: "Virat Kohli", targetPlatforms }).success, false);
  }
});

test("text discovery only searches and returns the requested platform, without identity verification", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; query: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), query: JSON.parse(String(init?.body)).q });
    return Response.json({ organic: [
      { title: "Virat Kohli", link: "https://www.instagram.com/virat.kohli/", snippet: "Indian cricketer" },
      { title: "Unrequested video channel", link: "https://www.youtube.com/@example", snippet: "Cricket" },
      { title: "A post is not an account", link: "https://www.instagram.com/p/example/", snippet: "Cricket" },
    ] });
  };
  try {
    const result = await findProfiles({
      subject: "Virat Kohli cricketer", targetPlatforms: ["instagram"],
      methods: ["serper"], serperApiKey: "fixture-not-a-real-key",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://google.serper.dev/search");
    assert.match(calls[0].query, /Virat Kohli cricketer/);
    assert.match(calls[0].query, /Instagram/);
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].platform, "Instagram");
    assert.equal(result.profiles[0].jevVerification, undefined);
    assert.equal(result.profiles[0].identityComparison, undefined);
    assert.equal(result.referenceProfile, undefined);
    assert.equal(result.methodsUsed[0].results.length, 1);
    assert.equal(result.sources.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("omitting targets preserves three-platform discovery", async () => {
  const originalFetch = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (_url, init) => {
    queries.push(JSON.parse(String(init?.body)).q);
    return Response.json({ organic: [] });
  };
  try {
    await findProfiles({ subject: "Example cricketer", methods: ["serper"], serperApiKey: "fixture-not-a-real-key" });
    assert.equal(queries.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});
