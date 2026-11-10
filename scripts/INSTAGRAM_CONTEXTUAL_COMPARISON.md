# Repeatable frozen contextual comparisons

This tooling is **not approval for another paid run**. It performs verification
only: no discovery, metadata fetching, catalog ingestion, live link updates,
historical score changes, or automatic retry/resume. Both arms receive fresh
responses. The fuller-metadata arm also changes the rubric, so this is not a
single-variable experiment or calibrated accuracy measurement.

## Prepare and inspect (no network or coordinator access)

Use `src/instagram-contextual-test-prep.mjs` to create a **new** preparation
directory from a frozen saved batch. Existing preparation directories and
completed paid archives must remain unchanged.

From the workspace root:

```sh
pnpm --filter @workspace/scripts instagram:contextual-comparison \
  --preflight /absolute/path/prepared-manifest.json /absolute/path/saved-batch
```

The saved batch must contain the original `scope.json` and `source-rows.json`.
Preflight checks their hashes, preparation code bindings, reconstructed frozen
requests, safe unique keys, both arms for each selected target/control, distinct
control accounts, model binding and the requested ceiling. It prints the exact
manifest hash and current code fingerprint plus an **unapproved** approval
template. Hashes use `JSON.stringify` on parsed JSON, as preparation does.
Do not alter/reconstruct the requests after approval.

## Separate approval

A human must separately approve the exact printed manifest, resolved model,
code fingerprint and ceiling. Save that decision in a new JSON file with the
template's fields:

- `version: 1`, `approved: true` only after obtaining that approval;
- exact `manifestSha256`, `codeFingerprint`, `expectedModel`, `maxSpendCents`;
- a new `budgetId` beginning `contextual-comparison-`, followed by 8–100
  alphanumeric/hyphen characters, naming this approval, not a pilot/batch;
- a nonempty `approvalReference` identifying the actual approval.

The tool validates this operator attestation; it cannot authenticate who
approved it. Do not copy an old approval, reset a budget, or invent a replacement
budget identity to bypass a stopped run. New code or changed inputs require
fresh preflight and separate approval. The fingerprint intentionally covers all
non-test `.mjs` sources in `scripts/src`, matching the existing rerun guard.

## Execute only after approval

```sh
pnpm --filter @workspace/scripts instagram:contextual-comparison \
  --run-approved /absolute/path/prepared-manifest.json /absolute/path/saved-batch \
  /absolute/path/separate-approval.json /absolute/path/new-output-directory
```

Live mode uses the existing `OPENROUTER_API_KEY` and `DATABASE_URL` internally;
never put credentials in the manifest or approval. The existing saved-batch
coordinator tables must already be installed (see
`src/instagram-saved-batch-gate.mjs`). No schema changes or pilot cutover are
performed by this command.

The executor only inserts a new separately scoped budget, with `ON CONFLICT DO
NOTHING`. An existing budget must match exactly and have neither an owner nor
reservations. It is exclusively claimed permanently. Each request reserves two
cents transactionally before dispatch; failures, timeouts and uncertain outcomes
remain reserved. No budget is updated to a higher cap, reset, refunded, or
reused. Original pilot and batch budgets are untouched.

Execution is sequential, all control arms first. A supported or >=0.9-scoring
control stops the run before targets. Model drift, code drift, invalid responses,
unknown costs, persistence errors and the 15-minute deadline also stop new work.
Transport has a 25-second per-request timeout, a 6,000-byte request cap, and no
retry. A stop/timeout is **not** proof that the provider did not charge.

## Output and interruptions

Every output directory must be new. These files are append-only or exclusive
creates, never overwrites of an earlier archive:

- `approval.json`: exact scope, approval, hashes and preflight receipt;
- `admissions.jsonl`: synced admission and returned/stopped events;
- `responses/`: original provider packets from the frozen transport;
- `response-<key>.json`: normalized fresh responses, saved before assessment;
- `results.jsonl`: synced returned rows, including model-mismatch responses;
- `findings.json` and `artist-instagram-findings.csv`: partial or full findings,
  complete requests and all actually supplied metadata, fresh identity scores,
  verdicts, label confidence/probabilities, policy assessment and shared-handle
  holds;
- `summary.json`: status/reason, conservative reservations and separately
  reported provider cost, no live changes, no accuracy-calibration claim.

Terminal exports are attempted independently even if another export fails.
An uncatchable process exit or unavailable filesystem can prevent terminal
exports; surviving raw response files, journals and durable coordinator
admissions remain the evidence. Never infer uncharged work from missing output.
The same approval cannot be resumed from a new directory. Review provider and
coordinator evidence separately; creating this tool authorizes no further spend.

## Ordinary tests

```sh
pnpm --filter @workspace/scripts test:instagram-contextual-comparison
```

Tests inject both an in-memory transactional coordinator and mock transports
(including the real frozen transport with injected mock HTTP). They never
connect to real providers, PostgreSQL, ClickHouse, or live link storage.
