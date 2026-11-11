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
