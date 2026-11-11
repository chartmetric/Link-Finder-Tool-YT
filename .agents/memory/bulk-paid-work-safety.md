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

Distinguish a pre-dispatch ownership-fence stop from an uncertain paid request.
A stop journal entry alone does not establish that a provider call was admitted.

**Why:** A deliberately drained gate can journal `stopped_no_retry` after its
owner check fails but before any reservation or network dispatch. Treating that
as a paid uncertainty blocks a safe handoff; ignoring genuine admissions risks
double spending.

**How to apply:** Require the explicit handoff proof and cross-check the locked
owner, admission ledger, reservations and timestamps. Preserve every actual
admission and receipt; never infer replay permission from a journal label.

Parallel continuation must distinguish a known live request from an abandoned
admission, and keep the original platform's evidence policy sealed.

**Why:** A global zero-pending rule serializes all artists, but simply dropping
that rule permits new spending after an unknown outcome. Concurrent policy
merges can also silently change results if a new executor copies mutable source.

**How to apply:** Allow only bounded requests registered live by the current
owner, keep each artist sequential and enforce the earliest-tier barrier. Close
dispatch on the first failure, drain already-sent responses, then stop. Bind a
new execution supplement to reconciled histories without resetting charges,
original approvals or terminal artists; copy evidence dependencies from that
platform's previous sealed runtime, not newer source.

Pausing a sealed worker without a cooperative pause handler requires a drained
admission boundary, not killing its process or changing its owner mid-request.

**Why:** An already-sent response can be saved locally yet fail its transactional
return check after an ownership/status fence, leaving an unnecessarily uncertain
charge that blocks recovery.

**How to apply:** Lock the platform coordinator, confirm zero admitted/unreturned
requests, and fence new dispatch atomically at that boundary. If pending work
exists, release the lock so its receipt can commit and wait for a safe boundary.
Keep the other platform independent and preserve the explicit pause approval.

Changing scheduler width requires a whole-artist handoff, not merely a moment
with no pending provider requests.

**Why:** A sequential artist has gaps between its paid requests. Stopping in
one of those gaps leaves an unfinished artist even if every prior charge returned,
so an untouched-work continuation cannot safely reconcile it.

**How to apply:** For scheduler replacement, lock the coordinator and require
both zero pending admissions and zero in-progress artists before fencing the old
owner. Rolling workers must include in-progress artists when enforcing the
earliest-tier barrier, serialize progress writes, and drain live responses on
both worker failures and catalog-preparation failures.

Concurrent failure timestamps do not reliably identify the original failing
lane; preserve a sanitized first-failure source location.

**Why:** After a shared dispatch gate closes, other lanes fail at their next
admission. Their database failure rows may be written before the original
failure's row, and a generic assertion label alone cannot distinguish the cause.

**How to apply:** Record the first exception's allowed source filename and
line without raw assertion values, provider bodies or full filesystem paths.
Do not infer a root cause from the first failed artist or replay charged work
to recreate the error; retain exact receipts and investigate offline.

Rolling schedulers must reserve prepared identities before asynchronous database
claims finish, not only exclude artists already marked in progress.

**Why:** A constrained connection pool can delay a new claim while another lane
finishes. A refill then sees the prepared artist as queued, selects it again,
and triggers a duplicate-claim safety stop even though no paid call was repeated.

**How to apply:** Exclude all locally prepared or active identities from each
refill query, retain the transactional claim as the authoritative cross-process
fence, and regression-test delayed claims alongside fast completions.

Keep catalog preparation batch size separate from paid-worker concurrency.

**Why:** Preparing context separately for each newly free slot can leave most
paid slots idle waiting for repeated read-only catalog queries. Increasing the
worker limit alone does not remove that bottleneck.

**How to apply:** Prepare bounded same-tier context groups, buffer only untouched
identities without claiming or charging them, and keep paid slots independently
refilled. Discard unused buffered context on a stop; retain live tier, ownership,
admission and receipt fences.

Deadline escalation needs verified provider capacity and measured sustained
throughput, not just a larger worker number.

**Why:** A completion deadline can require an order-of-magnitude increase.
Concurrency recommendations differ from request-rate limits, and preparation
helpers may have smaller artist-count bounds than the scheduler.

**How to apply:** Verify official provider guidance, ramp capacity with paced
admissions, keep preparation inside the sealed metadata policy's bounds, and
preserve every receipt and stop fence. Treat a finish time as unproven until
actual sustained completions meet the required rate; never weaken identity
checks or replay charges to make a deadline appear satisfied.
