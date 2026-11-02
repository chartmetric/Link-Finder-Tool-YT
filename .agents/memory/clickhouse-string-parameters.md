---
name: ClickHouse string parameters
description: Escaping risks when passing structured fixtures through typed ClickHouse String query parameters.
---

Do not assume a typed ClickHouse String query parameter preserves backslashes in nested serialized JSON unchanged.

**Why:** Read-only coverage SQL fixtures containing JSON serialized inside a JSON string silently returned empty evidence: escaped inner quotes were interpreted during parameter parsing. Passing the inner data as an object and extracting its raw JSON preserved the fixture.

**How to apply:** For structured SQL fixtures, prefer object-valued JSON with raw extraction rather than JSON-in-string. If a parameter must contain escaped JSON or backslashes, verify round-trip preservation explicitly before trusting empty query results.
