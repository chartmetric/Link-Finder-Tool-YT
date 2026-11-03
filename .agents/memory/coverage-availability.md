---
name: Coverage availability
description: Freshness versus availability decision for expensive coverage counts.
---

Keep the last successful coverage counts visible while refreshing, and clearly show their actual computation time when stale. Never substitute zero counts for a failed calculation.

**Why:** The user reported repeated loading-only charts. Discarding valid snapshots on every saved investigation and retrying long reads makes an otherwise functional dashboard appear permanently unavailable.

**How to apply:** Retain the shared in-flight calculation across invalidations, coalesce refreshes, and bound first-load retries. Coverage is a read-only summary: briefly delayed counts are preferable to hiding successful counts, but must not be represented as newly computed evidence.

For bulk donuts, count a unique active profile when it has at least one saved supported-platform link candidate (including likely matches) or when all supported platforms are fully resolved. Keep the strict fully-resolved count distinct in the breakdown.

**Why:** The user does not have capacity to manually review every candidate; a link-found metric should show discovery progress without treating candidates as verified or claiming no-result means absence.

**How to apply:** Use a profile-level union across platform assessments so candidates are counted once. Candidate presence is enough for the donut numerator; profiles with no candidate require full resolution on every supported platform.
