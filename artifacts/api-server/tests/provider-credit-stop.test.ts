import assert from "node:assert/strict";
import { test } from "node:test";
import { GetBulkBrandRunResponse, type BulkBrandRun } from "@workspace/api-zod";
import { providerCreditError, ProviderCreditError } from "../src/lib/provider-credit-error";
import { providerFetch, withPaidRequestGuard } from "../src/lib/paid-request-guard";
import { executeBulkRun, type WorkerDependencies } from "../src/lib/bulk-worker";
import { BulkOwnership } from "../src/lib/bulk-ownership";
import { MemoryStore } from "./helpers/bulk-memory-store";
import { createPostgresOwnershipStore } from "../src/lib/bulk-ownership-store";

const serper = "https://google.serper.dev/search";
const openrouter = "https://openrouter.ai/api/v1/chat/completions";
function fixture(count = 4, workers = 1): BulkBrandRun {
  const now = new Date().toISOString();
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000009100", status: "running",
    createdAt: now, updatedAt: now, heartbeatAt: now,
    workerId: "unclaimed", resumeVersion: 0, stopRequested: false,
    workersPerType: workers, estimatedCostUsd: 0,
    items: Array.from({ length: count }, (_, index) => ({
      candidate: { profileId: index + 1, profileName: `Fixture ${index}`, tier: 1, tierRank: index,
        accountId: `fixture-${index}`, platform: "Instagram", handle: `fixture${index}`,
        url: `https://www.instagram.com/fixture${index}/` },
      status: "queued", platforms: [],
    })),
  });
}
const dependencies = (ownership: BulkOwnership, processItem: WorkerDependencies["processItem"]): WorkerDependencies => ({
  ownership, processItem, archive: async () => {}, saveHistory: async () => {}, warn: () => {},
});
function finish(item: BulkBrandRun["items"][number]) {
  item.status = "completed";
  item.completedAt = new Date().toISOString();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("credit detection recognizes Serper and other billed providers without exposing error bodies", async () => {
  for (const [url, status, body] of [
    [serper, 400, { message: "Not enough credits; reflected credential: SECRET" }],
    [serper, 403, { message: "Insufficient credits" }],
    [serper, 429, { message: "Credits exhausted" }],
    [openrouter, 402, { error: { message: "Payment required SECRET" } }],
    ["https://api.scrapecreators.com/v1/find-social-profiles", 402, {}],
    ["https://www.socialcrawl.dev/v1/search", 400, { message: "Out of credits" }],
  ] as const) {
    const response = Response.json(body, { status });
    const error = await providerCreditError(url, response);
    assert.ok(error);
    assert.equal(error.httpStatus, status);
    assert.match(error.message, /Automatic stop/);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /SECRET|https:|credential/);
    assert.deepEqual(await response.json(), body, "classification must not consume the original response");
  }
});

test("ordinary rate limits, authentication failures, server failures and public-site payment walls do not masquerade as credit exhaustion", async () => {
  for (const [url, status, body] of [
    [serper, 429, "Too many requests"],
    [serper, 401, "Invalid API key"],
    [serper, 500, "Internal server error"],
    [serper, 400, "Invalid query"],
    ["https://example.com/profile", 402, "Payment required"],
  ] as const) assert.equal(await providerCreditError(url, new Response(body, { status })), undefined);
  assert.equal(await providerCreditError(serper, Response.json({ organic: [] })), undefined);
});

