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

Keep simultaneous cross-type processing bounded within one shared paid run: one active profile per type and a combined batch cap, not an unrestricted number of workers or independent batches.

**Why:** The user needs simultaneous profile types, but unbounded parallel batches multiply provider charges and complicate Stop and saved-progress guarantees.

**How to apply:** Serialize saved snapshots across lanes, wait for in-flight profiles when stopping or encountering persistence failure, and deduplicate shared catalog identities across scopes. Preserve completed results and require explicit paid Start/Resume; selecting types or navigating must never launch work.

Preserve the distinction between finding no account and establishing that an official account is unavailable.

**Why:** The user wants platform-level unavailability, but a public search cannot prove universal nonexistence. Treating failed or empty searches as confirmed absence would misrepresent the evidence.

**How to apply:** Keep incomplete searches separate from completed no-match searches and require a sourced first-party statement for an explicit no-account claim.

Keep the bulk run monitor compact, with platform statuses visible and long explanations and evidence available through expandable details.

**Why:** The user requested a more compact monitor after the large summary bar and expanded evidence made a single brand occupy most of the screen.

**How to apply:** Preserve access to source links, confirmed URL aliases, timestamps, candidate results, and cost caveats without expanding all of them by default.
