---
name: Coverage availability
description: Freshness versus availability decision for expensive coverage counts.
---

Keep the last successful coverage counts visible while refreshing, and clearly show their actual computation time when stale. Never substitute zero counts for a failed calculation.

**Why:** The user reported repeated loading-only charts. Discarding valid snapshots on every saved investigation and retrying long reads makes an otherwise functional dashboard appear permanently unavailable.

**How to apply:** Retain the shared in-flight calculation across invalidations, coalesce refreshes, and bound first-load retries. Coverage is a read-only summary: briefly delayed counts are preferable to hiding successful counts, but must not be represented as newly computed evidence.

For bulk donuts, count a unique active profile only when every supported platform has a saved candidate account URL not marked as a mismatch, a completed search with no supported match, or an explicit sourced first-party no-account statement. Completed no-match is a practical search assessment, not proof of absence; provider failures and incomplete searches do not count.

**Why:** The user confirmed that non-mismatch candidate links and completed no-matches should count toward full-platform coverage. Public search cannot prove universal absence, but this is the user's operational coverage rule.

**How to apply:** Use the latest assessment for Instagram, TikTok, and YouTube and count each active catalog profile once only when all three platforms have a non-mismatch candidate URL, a completed no-match, or sourced explicit absence. Never count provider failures or incomplete searches. SQL fixtures must include a non-empty candidate URL; a verification verdict alone is not link coverage. Label no-match as practical assessment, not proof of absence.
