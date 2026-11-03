---
name: Coverage availability
description: Freshness versus availability decision for expensive coverage counts.
---

Keep the last successful coverage counts visible while refreshing, and clearly show their actual computation time when stale. Never substitute zero counts for a failed calculation.

**Why:** The user reported repeated loading-only charts. Discarding valid snapshots on every saved investigation and retrying long reads makes an otherwise functional dashboard appear permanently unavailable.

**How to apply:** Retain the shared in-flight calculation across invalidations, coalesce refreshes, and bound first-load retries. Coverage is a read-only summary: briefly delayed counts are preferable to hiding successful counts, but must not be represented as newly computed evidence.

For bulk donuts, count a unique active profile only when every supported platform is fully resolved: a reference account, an identity-verified link, or an explicit sourced first-party no-account statement. Likely candidates, no-match searches, and provider failures do not count.

**Why:** The user chose an all-platform completion metric rather than a partial discovery-progress count.

**How to apply:** Use the latest assessment for each supported platform and count each catalog profile once only when all platforms satisfy the evidence-backed resolution rule.