test("swallowed provider errors still stop the queue, retain partial outcomes, and leave untouched profiles queued", async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const active = await owner.claim(fixture(), "worker", "fixture");
  let network = 0, saves = 0;
  globalThis.fetch = async () => { network++; return Response.json({ message: "Not enough credits" }, { status: 400 }); };
  try {
    const deps = dependencies(owner, async item => {
      try { await providerFetch(serper); } catch { /* Match discovery's soft-failure handling. */ }
      // Subsequent nested provider dispatches must also be blocked.
      try { await providerFetch(openrouter); } catch {}
      item.platforms = ["Instagram", "TikTok", "YouTube"].map(platform => ({
        platform, status: "incomplete", reason: "Required discovery failed.", evidenceUrls: [],
        checkedAt: new Date().toISOString(),
      }));
      finish(item);
    });
    deps.archive = async () => { saves++; };
    await executeBulkRun(active.run, active.lease!, deps);
    const saved = (await owner.read(active.run.id))[0];
    assert.equal(network, 1);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.stopRequested, true);
    assert.match(saved.error!, /Serper.*HTTP 400/);
    assert.equal(saved.items[0].platforms.length, 3);
    assert.equal(saved.items[0].status, "completed");
    assert.ok(saved.items.slice(1).every(item => item.status === "queued"));
    assert.ok(saves > 0);
    assert.equal(store.queue.owner, undefined);

    // A new worker must not rediscover the outage with another paid cohort.
    await assert.rejects(owner.claim(saved, "worker-next", "fixture", saved.resumeVersion), /billing block|billing limit/);
    const health = await new BulkOwnership(store).billingHealth();
    assert.equal(health.outages[0].provider, "Serper");
    assert.equal(network, 1);
    await owner.clearBillingOutage("Serper", health.outages[0].incidentId);
    assert.equal(network, 1, "clearing is not a paid probe or automatic resume");
    globalThis.fetch = async () => { network++; return Response.json({ organic: [] }); };
    const resumed = await owner.claim(saved, "worker-next", "fixture", saved.resumeVersion);
    await executeBulkRun(resumed.run, resumed.lease!, dependencies(owner, async item => {
      await providerFetch(serper);
      finish(item);
    }));
    assert.equal(network, 4);
    const done = (await owner.read(saved.id))[0];
    assert.equal(done.status, "completed");
    assert.equal(done.error, undefined);
    assert.equal(done.items[0].platforms[0].status, "incomplete");
  } finally { globalThis.fetch = original; }
});

test("billing state survives worker replacement, blocks claims/admissions, and preserves idempotent launches", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const active = await owner.claim(fixture(), "worker", "billing");
  await owner.admit(active.lease!, 0); // Uncertain paid work must stay uncertain.
  await owner.reportCreditFailure(new ProviderCreditError("OpenRouter", 402));
  const replica = new BulkOwnership(store);
  await assert.rejects(replica.assertBillingAvailable(), /OpenRouter/);
  await assert.rejects(replica.admit(active.lease!, 1), /OpenRouter/);
  const retried = await replica.claim(fixture(), "worker-new", "billing");
  assert.equal(retried.launched, false);
  assert.equal(retried.run.resumeVersion, active.run.resumeVersion);
  const other = fixture(); other.id = "00000000-0000-4000-8000-000000009101";
  await assert.rejects(replica.claim(other, "worker-new", "other"), /OpenRouter/);
  const outage = (await replica.billingHealth()).outages[0];
  await assert.rejects(replica.clearBillingOutage(outage.provider, outage.incidentId), /active queue/);
  store.now += 150_001;
  await replica.clearBillingOutage(outage.provider, outage.incidentId);
  await replica.clearBillingOutage(outage.provider, outage.incidentId); // Retry is safe.
  assert.equal((await replica.billingHealth()).outages.length, 0);
  assert.deepEqual(store.records.get(active.run.id)!.uncertain, [0]);
  const resumed = await replica.claim(active.run, "recovery", "billing", active.run.resumeVersion);
  assert.equal(resumed.run.items[0].retryBlocked, true);
  assert.equal(resumed.run.items[0].status, "failed");
  await assert.rejects(owner.guard(active.lease!), /lease lost/);
});

test("recovery uses incident comparison, retains other outages, and stores only sanitized evidence", async () => {
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const error = new ProviderCreditError("Serper", 400);
  Object.assign(error, { secret: "SECRET", body: "PRIVATE BODY" });
  await owner.reportCreditFailure(error);
  const old = (await owner.billingHealth()).outages[0];
  await owner.reportCreditFailure(new ProviderCreditError("Serper", 403));
  await owner.reportCreditFailure(new ProviderCreditError("ScrapeCreators", 402));
  await assert.rejects(owner.clearBillingOutage("Serper", old.incidentId), /evidence changed/);
  const current = (await owner.billingHealth()).outages.find(outage => outage.provider === "Serper")!;
  await owner.clearBillingOutage("Serper", current.incidentId);
  assert.deepEqual((await owner.billingHealth()).outages.map(outage => outage.provider), ["ScrapeCreators"]);
  assert.doesNotMatch(JSON.stringify(store.queue), /SECRET|PRIVATE BODY/);
  store.unavailable = true;
  await assert.rejects(owner.assertBillingAvailable(), /unavailable/);
  await assert.rejects(owner.clearBillingOutage("Serper", current.incidentId), /unavailable/);
});

