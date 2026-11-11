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

The original Instagram pilot ceiling must be cut over from a reviewed set of historical admission journals, never a single script's cumulative summary.

**Why:** Separate verification experiments historically carried their own prior-reservation checkpoints. A locally correct summary does not prove that another process has not already reserved the remaining allowance.

**How to apply:** Drain old experiment processes before seeding the shared ledger, include uncertain admissions, and permanently exclude historical run identities. Do not infer a seed from a hardcoded checkpoint or reset an existing ceiling. See `scripts/INSTAGRAM_PILOT_BUDGET.md` for the deliberate operator cutover; deploying code alone must not authorize new spending.

Tests must isolate transactional coordination as well as HTTP providers.

**Why:** A fetch-only mock no longer contains a bulk-run test once claims use PostgreSQL; such a test can create real development leases even while every provider and ClickHouse request is mocked.

**How to apply:** Use an injected in-memory coordinator for ordinary runner tests. Opt-in real-database tests must use uniquely named test-only tables and remove them afterward, never the application's live claim tables.

Catalog preparation is a fenced, pre-paid phase, separate from accepting a launch.

**Why:** Selecting a large cohort can exceed an HTTP deadline before any run exists, encouraging repeated starts. Catalog delays must not be confused with failed paid lookups or justify replaying provider work.

**How to apply:** Save and acknowledge the launch before catalog selection, checkpoint preparation in the shared coordinator, and block all paid admissions until selection is validated. Explicit resume may repeat read-only selection, but never uncertain paid work. Check for an older archive under the same request ID before writing a new archive snapshot; preserve its results and uncertain admissions.

Cancelling a catalog HTTP request is not proof that the remote database query terminated; server cancellation is supplemental, not a paid-work safety fence.

**Why:** ClickHouse can deny query cancellation under the existing role, and server execution deadlines are checked cooperatively. Broadening database privileges is not authorized merely to improve Stop responsiveness.

**How to apply:** Keep generation-checked admission and result-write fences authoritative. Set server execution limits before dispatch, narrowly target best-effort cancellation, and explain its limits without holding up the saved Stop state.

Historical attempt evidence may be reused only within one fenced, pre-paid selection, not across resumes or paid continuous chunks.

**Why:** Re-reading large result archives for every catalog page caused preparation to exceed ClickHouse's execution deadline. A selection-scoped identity snapshot avoids repeated scans, but reusing its negative results after paid work could admit duplicate charges. The shared queue's exclusive owner prevents concurrent paid admission during that selection.

**How to apply:** Read all historical admissions, including older snapshots hidden by later queued/reset states, and retain profile IDs even without an account ID. Extract only admission and identity fields, discard the selection snapshot at each chunk/resume boundary, and continue checking the transactional coordinator. Never treat an archive read failure as empty history.

Provider credit exhaustion must stop the shared run, not merely mark individual search methods incomplete.

**Why:** The user approved automatic stops after a provider credit failure allowed a batch to continue calling other paid providers.

**How to apply:** Close every lane's dispatch gate, persist a generation-checked stop and a sanitized provider-specific reason, and preserve existing results. Already-dispatched requests may still charge; do not replay them. Never automatically resume after funding or a server restart, and never expose raw provider error bodies or credentials. Ordinary rate limiting without credit-exhaustion evidence is not the same condition.

A graceful drain can cancel an admission before dispatch; that cancellation needs its own durable proof.

**Why:** Changing research-worker concurrency exposed claims saved immediately before a stop. They were safely returned to queued without a network call, but an unreconciled local admission journal then blocked legitimate continuation as uncertain paid work.

**How to apply:** Record explicit pre-dispatch cancellation only after saving the untouched queued state. A later admission must reinstate protection. Never clear an admission merely because a replica returns queued, and never infer cancellation once a provider request might have started.

Billing recovery is an explicit funding attestation, not proof of a funded provider balance.

**Why:** A fresh run or resume must not spend an initial parallel cohort merely to rediscover a known credit outage. Provider probes can themselves charge, and a restart does not change the provider's billing state.

**How to apply:** Keep unresolved billing evidence shared and durable. Clear only the currently observed incident after deliberate confirmation, without an active queue; do not probe providers, restart runs, or reset uncertain admissions as part of clearing. Explain that the next paid launch still requires its own explicit action.

High concurrency can saturate the globally serialized bulk coordinator and exceed its PostgreSQL row-lock timeout.

**Why:** A 20-worker brand run safely stopped when a coordinator transaction hit the five-second lock timeout; provider billing health was clear.

**How to apply:** Treat this as coordinator contention, not provider-credit exhaustion. Before increasing workers or resuming, check queued and uncertain admissions; load-test coordinator contention and never replay work whose paid outcome is unknown.

Original pilot spending reconciliation must include all archived paid-admission
formats, not only the latest experiment's summary.

**Why:** Earlier experiments stored profile identity in frozen case scopes or
admission keys rather than a uniform row field. Assuming one journal schema
can lose identities or undercount previously reserved work.

**How to apply:** Recover identities only from explicit archived bindings,
preserve failed/uncertain reservations, and block on unreadable or unbound
history. Keep conservative reservations separate from provider-reported charges.

A newly approved batch budget is a separate authorization, not a reset or
increase of an older pilot's ceiling.

**Why:** The user authorized a larger research batch after the original pilot
had already incurred reservations; combining the allowances would obscure
which work each approval covered.

**How to apply:** Freeze each batch's scope and ceiling separately, retain all
historical reservations, and keep uncertain calls non-replayable across batches.

Long-running paid campaigns should execute a sealed, isolated copy of their
reviewed code rather than silently adopting application merges mid-run.

**Why:** Other approved tasks can merge while a campaign runs for hours or days.
Changing its verification policy mid-campaign makes outcomes incomparable;
fingerprinting mutable workspace files also turns unrelated merges into stops.

**How to apply:** Seal the local dependency graph before the first admission and
bind its fingerprints to the same approved scope. Keep the progress observer
separate. New policies need a deliberate later cutover; never patch the active
copy or reset an already launched campaign to adopt new code.
