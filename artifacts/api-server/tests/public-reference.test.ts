import assert from "node:assert/strict";
import { test } from "node:test";
import { SearchProfilesResponse } from "@workspace/api-zod";
import { findProfiles, parseKnownProfileUrl, resolveKnownProfileIdentity } from "../src/lib/musician-search.ts";
import { isProfileUrl } from "../../musician-social-finder/src/lib/profile-input.ts";

const cricinfo = "https://www.espncricinfo.com/cricketers/adam-zampa-379504";
const title = "Adam Zampa Profile - Cricket Player Australia";

test("public reference URLs are accepted consistently on frontend and backend", () => {
  for (const url of [
    cricinfo, "www.cricinfo.com/cricketers/adam-zampa-379504",
    "https://www.espn.com/nba/player/_/id/1966/lebron-james",
    "https://en.wikipedia.org/wiki/Adam_Zampa", "https://www.taylorswift.com/",
  ]) {
    assert.equal(isProfileUrl(url), true, url);
    assert.equal(parseKnownProfileUrl(url)?.platform, "web", url);
  }
});

test("private hosts, IPs, credentials, non-web schemes and nonstandard ports remain rejected", () => {
  for (const url of [
    "http://localhost/player", "http://127.0.0.1/player", "http://[::1]/player",
    "http://169.254.169.254/latest/meta-data", "http://2130706433/player",
    "http://service.internal/player", "https://example.invalid/person",
    "https://user:password@www.espn.com/player", "ftp://www.espn.com/player",
    "https://www.espn.com:8080/player", "not a url",
  ]) {
    assert.equal(isProfileUrl(url), false, url);
    assert.equal(parseKnownProfileUrl(url), undefined, url);
  }
});

test("reference identity comes from the indexed matching page, never an unrelated search result", async t => {
  t.mock.method(globalThis, "fetch", async (value: string, init?: RequestInit) => {
    assert.equal(value, "https://google.serper.dev/search");
    assert.equal(JSON.parse(init?.body as string).q, cricinfo);
    return Response.json({ organic: [
      { title: "Wrong Player Profile", link: "https://www.espncricinfo.com/cricketers/someone-else" },
      { title, link: cricinfo, snippet: "Adam Zampa is an Australian leg-spin bowler." },
    ] });
  });
  const result = await resolveKnownProfileIdentity(cricinfo, "", "test-key");
  assert.equal(result?.subject, "Adam Zampa");
  assert.equal(result?.handle, undefined);
  assert.equal(result?.handlePlatform, "web");
  assert.equal(result?.knownProfileUrl, cricinfo);
  assert.match(result!.referenceMetadata.bio!, /Australian leg-spin bowler/);
});

test("legacy Cricinfo URLs match ESPNcricinfo without changing the user's saved reference", async t => {
  t.mock.method(globalThis, "fetch", async (_value: string, init?: RequestInit) => {
    assert.equal(JSON.parse(init?.body as string).q, cricinfo);
    return Response.json({ organic: [{ title, link: cricinfo }] });
  });
  const legacy = "https://www.cricinfo.com/cricketers/adam-zampa-379504";
  const result = await resolveKnownProfileIdentity(legacy, "", "test-key");
  assert.equal(result?.subject, "Adam Zampa");
  assert.equal(result?.knownProfileUrl, legacy);
});

test("unindexed pages do not invent a person's identity from the URL", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ organic: [] }));
  assert.equal(await resolveKnownProfileIdentity(cricinfo, "", "test-key"), undefined);
  await assert.rejects(() => resolveKnownProfileIdentity(cricinfo, ""), /Serper is not configured/);
});

test("meaningful query IDs cannot accidentally match a different person", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ organic: [
    { title: "Different Person Profile", link: "https://www.espn.com/player?id=2" },
  ] }));
  assert.equal(await resolveKnownProfileIdentity("https://www.espn.com/player?id=1", "", "test-key"), undefined);
});

test("web references search all three platforms and survive saved-history validation", async t => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (_value: string, init?: RequestInit) => {
    const query = JSON.parse(init?.body as string).q;
    queries.push(query);
    return Response.json({ organic: query === cricinfo ? [{ title, link: cricinfo }] : [] });
  });
  const identity = await resolveKnownProfileIdentity(cricinfo, "", "test-key");
  assert.ok(identity);
  const result = await findProfiles({ ...identity, excludeReferencePlatform: true, methods: ["serper"], serperApiKey: "test-key" });
  assert.equal(queries.length, 4);
  for (const domain of ["instagram.com", "tiktok.com", "youtube.com"]) {
    assert.ok(queries.slice(1).some(q => q.includes(domain) && q.includes("Adam Zampa")));
  }
  const saved = SearchProfilesResponse.parse(JSON.parse(JSON.stringify(result)));
  assert.equal(saved.referenceProfile?.platform, "web");
  assert.equal(saved.referenceProfile?.displayName, "Adam Zampa");
  assert.equal(saved.referenceProfile?.url, cricinfo);
});
