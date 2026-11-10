# Tier 1–5 musician attribution-correction readiness

## Current state: blocked, no correction execution

No benchmark policy is approved by this change. No acceptance threshold, source
freshness duration, acceptable error rate or benchmark sample size is selected.
The existing **verified + 0.90 + independent catalog-bound evidence** acceptance
route is unchanged. The separate acceptance-policy draft remains a draft.

`instagram-known-answer-benchmark.mjs` prepares historical requests and produces
diagnostic scorecards. Those scorecards always report `correctionRerunReady:false`.
Neither them nor the historical verifier-only experiments satisfy this gate.
Preparation is not a test result, and an untested case is not a passing case.

Inspection of the launch paths found:

- `musician-instagram-research.mjs run`: ordinary tier discovery, including a
  separately selected `--rerun-no-candidates` cohort. It is **not** a full
  attribution-correction executor.
- `artifacts/api-server/src/lib/musician-instagram-rerun.ts`,
  `startInstagramNoMatchRerun`: Tier 1–3 completed no-match discovery only.
  Its endpoint is `/api/profiles/musician-instagram-reruns`. It is **not** the
  future Tier 1–5 correction launcher and is intentionally unchanged.
- `instagram-pilot-live.mjs` and `instagram-pilot-budget.mjs`: capped diagnostics,
  not a correction executor. Both reject correction-purpose manifests before
  journal creation, credential reads or provider calls.
- No full attribution-correction executor was installed. The existing script's
  command dispatcher now reserves a separate, guarded `run-correction` entrypoint.
  **Even a valid readiness receipt cannot execute paid work through it.** It
  fails explicitly until a purpose-built budgeted executor is installed.

Ordinary research, focused no-match research, brands and cricket do not require
benchmark approval. A correction cannot opt into those executors by using
`purpose` or `runPurpose` set to `musician_instagram_attribution_correction`;
`--attribution-correction` also cannot bypass the correction dispatcher.
This is an operator safety boundary, not a defense against someone rewriting
the source or deliberately disguising a correction as ordinary research.

## Operator commands

From the workspace root:

```sh
node scripts/src/musician-instagram-research.mjs correction-readiness /path/to/launch.json
node scripts/src/musician-instagram-research.mjs run-correction /path/to/launch.json
pnpm --filter @workspace/scripts test:instagram-readiness
```

The first command only checks local files and prints a receipt on success.
It returns a nonzero exit status for any missing, failed or stale prerequisite.
The second checks the same prerequisites and then fails closed because there is
no correction executor. Neither command creates a journal or dispatches a request.
The package aliases `instagram:correction-readiness` and
`instagram:run-correction` accept the same launch-file argument; remember that
pnpm runs them with `scripts/` as the working directory.

## Approval and artifact contract

All file references are `{file, sha256}`. Hashes cover **exact file bytes**;
paths are resolved relative to the document containing the reference.
`inputSha256`, `requestSha256`, `evidenceSha256`, `acceptanceRulesSha256` and
the receipt's `contractSha256` instead hash `JSON.stringify(value)`, as in the
transport. Dates must be explicit UTC observations, not invented replay times.
Missing files, hashes, timestamps and malformed JSON are blocking errors.

These are trusted, operator-reviewed local approval documents. They must never
be accepted as arbitrary client-supplied approval through a public endpoint.
`approvedBy:"user"` records an approval; it does not authenticate a user.
No real approved examples or synthetic passing receipts are shipped as policies.
The unit-test builder is the executable schema example and uses fictional data
only; it does not authorize any real run.

### Launch manifest

- `version:1`
- `scope`: exactly `{purpose:"musician_instagram_attribution_correction",
  profileType:"musician", platform:"instagram", tiers:[1,2,3,4,5]}`
- `policy` and `results`: pinned file references
- `automaticRetries:0`
- `ingestion:"account_links/claims.record/resolve-only"`
- `paidApproval`: `approved:true`, `approvedBy:"user"`, a nonempty approval
  `reference`, `approvedAt`, `expiresAt`, `policySha256`, `resultsSha256`,
  `maxSpendCents` and `priorReservedCents`.
  Paid approval must follow completed results, remain unexpired and bind both
  documents. The existing conservative original $10 ceiling is not increased:
  the positive integer cap plus prior reservations cannot exceed 1,000 cents.
  Passing a benchmark is not paid-run approval.

