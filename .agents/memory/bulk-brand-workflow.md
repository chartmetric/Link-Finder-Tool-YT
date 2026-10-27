---
name: Bulk profile workflow
description: User-approved profile types, catalog access boundaries, and paid-run operating constraints.
---

The bulk finder must expose all Brands, Creators, and Artists, including profiles without tiers and profiles with zero, one, or multiple active accounts. Discovery requires at least one usable existing profile link.

**Why:** The user superseded the original one-account cohort with access to all profiles in the new verticals database. They explicitly chose “show them, but require an existing link to run discovery” for profiles with no existing links.

**How to apply:** Never use tier assignment or an exact account-count condition as the catalog inclusion rule. Use current profile classifications (including multi-type membership); Artists correspond to musician. Keep unlinked profiles visible but non-runnable; do not introduce name-only paid discovery. Preserve separate manual selections and the shared floating launcher. Catalog records supply starting identities; newly discovered links still come from external providers.

Bound account/tier enrichment to the profile IDs returned by the catalog page rather than repeatedly embedding the entire profile query in ClickHouse CTEs.

**Why:** ClickHouse expands reused CTEs, so a large current-profile aggregation repeated across account joins makes a small page unnecessarily slow.

**How to apply:** Read the profile page once, then enrich those bounded IDs using parameterized reads. This keeps full-catalog access without full-catalog account enrichment.

Allow explicitly authorized continuous searching through all remaining eligible profiles, with automatic chunk sizes up to 1,000 as requested by the user. The user also wants to pick workers/processors; expose bounded parallel workers per type rather than fixing each type to one.

**Why:** The user requested automatic searching among all eligible profiles, then explicitly requested configurable workers/processors. Keep a conservative default and upper bound because uncontrolled concurrency multiplies provider charges and provider throttling.

**How to apply:** Treat the existing batch cap as a chunk bound, not a total continuous-run cap. Freeze settings and the source-ID ceiling, checkpoint cursors, archive completed chunks before clearing them, and expose paginated archive access. Skip previously attempted profiles automatically, including failed/interrupted attempts; retries require explicit authorization. Preserve completed results and require explicit paid Start/Resume; selecting types, navigating, or restarting the server must never launch work. Optional profile caps count distinct profiles, not physical provider requests; explicit retries may cost more.

Preserve the distinction between finding no account and establishing that an official account is unavailable.

**Why:** The user wants platform-level unavailability, but a public search cannot prove universal nonexistence. Treating failed or empty searches as confirmed absence would misrepresent the evidence.

**How to apply:** Keep incomplete searches separate from completed no-match searches and require a sourced first-party statement for an explicit no-account claim.

Coverage donuts must measure fully resolved platform evidence, not completed investigations or profiles with any known link.

**Why:** The user defined coverage as “we've gathered all available links out there and have confirmed any platforms where that profile genuinely does not have a link.”

**How to apply:** Scope the metric explicitly to supported platforms; unresolved, failed and no-match searches cannot count as confirmed absence. Never claim exhaustive internet-wide discovery from public search evidence.

Keep the bulk run monitor compact, with platform statuses visible and long explanations and evidence available through expandable details.

**Why:** The user requested a more compact monitor after the large summary bar and expanded evidence made a single brand occupy most of the screen.

**How to apply:** Preserve access to source links, confirmed URL aliases, timestamps, candidate results, and cost caveats without expanding all of them by default.
