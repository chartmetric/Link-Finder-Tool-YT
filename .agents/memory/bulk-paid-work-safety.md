---
name: Bulk paid-work safety
description: Why uncertain provider work cannot be replayed and why coordination is additive to ClickHouse.
---

Bulk recovery must not automatically retry admitted work whose provider outcome is unknown.

**Why:** Providers do not share an idempotency contract. A worker can die after a charge but before saving its result; lease expiry alone cannot prove the request never happened. Exactly-once billing cannot be inferred from a queue lease.

**How to apply:** Preserve uncertain admissions across worker generations. Manual resume may continue untouched work and explicitly retry acknowledged failures, but an uncertain brand requires provider review and a deliberately new run before new spend.

Distributed coordination supplements ClickHouse; it must not replace the existing catalog or result archive.

**Why:** The assigned scope explicitly preserves ClickHouse and forbids writes to the catalog. Append-only analytical snapshots cannot safely serve as atomic distributed claims.

**How to apply:** All upgraded workers must share a transactional coordinator. Drain legacy workers before cutover; never silently fall back to advisory snapshots or local locks when the coordinator is unavailable.

Tests must isolate transactional coordination as well as HTTP providers.

**Why:** A fetch-only mock no longer contains a bulk-run test once claims use PostgreSQL; such a test can create real development leases even while every provider and ClickHouse request is mocked.

**How to apply:** Use an injected in-memory coordinator for ordinary runner tests. Opt-in real-database tests must use uniquely named test-only tables and remove them afterward, never the application's live claim tables.
