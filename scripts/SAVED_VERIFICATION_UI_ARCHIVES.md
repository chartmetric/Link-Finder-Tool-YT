# Saved verification results in the artist results page

This importer reads frozen saved-candidate outputs. It never calls search,
metadata, model, or live-link write services. The page reads App Storage, not
workspace files. No changes to old research decisions are needed.

## Offline preparation

Run from the workspace root:

```sh
python scripts/import_saved_verification_results.py
```

Inputs are the scope and source rows under
`generated-artifacts/saved-bulk-approved-500-usd20`, its `execution-paid`
results/summary/outcomes/findings CSV, and the paired preparation manifest and
`approved-execution` outputs under
`generated-artifacts/verification-test-preparation`.

The output directory defaults to `generated-artifacts/saved-verification-ui`.
It contains two immutable documents and an **additive** index of those documents.
Missing inputs fail explicitly. In isolated checkouts, run the synthetic fixtures
instead of attempting paid reconstruction:

```sh
python scripts/test_import_saved_verification_results.py
```

The paired CSV contains exact supplied metadata absent from its result journal.
The bulk CSV also contains held/no-candidate rows absent from its result journal.
Retain all those files together. The importer validates comparison identities,
request receipts and metadata; it does not reconstruct requests using newer code.
Preparation flags are retained as historical preparation flags, not as execution
approval receipts. Bulk creation time is its saved approval time; the paired
creation time is the archived budget observation, not an invented completion time.

## Persistent archive publication

Use the API package's dependency resolution when building the local publisher:

```sh
pnpm --filter @workspace/api-server exec esbuild scripts/publish-artist-archives.ts \
  --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=../../generated-artifacts/publish-artist-archives.mjs
node generated-artifacts/publish-artist-archives.mjs generated-artifacts/saved-verification-ui
```

This stores documents in the existing `artist-batch-exports/v1` App Storage
archive. Existing documents cannot be replaced with changed bytes; existing index
entries and warnings remain unchanged. Index publication uses a generation
precondition. A concurrent publication fails rather than dropping another
writer's history; retrying the same import is safe. A failed publication can
leave an unlisted immutable document, but never intentionally removes history.
Index-only replacement is disabled.

Reservations, reported charges, per-run limits, and the paired run's shared
pilot ceiling are separate figures. The 500-artist run's ten control accounts
come from five source artists. The paired run repeats six synthetic account
comparisons in two model conditions. Neither is an independently adjudicated
negative-label benchmark or calibrated accuracy measurement.
