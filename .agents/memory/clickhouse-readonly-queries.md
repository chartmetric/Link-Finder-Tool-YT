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

Raw Chartmetric artist-track exports must filter the artist links first,
restrict tracks and albums to those linked IDs before joining, and deduplicate
the final rows with `SELECT DISTINCT`.

**Why:** The user warned that joining the full raw tables exhausts memory and
that the raw catalog contains duplicate rows.

**How to apply:** For authorized raw-catalog exports, use bounded typed artist-ID
parameters and filtered link/track/album CTEs. Do not replace a failed scoped
read with a full-table join or remove read-only protections.

On this ClickHouse server, `CHECK GRANT` returns a scalar `0` or `1` and does
not accept a trailing `FORMAT JSON`.

**Why:** Adding the SELECT-style output clause caused a syntax error rather
than a permission decision. That error must not be reported as access denied.

**How to apply:** Omit the output clause for permission checks and parse the
scalar response. Distinguish privilege denial from malformed introspection.
Before an explicitly authorized insert/read/delete setup check, verify cleanup
permission as well as creation, insertion and reading; stop before writes if
the test row could not be removed.

This server can expose a table as `SharedMergeTree` in `system.tables` after
accepting a literal `ENGINE = MergeTree` creation statement.

**Why:** Server-side engine mapping means the requested SQL and reported
physical engine name need not be textually identical.

**How to apply:** Preserve the submitted statement, report both engine names,
and verify the actual columns and sorting key. Do not alter, drop or recreate
an authorized table merely to force the metadata label to match.
