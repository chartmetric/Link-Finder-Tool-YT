---
name: Campaign eligibility deferrals
description: Handle refreshed tier snapshots without stopping all paid work or treating missing eligibility as a no-match.
---

Defer queued artists whose current tier/identity/no-link eligibility cannot be
confirmed. Do not permanently remove them from the frozen queue or count them as
processed, a failed search, or a completed no-match. Revalidate the eligible paid
subset separately and preserve the original whole-queue progress denominator.

**Why:** A refreshed global tier snapshot omitted several otherwise active artist
profiles. Requiring every frozen selection member to remain eligible stopped the
entire campaign before paid work; missing snapshot rows did not prove permanent
ineligibility.

**How to apply:** Retain deferred identities and reasons, bind child proof and
requests to the fresh eligible subset, and preserve unfinished preparation
directories. Recovery preparation stays read-only; only an explicitly approved
restart may take ownership and admit new paid work under the unchanged shared cap.

After an interrupted chunk, reconstruct remaining work by identity, not by
subtracting a count from the frozen queue. Keep never-inspected artists pending;
preserve deferrals even when they occur after the last paid artist.

**Why:** An interrupted chunk contains placeholders for untouched artists, while
eligibility deferrals can be scattered throughout that selection. Counts alone
can skip untouched artists or replay already paid ones.

**How to apply:** Reconcile all saved child outcomes and paid admissions first.
Exclude terminal and deferred identities, then process the remaining identities
in original frozen order without changing the original denominator or approval.

The user wants artist sourcing prioritized strictly Tier 1, then 2, 3, 4, 5,
not saved candidates across all tiers before fresh discovery.

**Why:** The user explicitly asked for this order on the active campaign.
Saved-first execution otherwise checks lower-tier artists while higher-tier
artists without candidates remain untouched.

**How to apply:** Tier must be the first pending-work priority for both
platforms. Preserve completed work, paid admissions and the frozen denominator.
If an existing approval froze another ordering, prepare a separate, explicit
handoff that retains the original queue for audit. Higher-tier fresh discovery
must be supported, not silently skipped in favor of lower-tier saved candidates.
