# Complete saved-evidence request investigation

## Status

`saved_evidence_tables_v4` is an **explicit offline-draft option**, not a new
ownership rubric, an execution approval or a live acceptance change. The
existing v2/v3 defaults, typed questions, model and 6,000-byte cap are unchanged.
Both the ordinary pilot transport and frozen-request transport reject the
new serialization before making an HTTP request.

The investigation did **not** unblock any of the original 28 oversized holds.
Do not substitute reduced evidence or enable live use on the basis of this work.

## Whole saved-batch findings

Source: `generated-artifacts/saved-bulk-approved-500-usd20/`.
Original audit: `shared-rule-fix-offline/summary.json`.

| Check | Result |
| --- | ---: |
| Artist records | 500 |
| Source rows | 947 |
| Saved verification requests checked | 814 |
| Exact reconstructed context equality | 814 / 814 |
| Exact reconstructed complete source-state equality | 814 / 814 |
| Complete unsent requests at or below 6,000 bytes | 569 |
| Complete requests held above 6,000 bytes | 245 |
| Additional source rows held for missing saved evidence | 133 |
| Original 28 holds now fitting | 0 |
| Original 28 holds still held | 28 |
| Previously fitting v3 drafts now held with complete source records | 217 |
| Complete serialized request size range | 3,673–11,740 bytes |
| Same complete evidence fitting without the versioned encoding | 531 |
| Cases gained by compaction against that same-evidence baseline | 39 |
| Cases lost to version/format overhead | 1 |
| Plain / table layouts selected | 484 / 330 |
| Total bytes before / after encoding | 4,519,285 / 4,394,335 |
| Unchanged frozen files checked | 1,648 |
| Default v3 draft bodies exactly reproducing frozen bytes | 786 |
| Historical outgoing request hashes verified | 814 |

The existing small paired preparation contains 24 frozen requests. Its five
exclusion occurrences represent **three distinct cases**, not five independent
artists. They remain held at 8,440, 9,941 and 7,604 bytes. Its selection and
requests were not regenerated or replaced.

The larger hold count versus historical v3 is not evidence that compression
discarded information. This complete-source contract additionally retains all
saved discovery records and full source metadata, rather than only bounded post
matches and truncated profile summaries. The same-evidence byte comparison
above separates that evidence-delivery change from encoding savings.

No paid calls, new fetches, discovery, changes to spending/token limits,
acceptance changes or artist-specific exceptions were used.

## Encoding and equality contract

- Reconstruct an unencoded complete state using the unchanged v3 rubric.
- Retain raw catalog context, all discovery records (including unmatched and
  unconfirmed snippets), source declarations, source objects, catalog connection
  provenance, binding, dates, explicit nulls and ownership uncertainty.
- Retain bounded comparison signals as summaries, not replacements for raw data.
- Avoid carrying prior workflow identity judgments or archived model answers
  into the evidence state.
- Repeated object keys use transparent schema tables; repeated source strings
  use exact references into a readable string pool. There are no compressed
  binary blobs, text truncation, text normalization or deduplicated post records.
- Choose the smaller of table encoding and an explicitly versioned plain state.
- Decode and assert exact JSON state equality. Compare reconstructed raw context,
  full source objects and discovery records to their saved originals separately.
- Count the complete serialized UTF-8 request, including questions, rules,
  dictionaries and decoding instructions. Save oversized drafts as held; do not
  send them or remove records to fit.

A structural round trip establishes data preservation, **not** that a model
understands the new layout. Historical verdicts and scores in the audit are
unchanged reference values, never answers to the new requests. There is no
accuracy claim, live authorization or inherited spending approval.

## Reproduce offline

The output must be a **new directory outside the frozen batch**:

```sh
node scripts/src/instagram-lossless-request-audit.mjs \
  generated-artifacts/saved-bulk-approved-500-usd20 \
  generated-artifacts/new-lossless-request-audit \
  --lossless-v4
```

The same explicit flag is supported by
`instagram-contextual-identity-check.mjs` and
`instagram-contextual-test-prep.mjs`. In this mode they audit the entire cohort;
they do not select a replacement small paired test or create an executable
manifest. Omitting the option retains their historical behavior and checks.

Programmatically:

```js
await auditLosslessRequests(batch, newOutput, {
  requestSerialization: LOSSLESS_REQUEST_V4,
});
```

Output files:

- `summary.json`: totals, safety constraints, current code hashes and all frozen
  input hashes.
- `request-audit.jsonl`: every measured request plus explicit missing-evidence
  rows, exact byte sizes, hashes, equality results, holds and historical answers.
- `unsent-drafts.jsonl`: all 814 measured bodies, **including oversized held
  drafts**. None is an executable admission or an approval.
- `held-cases.json`: all oversized and missing-evidence cases.
- `report.md`: concise findings and interpretation.

The retained investigation outputs are under
`generated-artifacts/lossless-request-v4-final-audit/`. Generated request bodies
remain outside Git and deployment bundles.

## Checks

```sh
node --test scripts/src/instagram-lossless-request.test.mjs
```

The new tests cover reversible tables and plain layouts, source-looking reserved
keys, Unicode and JSON escapes, malformed references, untruncated metadata,
more than 40 saved post records, raw path provenance, exact UTF-8 boundary
behavior, no-network guards on both transports, frozen archive tampering,
missing-evidence rows and refusal to overwrite existing reports.

The adjacent contextual/rubric/source-only/byte-boundary/pilot/paired-preparation
regression suite also passed (76 tests), in addition to the six new tests.