### Approved policy

- `version:1`, the same exact `scope`
- `approval`: `approved:true`, `approvedBy:"user"`, nonempty `reference`,
  `approvedAt` and `expiresAt`
- `maxResultAgeMs` and `maxEvidenceAgeMs`: positive integers **explicitly
  selected and approved by the user**, with no supplied defaults
- `suite`: pinned reviewed suite file
- `contract`: output of the read-only `correctionContract()` plus the exact
  `resolvedModel` the approved benchmark must return

The contract binds the actual requested model, request serializer/schema,
instructions, evidence extraction and acceptance implementation hashes, and
unchanged acceptance rules. The guard itself and launch/admission code are also
fingerprinted. A changed prompt, schema, model, extraction path or gate requires
a fresh policy approval and matching benchmark; version names alone do not bind
the code. `resolvedModel` is checked against each raw provider packet, not
inferred from a requested-model alias.

### Reviewed suite

- `purpose:"musician_instagram_attribution_correction"`, `preparationOnly:false`
- `labelReview:{approved:true, reference:"..."}`: explicit independent label review
- `cases`: unique `id`, exact `profileId` and canonical Instagram `url`,
  boolean `expectedArtistOwned`, nonempty `labelProvenance`, pinned `input`,
  and nonempty `sources` references, each with its actual `observedAt`
- Each required case explicitly declares `requiredModelAccepted` and
  `requiredApplicationAccepted`, both matching the adjudicated ownership label.
  The reviewed suite must include positive recovery and negative controls.
  Every evaluated candidate must have a reviewed expected outcome.

This checks every **required** known-answer expectation, not population accuracy.
Choosing which independently reviewed cases constitute a sufficient benchmark is
an approval decision; the guard does not calibrate thresholds, infer labels from
catalog links, or invent acceptable missed-positive/wrong-acceptance rates.

Each input contains `player` (catalog identities/accounts), `payload` (the
production `jevRequest` serializer input), and `discovery` (completed blind
discovery with `methodsUsed`, raw candidate `profiles` and explicit
`knownAnswerUsedAsInput:false`). Expected handles must not seed discovery.
The reviewer must establish that provenance, not merely set the boolean.
The target account must actually appear in both discovery and verifier inputs.
Source files and their dates are rechecked for hash integrity and approved
freshness. Their ownership/source interpretation still requires review.

### Completed results

- `status:"completed"`, `fixtureOnly:false`
- Exact `contract`, `policySha256`, `suiteSha256`, `acceptanceRulesSha256`
- `startedAt` after approval and `completedAt` after start, neither in the future;
  completion and evidence remain within the approved age limits at check time
- Exactly one result per required suite case: `id`, `status:"completed"`,
  `stage:"blind_discovery_and_verification"`, `inputSha256`, `requestSha256`,
  `evidenceSha256`, pinned `response`, pinned JSON-array `journal`, `admissionKey`
- Each admission key has exactly one `admitted` then one `returned` entry,
  bound to the case profile and `kind:"jev"`. Missing returns, failures or replay
  entries block readiness.
- Each raw response packet has `at`, `status:200`, exact `decisionRequest`,
  `requestBodySha256`, and `data` with the exact resolved `model` and complete
  typed `answers`. Submitted “passed” booleans and precomputed scorecards are
  not used as proof.

The guard regenerates the actual JSON request, validates score ranges, applies
the unchanged numeric/verdict requirement, and independently reruns
`assessInstagramCandidates`. A high model score cannot replace the evidence
gate, and rejecting every candidate cannot satisfy a required positive.

## Requirements for a future correction executor

Do not connect this receipt to the ordinary discovery loop or expand pilot caps.
A future executor must revalidate readiness immediately before launch and paid
admission, freeze the approved cohort and contract, reserve every provider call
before dispatch under the original aggregate cap, durably preserve uncertain
admissions, and never automatically retry. Its launch approval must bind the
cohort and spending plan as well as these readiness artifacts.

Readiness never approves a live link. Future ingestion must submit
`account_links/claims.record` and use normal `resolve` processing only; it must
not write live account or profile-link tables. No claims implementation or live
link mutation is added by this guard.
