---
name: Campaign observation boundary
description: Safe cross-environment progress reporting while paid campaign code is frozen.
---

Introduce progress mirroring as a separately launched, approval-bound, read-only
observer rather than modifying or restarting a campaign with a frozen code
fingerprint. A progress reader must never start or recover paid work.

**Why:** Progress files are deliberately excluded from published builds, but
changing frozen executors merely to report progress can stop approved automatic
continuation. Shared observation must not become a new spending authorization.

**How to apply:** Preserve the original whole-queue identity and denominator,
mirror only counters into shared storage, and coordinate the observer separately
from worker deployment or recovery. Keep the worker's last evidence timestamp
distinct from snapshot upload time: an alive observer, website poll, or API
restart is not proof that the paid worker is alive. A stale snapshot must retain
its counters with an explicit freshness warning.

Scope placeholders can legitimately repeat across interrupted chunks and later
continuations. Observers must distinguish these from repeated completed work.

**Why:** Interrupted chunks retain every selected artist, including untouched
ones. Rejecting all repeated identities stopped progress publication while the
paid worker continued, leaving the page stuck at an early percentage.

**How to apply:** Preserve identity consistency across every occurrence, count
only processed evidence, and still reject two completed identity decisions for one artist.
Do not clear the archive or restart paid work to repair an observer.
Keep the original queue and approval files intact when an additional approval
removes the total ceiling; bind that approval to the original digest. A legacy
campaign name containing a dollar amount is an identity, not the current cap.
Null explicitly means no total spending cap, not zero or an absent setting.

Continuation preparation evidence must yield to a newer coordinator checkpoint,
not merely to a launch-attempt file. Preparation timestamps are never worker activity.

**Why:** A launch can fail before claiming the coordinator. Returning its older
completed checkpoint then regresses the snapshot clock, so publication rejects it
and the previous requested label remains visible indefinitely.

**How to apply:** Keep the newest request's launch or terminal preparation evidence
until the coordinator advances beyond that request; never infer paid-worker
liveness from a preparer process, launch attempt, or successful observer upload.

**Why:** The user approved uncapped continuation while the paid worker's
dependencies remained frozen. Reporting must not rewrite authorization or
present the retired ceiling as current.

**How to apply:** Change only the separate read-only observer and reporting
contract; retain historical cap labels on legacy snapshots until refreshed.
