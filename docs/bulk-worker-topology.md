# Bulk worker topology and recovery

## Supported deployment

- Multiple API server processes or hosts may serve requests. Each API process can execute the queue it successfully claims; no separate job daemon is required.
- **Exactly one active bulk queue globally**. Preserve its frozen per-type parallel workers (1–20 each), linked-only discovery for Brands/Creators/Artists, and continuous chunking. Manual selections remain capped at 25 profiles; existing automatic chunks may contain up to 1,000 profiles combined. API replicas do not create extra queues or multiply these lane limits.
- Every participating API must run the upgraded ownership-aware code and connect to the **same writable PostgreSQL primary** via the existing `DATABASE_URL`, and the same ClickHouse archive. Separate PostgreSQL databases, read replicas for coordination, mixed old/new workers, and independently restored coordinator copies are not supported.
- PostgreSQL is an additive coordination/checkpoint store, not a catalog replacement. It holds the singleton lease/fence and per-request state in `profile_bulk_queue` and `profile_bulk_claims`, plus a bounded-key admission history in `profile_bulk_attempts`. Automatic selection consults both that history and legacy ClickHouse attempts, so clearing a continuous chunk never forgets prior paid work. The existing ClickHouse catalog remains read-only; no writes are made to `new_vertical` catalog tables. Snapshots still append to `poc_new_verticals.profile_bulk_events`; successful investigations still go to normal history.
- Coordination tables are created on first bulk access using serialized, additive DDL. The database role needs table-creation privileges initially, then SELECT/INSERT/UPDATE privileges. Models are also declared in `lib/db/src/schema/bulk-coordination.ts`. Missing or unavailable coordination storage fails closed; ordinary searches do not require it.
- Preserve coordinator data across restarts, releases and database failover. Do not delete admission records or reset fences to “unlock” a run. Do not restore the coordinator to an older point while any worker can still run. Stop all workers before a coordinated recovery.

### Upgrade from the advisory-lock runner

1. Stop the old bulk queue and let its current brand finish. Confirm no old worker or paid request remains in flight.
2. Stop/drain **all** old API processes before enabling bulk operations on the new version; a rolling overlap with legacy workers is unsafe because they do not honor fences.
3. Configure the common PostgreSQL primary for every new API. Leave the existing ClickHouse database and data intact.
4. Start upgraded APIs. No jobs launch on startup. Legacy saved results remain readable; legacy runs are imported into coordination only on explicit Stop/Resume. Legacy items still marked running are treated as uncertain, not replayed.

## Ownership, retries and fencing

- Claims run in PostgreSQL transactions under a singleton row lock. Different run IDs contend for the same queue. A duplicated request ID with the same brand set returns its saved run; reusing it for another set conflicts.
- Fencing generations come from the durable monotonic counter, not worker clocks. Claims, admissions, renewals and checkpoints validate worker ID, run ID, generation and an unexpired lease under the same lock.
- The lease lasts 150 seconds and renews every 15 seconds. Time is read from PostgreSQL after acquiring the lock. Once expired, a lease cannot be renewed or used to save results, even if nobody has claimed its replacement.
- Stop POST bodies contain `{ "resumeVersion": <observed generation> }`. Resume additionally requires a stable UUID `requestId` and accepts `launchSource` metadata. Refresh before issuing controls. A Stop from an old generation returns a conflict. Concurrent/retried Resume requests for one observed generation return the same successor, even if that successor has already finished. Accepted request IDs remain recognized across later generations, and launch history is appended atomically with the claim, never twice.
- Before any brand's providers run, its admission is committed durably. All provider fetches within the bulk investigation use an async-context guard, including nested identity resolution and parallel discovery/verification.
- A result and its admission acknowledgement are committed together before processing another brand. Heartbeats cannot overwrite results or erase Stop. ClickHouse archival happens after that commit; failure stops the queue before another brand. API reads prefer the fenced checkpoint over any late archive append, including archived runs outside the recent managed-run window.
- All parallel lanes serialize checkpoint/archive delivery and drain before release. Continuous chunks get deterministic saved archives before a fenced transaction clears their old admission indices. Source cursors and the next bounded chunk are checkpointed before new admissions; capped-run counters and stage progress are preserved.
- Late responses from an expired owner cannot overwrite a successor's authoritative state. Already dispatched remote requests cannot be recalled; a late append to the archive/history is not an authoritative ownership update.

