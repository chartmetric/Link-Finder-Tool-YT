---
name: Coverage availability
description: Freshness versus availability decision for expensive coverage counts.
---

Keep the last successful coverage counts visible while refreshing, and clearly show their actual computation time when stale. Never substitute zero counts for a failed calculation.

**Why:** The user reported repeated loading-only charts. Discarding valid snapshots on every saved investigation and retrying long reads makes an otherwise functional dashboard appear permanently unavailable.

**How to apply:** Retain the shared in-flight calculation across invalidations, coalesce refreshes, and bound first-load retries. Coverage is a read-only summary: briefly delayed counts are preferable to hiding successful counts, but must not be represented as newly computed evidence.

For bulk donuts, count a unique active profile only when every supported platform has a saved candidate account URL not marked as a mismatch, or an explicit sourced first-party no-account statement. Likely and unverified candidates count as link coverage, not identity verification; no-match searches and provider failures do not count.

**Why:** The user wants the chart to show full-platform link coverage or confirmed absence, and noted that strict identity-verification counts hide candidate links found by bulk runs.

**How to apply:** Use the latest assessment for Instagram, TikTok, and YouTube and count each active catalog profile once only when all three platforms satisfy the candidate-link-or-confirmed-absence rule. Label candidates as unverified coverage, not confirmed identity.
