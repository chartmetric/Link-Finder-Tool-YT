---
name: ClickHouse read-only query settings
description: Catalog read-only mode also restricts query-level settings, not just writes.
---

Keep the catalog reader's read-only protection enabled; avoid query-level
settings that the server disallows in that mode.

**Why:** A read-only eligibility audit was rejected with ClickHouse error 164
when its SELECT included SETTINGS join_use_nulls=1. The query did not mutate
data, but changing that setting was still forbidden by read-only mode.

**How to apply:** Express missing-row detection through explicit presence
counts and nullable projections instead of changing join settings. Do not
weaken read-only mode or interpret this error as missing catalog records.

ClickHouse query logs are replica-local; an empty or incomplete result from a
load-balanced connection is not proof that a producer did not run.

**Why:** Different replicas exposed different daily tier-mirror reads/writes.
The application reader also lacked log permissions that the separately connected
ClickHouse account already held.

**How to apply:** Discover cluster names, then use a bounded read-only
`clusterAllReplicas` query when reconciling producer operations. Distinguish
permission-denied evidence from absent events. Use only existing authorized
access; do not broaden application permissions to investigate. Successful
selected-row writes do not prove that the producer selected its intended universe.

The project's PostgreSQL database is not the Chartmetric catalog.

**Why:** The user explicitly clarified this when a supplied Chartmetric-schema
query could not run against the project's PostgreSQL connection.

**How to apply:** Do not assume Chartmetric tables exist in the project's
PostgreSQL database, add those tables, or treat an approved Chartmetric API route
as permission to query a different catalog service. Keep source authorization
explicit.
