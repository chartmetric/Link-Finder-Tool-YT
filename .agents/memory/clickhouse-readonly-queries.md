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