## Crash and outage semantics

There is **no exactly-once billing guarantee** from the external providers. No shared provider idempotency contract exists. The safety guarantee is no automatic replay of an admitted, unacknowledged brand. A crash can occur after a provider charged but before the result was saved, or even after admission but before dispatch.

- Merely reading a run, opening the page, restarting a process or waiting for lease expiry never launches paid work.
- When a lease expires, the saved run is shown as interrupted. An explicit manual Resume acquires a new generation and continues queued brands. Persisted completed results are never reset.
- Acknowledged provider failures may be retried by explicit Resume, which warns about paid requests.
- Unacknowledged brands are marked failed with `retryBlocked: true` and incomplete platform outcomes. Resume skips them permanently for that run. If no safely retryable brands remain, Resume records a stopped run without launching a worker.
- Review the unknown brand's saved evidence and provider activity. If a new paid investigation is intentionally desired, select that brand in a **new run with a new request ID**. This is a new user-authorized spend, not automatic recovery. Do not clear its admission marker.
- Storage errors prevent new provider dispatch. Any in-flight request may still incur charges. Paid estimates exclude some provider credits/failed calls and are not a billing reconciliation.
- The coordinator remains the durable checkpoint if ClickHouse archival fails. Keep it; the next explicit resume retains completed results. There is no automatic archive-repair worker.

## Preparation read diagnostics

Filter application logs by `event: bulk_preparation_read` and `runId`. `requestId`
identifies the accepted Start/Resume request and `generation` identifies the
worker fence. These are application timings, not ClickHouse query-log timings.

- Categories separate `catalog_boundary`, `candidate_ids`, `account_enrichment`,
  `prior_attempts_archive`, `prior_attempts_coordinator`, and `archive_lookup`.
- `coordinator_checkpoint` measures the complete fenced checkpoint wait
  (including the required initial ready-queue archive); `coordinator_restore`
  measures restoring an existing archive. These are operation timings, not
  individual PostgreSQL statement or lock timings.
- Every operation emits `started` then `succeeded` or `failed`, with monotonic
  `durationMs`, a one-based `attempt`, and returned `rowCount`. Unknown counts
  (including failures and checkpoint operations) are `null`, not zero. Catalog
  row counts include any pagination sentinel; they are not selected-profile totals.
- Only catalog reads retain their existing three-attempt transient retry policy.
  Archive reads, prior-attempt checks and coordinator operations do not gain retries.
- Events include no SQL, query parameters, account/profile values, URLs or raw
  error text. Failures use a bounded category and failure kind instead.

`paidAdmissionsOccurred: false` describes this fenced preparation phase, including
its final ready checkpoint, not historical paid work in a restored archive.
No paid admissions are allowed until preparation and that checkpoint succeed.
Read failures retain their category in the stopped run's error and explicitly state
that no paid admissions occurred. A `started` event without a terminal event can
identify an outstanding wait or process interruption; do not infer it from worker
counts. Timings do not cancel requests or change historical-attempt selection SQL.

## Deterministic verification (no paid requests)

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server test
BULK_COORDINATION_DB_TEST=1 pnpm --filter @workspace/api-server test
```

The normal suite uses an atomic in-memory transaction adapter and mocked providers. It covers simultaneous different/same-ID starts, resume retries, stale controls, expiry, crashes before/after admission, completed-result retention, duplicate admission, provider fences, storage outages, the 25-brand cap, and stop-after-current behavior.

The opt-in database test uses the existing development PostgreSQL connection and isolated uniquely named `bulk_test_*` tables. Independent adapters race real transactions, simulate an expired lease without sleeping, restart the adapter, reject stale writes and run mocked recovery. Only those test tables are dropped afterward. It makes no external provider requests and never changes live claim tables, ClickHouse, or catalog data. Do not run against production.
