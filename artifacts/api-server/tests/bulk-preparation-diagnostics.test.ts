import assert from "node:assert/strict";
import test from "node:test";
import { GetBulkBrandRunResponse } from "@workspace/api-zod";
import { observePreparationRead, PreparationReadError, withPreparationDiagnostics, type PreparationReadCategory } from "../src/lib/bulk-preparation-diagnostics";
import { preparationCatalogRead, prepareBulkRun } from "../src/lib/bulk-preparation";
import { logger } from "../src/lib/logger";
import { bulkOwnership } from "../src/lib/bulk-ownership-store";
import { BulkOwnership } from "../src/lib/bulk-ownership";
import { executeBulkRun } from "../src/lib/bulk-worker";
import { MemoryStore } from "./helpers/bulk-memory-store";

function run() {
  return GetBulkBrandRunResponse.parse({
    id: "00000000-0000-4000-8000-000000000077", status: "running",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(), workerId: "fixture", resumeVersion: 7,
    stopRequested: false, estimatedCostUsd: 0, items: [], selectionMode: "remaining",
    scopes: [{ profileType: "brand", limit: 1 }],
    preparation: { status: "selecting", mode: "one_chunk", requested: 1, selected: 0, message: "Preparing" },
  });
}

test("slow retried reads carry correlation, exact durations, attempts and counts, never SQL or errors", async () => {
  const records: any[] = [];
  let clock = 0, calls = 0;
  const saved = run();
  saved.launchHistory = [{
    action: "resume", requestId: "00000000-0000-4000-8000-000000000078",
    source: "unknown", acceptedAt: saved.createdAt,
    settings: { scopes: saved.scopes!, workersPerType: 1, continuous: false },
  }];
  await withPreparationDiagnostics(saved, async () => {
    const read = preparationCatalogRead(async () => {}, async <T>() => {
      clock += 12_000;
      if (++calls < 3) throw new DOMException("https://user:secret@fixture.invalid?token=secret", "TimeoutError");
      return { data: [{ profileName: "private", url: "secret" }, {}] as T[] };
    }, async () => { clock += 1000; });
    await read("SECRET SQL", { password: "secret" }, 1, "account_enrichment");
  }, timing => records.push(timing), () => clock);
  assert.deepEqual(records.map(r => [r.phase, r.attempt, r.durationMs, r.rowCount]), [
    ["started", 1, 0, null], ["failed", 1, 12_000, null],
    ["started", 2, 0, null], ["failed", 2, 12_000, null],
    ["started", 3, 0, null], ["succeeded", 3, 12_000, 2],
  ]);
  for (const record of records) {
    assert.equal(record.runId, saved.id);
    assert.equal(record.requestId, saved.launchHistory[0].requestId);
    assert.equal(record.generation, 7);
    assert.equal(record.category, "account_enrichment");
    assert.equal(record.paidAdmissionsOccurred, false);
  }
  assert.doesNotMatch(JSON.stringify(records), /secret|private|SQL|password|fixture\.invalid/);
});

test("permanent and exhausted failures retain a safe category and never replay writes or paid work", async () => {
  for (const transient of [false, true]) {
    let calls = 0;
    const records: any[] = [];
    await withPreparationDiagnostics(run(), async () => {
      const read = preparationCatalogRead(async () => {}, async () => {
        calls++;
        if (transient) throw new DOMException("secret", "TimeoutError");
        throw new Error("CLICKHOUSE_QUERY_FAILED:403:https://secret:password@host.invalid");
      }, async () => {});
      await assert.rejects(read("private", {}, 1, "candidate_ids"), error => {
        assert.ok(error instanceof PreparationReadError);
        assert.equal(error.category, "candidate_ids");
        assert.equal(error.retryable, transient);
        assert.match(error.message, /Paid admissions occurred: no/);
        assert.doesNotMatch(JSON.stringify(error) + error.stack, /secret|password|host\.invalid/);
        return true;
      });
    }, timing => records.push(timing));
    assert.equal(calls, transient ? 3 : 1);
    assert.equal(records.filter(r => r.phase === "failed").length, calls);
  }
});

test("parallel preparation contexts stay isolated and observation is inactive elsewhere", async () => {
  const records: any[] = [], a = run(), b = run();
  b.id = "00000000-0000-4000-8000-000000000088";
  await Promise.all([a, b].map(saved => withPreparationDiagnostics(saved, () =>
    observePreparationRead("archive_lookup", async () => {
      await new Promise(resolve => setImmediate(resolve));
      return [saved.id];
    }, rows => rows.length), timing => records.push(timing))));
  for (const saved of [a, b]) {
    assert.deepEqual(records.filter(r => r.runId === saved.id).map(r => r.phase), ["started", "succeeded"]);
  }
  const raw = new Error("outside preparation");
  await assert.rejects(observePreparationRead("archive_lookup", async () => { throw raw; }), error => error === raw);
});