test("a credit outage learned on another replica closes an admitted worker's network gate", async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const active = await owner.claim(fixture(1), "worker", "external-outage");
  let network = 0;
  globalThis.fetch = async () => { network++; return Response.json({}); };
  try {
    await executeBulkRun(active.run, active.lease!, dependencies(owner, async () => {
      await new BulkOwnership(store).reportCreditFailure(new ProviderCreditError("Serper", 400));
      await providerFetch(openrouter);
    }));
    assert.equal(network, 0);
    const saved = (await owner.read(active.run.id))[0];
    assert.equal(saved.status, "stopped");
    assert.match(saved.error!, /Serper/);
  } finally { globalThis.fetch = original; }
});

test("real PostgreSQL billing blocks persist across adapters and recovery is incident-fenced", {
  skip: process.env.BULK_COORDINATION_DB_TEST !== "1",
}, async () => {
  const { pool } = await import("@workspace/db");
  const prefix = `billing_test_${process.pid}_${Date.now()}`;
  const create = () => new BulkOwnership(createPostgresOwnershipStore(async () => pool, prefix));
  try {
    const a = create(), b = create();
    await a.reportCreditFailure(new ProviderCreditError("Serper", 400));
    const first = (await b.billingHealth()).outages[0];
    assert.equal(first.provider, "Serper");
    await assert.rejects(create().claim(fixture(), "replacement", "outage"), /Serper/);
    await b.reportCreditFailure(new ProviderCreditError("Serper", 402));
    await assert.rejects(a.clearBillingOutage("Serper", first.incidentId), /evidence changed/);
    const current = (await create().billingHealth()).outages[0];
    await a.clearBillingOutage("Serper", current.incidentId);
    assert.equal((await create().billingHealth()).outages.length, 0);
    assert.equal((await b.read()).length, 0, "clearing must not create or resume runs");
    await b.reportCreditFailure(new ProviderCreditError("OpenRouter", 402));
    await assert.rejects(create().claim(fixture(), "replacement", "outage"), /OpenRouter/);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${prefix}_claims; DROP TABLE IF EXISTS ${prefix}_queue; DROP TABLE IF EXISTS ${prefix}_attempts`);
    await pool.end();
  }
});

test("parallel in-flight results drain and save, but no subsequent profile or provider request starts", { timeout: 4000 }, async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const mixed = fixture(4, 1);
  mixed.items[0].candidate.profileType = "brand";
  mixed.items[1].candidate.profileType = "creator";
  mixed.items[2].candidate.profileType = "artist";
  mixed.items[3].candidate.profileType = "brand";
  mixed.scopes = [{ profileType: "brand", limit: 2 }, { profileType: "creator", limit: 1 }, { profileType: "artist", limit: 1 }];
  const active = await owner.claim(mixed, "worker", "parallel");
  const secondStarted = deferred(), releaseResponse = deferred(), stopped = deferred();
  const unsubscribe = owner.onStop(active.lease!, () => stopped.resolve());
  let network = 0;
  const processed: number[] = [];
  globalThis.fetch = async input => {
    network++;
    if (String(input) === serper) {
      await secondStarted.promise;
      return Response.json({ message: "Not enough credits" }, { status: 400 });
    }
    secondStarted.resolve();
    await releaseResponse.promise;
    return Response.json({ retained: true });
  };
  try {
    const work = executeBulkRun(active.run, active.lease!, dependencies(owner, async item => {
      processed.push(item.candidate.profileId);
      try { await providerFetch(item.candidate.profileId === 1 ? serper : openrouter); } catch {}
      if (item.candidate.profileId === 2) {
        item.platforms = [{ platform: "Instagram", status: "found", reason: "Already-dispatched response retained.",
          evidenceUrls: ["https://www.instagram.com/fixture1"], checkedAt: new Date().toISOString() }];
        try { await providerFetch(openrouter); } catch {}
      }
      finish(item);
    }));
    await stopped.promise;
    releaseResponse.resolve();
    await work;
    const saved = (await owner.read(active.run.id))[0];
    assert.equal(saved.status, "stopped");
    assert.equal(network, 3);
    assert.deepEqual(processed.sort(), [1, 2, 3]);
    assert.equal(saved.items[1].platforms[0].status, "found");
    assert.ok(saved.items.slice(3).every(item => item.status === "queued"));
    assert.deepEqual(store.records.get(saved.id)!.uncertain, []);
  } finally {
    unsubscribe(); secondStarted.resolve(); releaseResponse.resolve(); globalThis.fetch = original;
  }
});

test("a credit failure in the last profile is still an automatic stop, not a successful completed run", async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const active = await owner.claim(fixture(1), "worker", "last");
  globalThis.fetch = async () => new Response("", { status: 402 });
  try {
    await executeBulkRun(active.run, active.lease!, dependencies(owner, async item => {
      try { await providerFetch(openrouter); } catch {}
      finish(item);
    }));
    assert.equal((await owner.read(active.run.id))[0].status, "stopped");
  } finally { globalThis.fetch = original; }
});

test("credit stops prevent continuous chunk selection and do not turn normal transient errors into global stops", async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const run = fixture(1);
  run.scopes = [{ profileType: "brand", limit: 1 }];
  run.continuous = { upperProfileId: 10, batches: 0, completed: 0, failed: 0, completedCostUsd: 0,
    cursors: [{ profileType: "brand", afterId: 0, exhausted: false, completed: 0, failed: 0 }] };
  const active = await owner.claim(run, "worker", "continuous");
  let chunks = 0;
  globalThis.fetch = async () => Response.json({ message: "Not enough credits" }, { status: 400 });
  try {
    const deps = dependencies(owner, async item => {
      try { await providerFetch(serper); } catch {}
      finish(item);
    });
    deps.nextChunk = async () => { chunks++; throw new Error("Must not select a new chunk after credit failure."); };
    await executeBulkRun(active.run, active.lease!, deps);
    assert.equal(chunks, 0);
    assert.equal((await owner.read(run.id))[0].status, "stopped");

    const nextStore = new MemoryStore(), nextOwner = new BulkOwnership(nextStore);
    const transient = await nextOwner.claim(fixture(2), "worker", "transient");
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("Rate limited", { status: 429 }); };
    await executeBulkRun(transient.run, transient.lease!, dependencies(nextOwner, async item => {
      await providerFetch(serper);
      finish(item);
    }));
    assert.equal(calls, 2);
    assert.equal((await nextOwner.read(transient.run.id))[0].status, "completed");
  } finally { globalThis.fetch = original; }
});

test("a failed durable stop still closes the local dispatch gate and preserves uncertain admission", async () => {
  const original = globalThis.fetch;
  const store = new MemoryStore(), owner = new BulkOwnership(store);
  const active = await owner.claim(fixture(), "worker", "unavailable");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++; store.unavailable = true;
    return new Response("", { status: 402 });
  };
  try {
    await executeBulkRun(active.run, active.lease!, dependencies(owner, async () => {
      try { await providerFetch(openrouter); } catch {}
      try { await providerFetch(serper); } catch {}
    }));
    assert.equal(calls, 1);
    store.unavailable = false;
    assert.deepEqual(store.records.get(active.run.id)!.uncertain, [0]);
    assert.ok(store.records.get(active.run.id)!.run.items.slice(1).every(item => item.status === "queued"));
  } finally { store.unavailable = false; globalThis.fetch = original; }
});

test("ordinary single-profile requests outside the bulk guard retain their response and have no queue side effects", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ message: "Not enough credits" }, { status: 400 }); };
  try {
    const response = await providerFetch(serper);
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
    await withPaidRequestGuard(async () => {}, async () => {
      assert.equal((await providerFetch(serper)).status, 400);
    });
  } finally { globalThis.fetch = original; }
});
