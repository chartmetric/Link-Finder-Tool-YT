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

A daily refresh can move an artist between Tiers 1–5 without changing the artist's
identity. Keep the starting tier and current tier separate when refreshing proof.

**Why:** An exact frozen tier check can fail after an ordinary daily update even
when the artist remains within the approved tier range.

**How to apply:** Preserve the original queue and saved searches, bind current
eligibility in a new proposal, and defer missing current rows without calling them
no-matches. Do not patch sealed workers or transfer an old exact-plan approval to
a changed proposal, even when its remaining request count and cap are lower.

After an interrupted chunk, reconstruct remaining work by identity, not by
subtracting a count from the frozen queue. Keep never-inspected artists pending;
preserve deferrals even when they occur after the last paid artist.

**Why:** An interrupted chunk contains placeholders for untouched artists, while
eligibility deferrals can be scattered throughout that selection. Counts alone
can skip untouched artists or replay already paid ones.

**How to apply:** Reconcile all saved child outcomes and paid admissions first.
Exclude terminal and deferred identities, then process the remaining identities
in original frozen order without changing the original denominator or approval.

The newest computation date is not proof of a complete global tier snapshot.

**Why:** A deferred cohort still had older Tier 2–5 assignments while other
artists had newer computation dates. The catalog retains the latest row per
artist, so filtering every artist to the single newest date can hide existing
assignments. Available rows do not explain why the upstream producer did not
refresh a particular artist.

**How to apply:** In audits, inspect each artist's latest available global tier
and its age, distinguishing stale assignments from demotion or deletion. Older
assignments are not automatic proof of current eligibility. Preserve frozen
policies and obtain approval before changing date/freshness rules or restarting
deferred paid work.

The user explicitly authorized searching the previously deferred Instagram
cohort using its last-known Tier 2–5 assignments despite the older update date.
This is a cohort-specific exception, not a general removal of freshness checks.

**Why:** After the stale-tier explanation, the user instructed “still run them.”
The existing uncapped Instagram spending authorization remains applicable.

**How to apply:** Bind the exception to the investigated identities; preserve
prior paid and uncertain-attempt exclusions, recheck active catalog identity and
catalog Instagram absence, and keep the normal freshness policy for future runs.
Do not use the exception to authorize YouTube work or replay completed searches.

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