test("real preparation paths distinguish archives, boundary, candidates, accounts, attempts and coordinator waits", async t => {
  const events: any[] = [];
  t.mock.method(logger, "info", (record: unknown) => { events.push(record); });
  // No PostgreSQL connection or live claims: only this read-only method is used.
  t.mock.method(bulkOwnership, "attempted", async () => new Set<number>());
  const keys = ["CLICKHOUSE_VERT_HOST", "CLICKHOUSE_USERNAME", "CLICKHOUSE_PASSWORD"];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = key === keys[0] ? "https://diagnostics.invalid" : "fixture-only"; });
  let fail: PreparationReadCategory | undefined, providerCalls = 0, legacy = false;
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (new URL(String(url)).hostname !== "diagnostics.invalid") {
      providerCalls++;
      throw new Error("Paid services forbidden");
    }
    const sql = String(init.body);
    if (sql.includes("CREATE TABLE")) return new Response("");
    const category: PreparationReadCategory = sql.includes("argMaxIf") ? "archive_lookup"
      : sql.includes("max(id) AS maxId") ? "catalog_boundary"
      : sql.includes("AS attemptedItem") ? "prior_attempts_archive"
      : sql.includes("linked_accounts AS") ? "account_enrichment" : "candidate_ids";
    if (category === fail) return new Response("https://private:secret@database.invalid", { status: 403 });
    return Response.json({ data: category === "archive_lookup" && legacy
      ? [{ state: JSON.stringify(run()), stopVersion: "0" }]
      : category === "catalog_boundary" ? [{ maxId: 10 }]
      : category === "candidate_ids" ? [{ profileId: 1, profileName: "Private Profile" }]
      : category === "account_enrichment" ? [{ profileId: 1, tier: 1, tierRank: 1,
        accounts: [["private-id", "instagram", "private-handle", "https://www.instagram.com/private/"]] }]
      : [] });
  });
  const lease = { runId: run().id, workerId: "fixture", token: 7, until: Date.now() + 60_000 };
  try {
    assert.equal(await prepareBulkRun(run(), lease, async () => {}), true);
    const categories: PreparationReadCategory[] = ["archive_lookup", "catalog_boundary", "candidate_ids",
      "account_enrichment", "prior_attempts_archive", "prior_attempts_coordinator", "coordinator_checkpoint"];
    for (const category of categories) assert.ok(events.some(e => e.category === category && e.phase === "succeeded"), category);
    for (const category of categories.filter(c => !c.startsWith("coordinator") && c !== "prior_attempts_coordinator")) {
      fail = category;
      await assert.rejects(prepareBulkRun(run(), lease, async () => {}), error =>
        error instanceof PreparationReadError && error.category === category);
    }
    fail = undefined;
    t.mock.method(bulkOwnership, "attempted", async () => { throw new Error("secret coordinator"); });
    await assert.rejects(prepareBulkRun(run(), lease, async () => {}), error =>
      error instanceof PreparationReadError && error.category === "prior_attempts_coordinator");
    await assert.rejects(prepareBulkRun(run(), lease, async () => { throw new Error("secret checkpoint"); }), error =>
      error instanceof PreparationReadError && error.category === "coordinator_checkpoint");
    legacy = true;
    let restoreFails = false;
    t.mock.method(bulkOwnership, "restoreArchived", async () => {
      if (restoreFails) throw new Error("secret restore");
      return run();
    });
    assert.equal(await prepareBulkRun(run(), lease, async () => {}), false);
    assert.ok(events.some(e => e.category === "coordinator_restore" && e.phase === "succeeded"));
    restoreFails = true;
    await assert.rejects(prepareBulkRun(run(), lease, async () => {}), error =>
      error instanceof PreparationReadError && error.category === "coordinator_restore");
    assert.equal(providerCalls, 0);
    assert.doesNotMatch(JSON.stringify(events), /Private Profile|private-handle|private-id|secret|database\.invalid|instagram\.com/);
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("failed preparation saves category and no-admission state using an isolated coordinator", async () => {
  const store = new MemoryStore(), ownership = new BulkOwnership(store);
  const claimed = await ownership.claim(run(), "fixture", "fixture");
  const warnings: unknown[] = [];
  let paid = 0;
  await executeBulkRun(claimed.run, claimed.lease!, {
    ownership, archive: async () => {}, saveHistory: async () => {},
    warn: error => warnings.push(error),
    processItem: async () => { paid++; },
    prepare: async () => { throw new PreparationReadError("prior_attempts_archive", false); },
  });
  const saved = (await ownership.read(run().id))[0];
  assert.match(saved.error!, /prior_attempts_archive/);
  assert.match(saved.error!, /Paid admissions occurred: no/);
  assert.equal(saved.status, "stopped");
  assert.equal(store.attempts.size, 0);
  assert.equal(paid, 0);
  assert.match(String(warnings[0]), /prior_attempts_archive/);
});

test("the final ready checkpoint still attributes coordinator failure before any paid admission", async () => {
  const store = new MemoryStore(), ownership = new BulkOwnership(store);
  const claimed = await ownership.claim(run(), "fixture", "fixture");
  let paid = 0;
  await executeBulkRun(claimed.run, claimed.lease!, {
    ownership, archive: async () => {}, saveHistory: async () => {}, warn: () => {},
    processItem: async () => { paid++; },
    prepare: async saved => {
      saved.preparation!.status = "ready";
      ownership.renew = async () => { throw new Error("https://secret:password@fixture.invalid"); };
      return true;
    },
  });
  const saved = (await ownership.read(run().id))[0];
  assert.match(saved.error!, /coordinator_checkpoint/);
  assert.match(saved.error!, /Paid admissions occurred: no/);
  assert.doesNotMatch(saved.error!, /secret|password|fixture\.invalid/);
  assert.equal(store.attempts.size, 0);
  assert.equal(paid, 0);
});
