---
name: Bulk profile workflow
description: User-approved profile types, catalog access boundaries, and paid-run operating constraints.
---

Do not show a separate paid-request acknowledgement checkbox in the automatic bulk launcher.

**Why:** The user has repeatedly asked to delete this element.

**How to apply:** Keep the explicit Start action usable without that checkbox. Preserve the paid-service notice and continuous-run confirmation; do not restore checkbox gating during unrelated changes.

The bulk finder must expose all Brands, Creators, and Artists, including profiles without tiers and profiles with zero, one, or multiple active accounts. Discovery requires at least one usable existing profile link.

**Why:** The user superseded the original one-account cohort with access to all profiles in the new verticals database. They explicitly chose “show them, but require an existing link to run discovery” for profiles with no existing links.

**How to apply:** Never use tier assignment or an exact account-count condition as the catalog inclusion rule. Default to all tiers including unranked profiles, with optional name/handle search and tier filters before a run. Use current profile classifications (including multi-type membership); Artists correspond to musician. Keep unlinked profiles visible but non-runnable; do not introduce name-only paid discovery. Preserve separate manual selections and the shared floating launcher. Catalog records supply starting identities; newly discovered links still come from external providers.

Bound account/tier enrichment to the profile IDs returned by the catalog page rather than repeatedly embedding the entire profile query in ClickHouse CTEs.

**Why:** ClickHouse expands reused CTEs, so a large current-profile aggregation repeated across account joins makes a small page unnecessarily slow. Broad no-match searches can also time out if the entire profile catalog is aggregated before narrowing matching identities.

**How to apply:** Read the profile page once, then enrich those bounded IDs using parameterized reads. For search, narrow identities using latest matching names and linked handles before aggregating current profile classifications. This keeps full-catalog access without full-catalog account enrichment; check no-match searches as well as successful matches.

Candidate-catalog filters and saved-run review filters are separate product scopes.

**Why:** The user explicitly scoped name/handle search and tiers to finding eligible profiles before starting a batch, not to reviewing saved results.

**How to apply:** Keep catalog filtering read-only and independent of paid Start/Resume and saved-run review. Do not reinterpret a candidate filter as a change to which saved outcomes need review.

Allow explicitly authorized continuous searching through all remaining eligible profiles, with automatic chunk sizes up to 1,000 as requested by the user. The user also wants to pick workers/processors; expose bounded parallel workers per type rather than fixing each type to one.

**Why:** The user requested automatic searching among all eligible profiles, configurable workers/processors, and automatic-launcher defaults of 500 profiles per run and 20 parallel workers. Keep the existing upper bounds because concurrency multiplies provider charges and provider throttling.

**How to apply:** Preserve the distinction between an explicitly approved continuous run and automatic work triggered by navigation or recovery. A chunk boundary is not a new paid authorization. Follow the current operational constraints in `replit.md`; do not treat a distinct-profile cap as a guarantee about provider charges.

Preserve the distinction between a completed no-match and proof that an official account is unavailable.

**Why:** A public search cannot prove universal nonexistence. The user accepts a completed no-match as an operational resolution, but it must not be represented as proof of absence.

**How to apply:** Keep incomplete searches separate from completed no-matches. A completed no-match means required search providers finished without a supported URL; it counts toward coverage but not as a sourced explicit no-account claim.

Profile-type pages must show processed, successful, failed, running and queued counts for the selected type, not a globally remembered run's combined totals.

**Why:** The user reported identical totals while switching Brands, Creators and Artists and expects those tabs to scope progress.

**How to apply:** Keep per-type summaries distinct from the run-wide monitor and floating multi-type launcher. Include archived continuous chunks in per-type totals; a shared run cap must not be presented as each type's individual denominator.

Coverage donuts count full-platform search coverage, not strict identity verification: each platform needs a saved non-mismatch link candidate, a completed no-match, or a sourced explicit no-account statement.

**Why:** The user confirmed non-mismatch link candidates count even when likely or unverified, and then explicitly chose to count completed no-matches as resolved coverage. Neither result is proof of identity or universal absence.

**How to apply:** Use the latest assessment for Instagram, TikTok, and YouTube; count a profile only when all three platforms meet the candidate-link, completed-no-match, or sourced-absence rule. Keep provider failures and incomplete searches uncovered. Label this separately from JEV identity verification and never claim exhaustive internet-wide discovery.

A finished processing job must not be presented as a successfully resolved profile when platform searches failed or remain unknown.

**Why:** The user specifically challenged green “Completed” cards for profiles with all three platform outcomes marked incomplete, and asked to distinguish genuinely sourced no-account evidence from failed searches.

**How to apply:** Keep processing state separate from visible search outcome. Distinguish incomplete searches, partial results, completed searches with no supported match, and sourced first-party no-account statements. Missing assessments or missing absence sources stay unresolved. Apply presentation to saved results without automatically repeating paid work.

Treat “remaining” as never previously attempted, not just “not completed.” Keep uncertain paid attempts out of new automatic batches; reviewing and retrying interrupted work is a separate workflow.

**Why:** The user wants successive new batches to advance without silently paying for the same work. A failed or interrupted lookup may have incurred charges without producing a completed result, and resetting a run for resume must not erase that risk. Parsing every full-result snapshot can also exceed the database request budget as history grows.

**How to apply:** Preserve evidence of prior starts across all saved history, not only recent runs or the latest run state. Use lossless identity prefilters to reduce deep JSON parsing rather than truncating history; prefilters must handle JSON escaping and whitespace. Untouched queued profiles remain eligible. Explicit reruns must explain that users may pay again.

Keep the bulk run monitor compact, with platform statuses visible and long explanations and evidence available through expandable details.

**Why:** The user requested a more compact monitor after the large summary bar and expanded evidence made a single brand occupy most of the screen.

**How to apply:** Preserve access to source links, confirmed URL aliases, timestamps, candidate results, and cost caveats without expanding all of them by default.
