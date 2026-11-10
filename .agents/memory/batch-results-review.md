---
name: Batch results review
description: User requirements for reviewing batch findings and metadata in the artists page.
---

Batch results must expose everything included in the findings CSV, using progressive disclosure rather than removing detail to simplify the interface.

**Why:** The user asked for an on-page component for each batch because the CSV contains too much information to show at once. Earlier feedback specifically required visible artist names and Instagram URLs, including candidates that were not accepted.

**How to apply:** Keep the artist and candidate/accepted-link distinction easy to find. Make the full metadata and original evidence accessible on demand. Preserve the distinction between metadata actually supplied to the checker and metadata merely available; incomplete capture or an unaccepted candidate must not be presented as proof of an absent account.

In comparison exports, ordinary result columns must describe the latest check.
Label earlier decisions and inputs explicitly as previous values.

**Why:** Leaving old false flags and old scores in the main columns made a
successful recheck appear to have no likely matches when the user opened the CSV.

**How to apply:** Keep the main status, likely-match flag, score, verdict, reason,
model and metadata-used fields aligned to the same observation. Preserve the
historical records and expose their values separately; never silently update
live-link ownership when correcting an export.

Treat saved-run grouping as display-only identity, not a spending ledger or permission to resume.

**Why:** Checkpoints repeat cumulative parent spending, and a final saved summary can describe a stopped run. Adding snapshots together or equating finality with successful completion would misrepresent the evidence.

**How to apply:** Keep older archives immutable, preserve each observation's amounts and ordering, and use legacy identity inference only when structured metadata is absent—not to override malformed explicit metadata.
