---
name: Coverage availability
description: Freshness versus availability decision for expensive coverage counts.
---

For Tier 1–5 missing-link campaign denominators, the user wants artists missing
that platform's catalog link, not artists missing both Instagram and YouTube.

**Why:** The user explicitly selected “Missing that platform’s link” when asked
whether having either platform should exclude an artist from both.

**How to apply:** Missing catalog Instagram determines Instagram eligibility;
missing catalog YouTube determines YouTube eligibility. Having the other
platform's link does not exclude the artist. Saved candidates are separate from
catalog links. Keep each approved campaign's frozen denominator distinct from
newly refreshed catalog-wide eligibility counts.

The artist workload includes profiles missing either catalog Instagram or
catalog YouTube, or both. Source only the missing platform for each artist.
Saved candidates alone never exclude an artist from that platform's workload.

**Why:** The user clarified that missing catalog links, not missing candidates,
determine the real bulk sourcing work.

**How to apply:** Use a union of eligible artist IDs for any combined artist
count, while keeping each platform's own queue and denominator separate. Do not
add the platform denominators together because artists can be in both.

Keep the last successful coverage counts visible while refreshing, and clearly show their actual computation time when stale. Never substitute zero counts for a failed calculation.

**Why:** The user reported repeated loading-only charts. Discarding valid snapshots on every saved investigation and retrying long reads makes an otherwise functional dashboard appear permanently unavailable.

**How to apply:** Retain the shared in-flight calculation across invalidations, coalesce refreshes, and bound first-load retries. Coverage is a read-only summary: briefly delayed counts are preferable to hiding successful counts, but must not be represented as newly computed evidence.

For bulk donuts, count a unique active profile only when every supported platform has a saved candidate account URL not marked as a mismatch, a completed search with no supported match, or an explicit sourced first-party no-account statement. Completed no-match is a practical search assessment, not proof of absence; provider failures and incomplete searches do not count.

**Why:** The user confirmed that non-mismatch candidate links and completed no-matches should count toward full-platform coverage. Public search cannot prove universal absence, but this is the user's operational coverage rule. The user also emphasized that some artists genuinely do not have Instagram accounts; finding a URL for every artist is not the goal.

**How to apply:** Use the latest assessment for Instagram, TikTok, and YouTube and count each active catalog profile once only when all three platforms have a non-mismatch candidate URL, a completed no-match, or sourced explicit absence. Never count provider failures or incomplete searches. SQL fixtures must include a non-empty candidate URL; a verification verdict alone is not link coverage. Label no-match as practical assessment, not proof of absence. Evaluate supported links and completed no-matches separately; do not force weak attributions or treat URL yield alone as success.

For Instagram research history, treat each `(run_id, profile_id)` as one attempt because event rows also record state transitions within that attempt. Count unique profiles separately across attempts, and use the latest saved state for each attempt's outcome.

**Why:** Research event rows are append-only lifecycle snapshots, while a new run for the same profile is a distinct retry. Raw event-row counts inflate both attempts and profile totals.

**How to apply:** Aggregate events by run and profile before daily outcome totals; use distinct profile IDs for unique and cumulative profile counts.

Catalog-scale coverage membership must use a set-based join or `IN`, not a
materialized catalog array searched once for every artist.

**Why:** Repeated coverage reads exceeded their deadline even after historical
sources were removed; the actual bottleneck was linear array membership across
the entire catalog, repeated for every tiered profile.

**How to apply:** Check membership complexity before increasing timeouts or
discarding evidence sources. Keep the visible research-source scope explicit if
a new platform initially includes only catalog links and a limited research archive.

Include current campaign likely matches in combined coverage, but keep their
category visibly separate from catalog links.

**Why:** The user approved connecting campaign findings to coverage, then
clarified that a separate live counter without changing the headline percentage
did not meet their expectation. Suggestions are not permission to add catalog links.

**How to apply:** Show source-labelled counts and their own evidence timestamps.
Combine distinct artist identities with matching catalog identities and current
tier membership, assigning each artist to only one category: catalog, supported
research, then campaign likely. Never add aggregate campaign totals to coverage.
