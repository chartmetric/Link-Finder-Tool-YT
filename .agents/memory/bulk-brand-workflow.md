---
name: Bulk profile workflow
description: User-approved profile types, catalog access boundaries, and paid-run operating constraints.
---

The bulk finder supports Brands, Creators, and Artists across all tiers, with “one distinct active linked account.”

**Why:** The user initially selected brands and the account-based interpretation of one link, then explicitly expanded the tool to creators and artists with a navigation bar and a floating widget for simultaneous cross-type runs.

**How to apply:** Keep the account-based eligibility rule and unrestricted tier scope unless the user changes them. Artists correspond to the catalog's musician cohort. Keep each type's manual selection separate and the shared floating launcher available across navigation. The bulk selection is a specific exception to the earlier prohibition on database discovery: catalog records supply starting identities; newly discovered links still come from external providers.

Keep simultaneous cross-type processing bounded within one shared paid run: one active profile per type and a combined batch cap, not an unrestricted number of workers or independent batches.

**Why:** The user needs simultaneous profile types, but unbounded parallel batches multiply provider charges and complicate Stop and saved-progress guarantees.

**How to apply:** Serialize saved snapshots across lanes, wait for in-flight profiles when stopping or encountering persistence failure, and deduplicate shared catalog identities across scopes. Preserve completed results and require explicit paid Start/Resume; selecting types or navigating must never launch work.

Preserve the distinction between finding no account and establishing that an official account is unavailable.

**Why:** The user wants platform-level unavailability, but a public search cannot prove universal nonexistence. Treating failed or empty searches as confirmed absence would misrepresent the evidence.

**How to apply:** Keep incomplete searches separate from completed no-match searches and require a sourced first-party statement for an explicit no-account claim.

Keep the bulk run monitor compact, with platform statuses visible and long explanations and evidence available through expandable details.

**Why:** The user requested a more compact monitor after the large summary bar and expanded evidence made a single brand occupy most of the screen.

**How to apply:** Preserve access to source links, confirmed URL aliases, timestamps, candidate results, and cost caveats without expanding all of them by default.
