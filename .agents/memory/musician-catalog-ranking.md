---
name: Musician catalog ranking
description: Why the enrichment catalog ranks by tier rank instead of globally sorting raw follower snapshots.
---

Use the precomputed global musician tier and tier rank for interactive catalog ordering. Fetch latest Instagram follower counts only for accounts on the visible page and show them as context.

**Why:** A global latest-follower aggregation over account snapshots scanned hundreds of millions of rows and took roughly half a minute, while tier rank is already computed for this purpose.

**How to apply:** Keep tier filtering and tier-rank/name sorting server-side. Do not add global follower sorting unless a dedicated pre-aggregated table or materialized view becomes available.