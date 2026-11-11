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
only processed evidence, and still reject two terminal decisions for one artist.
Do not clear the archive or restart paid work to repair an observer.
