import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lookupStartingProfile, StartingProfileLookupError, STARTING_PROFILE_TIMEOUT_MS,
} from "../src/lib/starting-profile-lookup.ts";
import { resolveKnownProfileIdentity } from "../src/lib/musician-search.ts";

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const profile = () => Response.json({ data: { user: { username: "testbrand", full_name: "Test Brand" } } });

test("starting profile gets 30 seconds and one retry after a timeout", async () => {
  const deadlines: number[] = [];
  const value = await lookupStartingProfile("instagram", async deadline => {
    deadlines.push(deadline);
    if (deadlines.length === 1) throw timeout();
    return "resolved";
  });
  assert.equal(value, "resolved");
  assert.deepEqual(deadlines, [30_000, 30_000]);
});

test("two timeouts stop with a starting-platform error, not three platform failures", async () => {
  let calls = 0;
  await assert.rejects(lookupStartingProfile("instagram", async () => {
    calls++;
    throw timeout();
  }), error => {
    assert.ok(error instanceof StartingProfileLookupError);
    assert.equal(error.platform, "instagram");
    assert.equal(error.timedOut, true);
    assert.match(error.message, /Starting Instagram profile lookup timed out after 2 attempts/);
    assert.match(error.message, /Other platforms were not searched/);
    return true;
  });
  assert.equal(calls, 2);
});

test("non-timeout failures and unreadable profiles never trigger automatic extra paid requests", async () => {
  let calls = 0;
  await assert.rejects(lookupStartingProfile("youtube", async () => {
    calls++;
    throw new Error("Metadata lookup failed (401)");
  }), error => {
    assert.ok(error instanceof StartingProfileLookupError);
    assert.equal(error.timedOut, false);
    assert.match(error.message, /Starting YouTube profile lookup failed.*401/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(await lookupStartingProfile("instagram", async () => { calls++; return undefined; }), undefined);
  assert.equal(calls, 2);
});

test("single and bulk shared resolver wires the extended deadline into both attempts", async t => {
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (value: string) => {
    assert.match(value, /^https:\/\/api\.scrapecreators\.com\/v1\/instagram\//);
    if (++calls === 1) throw timeout();
    return profile();
  });
  const resolved = await resolveKnownProfileIdentity("https://www.instagram.com/testbrand/", "test-key");
  assert.equal(resolved?.subject, "Test Brand");
  assert.equal(calls, 2);
  assert.deepEqual(deadlines, [STARTING_PROFILE_TIMEOUT_MS, STARTING_PROFILE_TIMEOUT_MS]);
});

test("a response-body timeout is retried too; receiving headers is not a completed lookup", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const response = profile();
    if (++calls === 1) t.mock.method(response, "json", async () => { throw timeout(); });
    return response;
  });
  assert.equal((await resolveKnownProfileIdentity("https://www.instagram.com/testbrand/", "test-key"))?.handle, "testbrand");
  assert.equal(calls, 2);
});

test("HTTP rejection is reported at the starting-profile stage without retrying", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ error: { message: "Unauthorized (401)" } }, { status: 401 });
  });
  await assert.rejects(
    resolveKnownProfileIdentity("https://www.instagram.com/testbrand/", "test-key"),
    /Starting Instagram profile lookup failed: Unauthorized \(401\).*Other platforms were not searched/,
  );
  assert.equal(calls, 1);
});
