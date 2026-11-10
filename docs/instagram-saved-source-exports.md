# Bind a saved artist batch to the musician catalog

`prepareNextSavedBatch` is offline. It now requires `source-export.json` alongside
the discovery and frozen source files. Legacy grouped account exports without this
receipt are deliberately rejected; a matching numeric profile ID is not sufficient
because parallel catalog models reuse those numbers.

## Read-only source export

After selecting a saved discovery cohort, call `exportSavedBatchSources(directory)`
from `scripts/src/instagram-saved-source-export.mjs`. Its default query function is
the read-only catalog client; only use that operation when catalog access is intended.
It makes no provider calls, writes no database records and grants no spending approval.
Tests must inject a fixture query instead of using the default.

The directory must already contain `discovery-<number>.json` arrays. The exporter
derives the profile/Chartmetric pairs from those arrays and uses the exact profile,
account and Chartmetric queries supplied by `metadataQueries` in
`scripts/src/instagram-artist-metadata-overlay.mjs`. The account query joins the
singular musician profile model and returns its Chartmetric identity with every
account. It does not switch to the parallel plural/general catalog.

The exporter validates identity pairs before writing:

- `frozen-profiles.json`: complete, unique musician profile rows
- `frozen-accounts.json`: flat linked-account rows, including both identity IDs
- `frozen-country.json`: optional Chartmetric metadata rows
- `source-export.json`: source model, exact queries, scope and SHA-256 hashes of
  all discovery/source file bytes

These files are exclusive writes. An existing or interrupted export is not
overwritten. Preserve existing evidence and use a new directory for a new export;
do not hand-edit or relabel an old account export to manufacture provenance.
The receipt detects accidental source/model changes, not malicious rewriting of
the entire local evidence set.

## Preparation and spending boundary

`prepareNextSavedBatch(directory, previousManifest)` checks the receipt, queries,
file hashes, complete profile export and each account identity pair before returning
any targets. The batch must contain 500 unique profiles and Chartmetric artists.
Either a reused profile ID or a reused Chartmetric ID from the prior cohort blocks
the entire batch. Prepared targets carry the source receipt hash for freezing in
subsequent approved scopes.

A validated profile with no linked accounts can still supply an explicitly labeled
Chartmetric catalog reference. That reference is not an artist-owned external page.
Saved search text is not account biography; country and contextual snapshots do not
prove account ownership. Source provenance is not ownership verification or approval
to spend. The existing separate paid admission gate and no-import rules still apply.

## Offline regression check

```sh
node --test scripts/src/instagram-saved-source-export.test.mjs \
  scripts/src/instagram-next-saved-batch.test.mjs \
  scripts/src/instagram-artist-metadata-overlay.test.mjs
```

The source-export tests generate synthetic 500-artist cohorts, inject all catalog
responses and prohibit network fetches. Rejected preparation cannot reach the real
saved-batch gate's database or transport sentinels.
