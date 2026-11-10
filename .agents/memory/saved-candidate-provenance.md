---
name: Saved candidate provenance
description: Distinguish the larger saved search pool from richer local recheck captures.
---

Local recheck archives are not the complete saved musician-candidate pool.
Other saved discovery records may contain search URLs, titles and snippets
without captured account biographies or identity metadata.

**Why:** A next-batch request initially looked limited by the local archives,
but ClickHouse contained a much larger search-only pool. Reusing those records
is not an evidence-equivalent continuation of a profile-metadata-rich batch.

**How to apply:** Check both sources before claiming saved artists are exhausted.
Exclude the prior artist cohort before selecting another batch. Label search
snippets separately from captured account facts; never copy a search title or
snippet into an account display name or biography. If missing account details
would require provider calls, disclose the evidence difference and obtain
approval rather than silently expanding a saved-only run.

Do not join a musician cohort to a similarly named catalog table by numeric
profile ID alone. Confirm the profile/Chartmetric artist identity pair first.

**Why:** Parallel catalog schemas can return plausible account rows for
overlapping numeric IDs even when their profile records belong to a different
identity model. A nonempty account query is not validation of that join.

**How to apply:** Reuse the musician metadata query builder's source model,
freeze the returned profile and account bindings, and reject identity mismatches
before any provider admission. Do not silently substitute another catalog model.
