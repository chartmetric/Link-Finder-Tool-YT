---
name: Downloadable asset size limits
description: Avoid failed delivery of large campaign CSV files through the Library.
---

Library asset registration currently rejects individual files larger than
100 MiB (104,857,600 bytes). Check actual file sizes before presenting exports.

**Why:** Campaign CSVs with repeated model-input text exceeded this limit even
though ordinary file generation succeeded. Removing one large field was not
enough; quoted CSV size must be measured, not estimated from JSON lengths.

**How to apply:** Keep full snapshots locally in the ignored generated-output
directory. Make downloadable exports fit the limit without silently truncating
artists or changing classifications. If omitting large evidence fields to keep
the requested file count, explicitly describe those omissions and preserve
artist identities, links, decisions, and reasons.
