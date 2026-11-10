# Future approved saved-alternative runs

This is a separate opt-in runner. It does not modify
`generated-artifacts/run-next-saved-500.mjs`, its saved scopes, prior admissions,
stage ceilings, or any other running approval. Installing this code does not
authorize paid work.

## Prepare and approve

Use `prepareSavedAlternativeScope(targets, authorization, options)` from
`src/instagram-next-saved-batch.mjs` with the frozen, identity-bound targets
returned by `prepareNextSavedBatch`, or equivalently validated saved targets.
The target's `candidates` must exactly match its frozen
`player.savedCandidateUrls` in order. Do not add newly discovered links.

The authorization must contain:

- `approved: true`, a **new** `budgetId`, and `maxSpendCents` (1–2000).
- `candidateMetadataFetchesApproved: true`.
- `savedAlternativesApproved: true` when options include
  `inspectAlternatives: true`.

The option defaults to **false**: only the first saved candidate is eligible.
Freeze the complete scope, including the alternative option and model, before
approval. Save it as a JSON file. Do not turn on the option inside an existing
approval, replenish a claimed budget, or give each alternative a fresh allowance.

Preview without opening a database, using credentials, or calling providers:

```
node scripts/src/instagram-saved-alternatives-cli.mjs scope.json generated-artifacts/new-alternative-run
```

Only after explicit approval of that scope and total spending ceiling:

```
node scripts/src/instagram-saved-alternatives-cli.mjs scope.json generated-artifacts/new-alternative-run --run-approved
```

The existing saved-batch coordination schema must already be installed. The
runner refuses an existing output directory. Output is an admission journal
(including exact dispatched inputs), raw provider response archives, synced
outcome checkpoints, and a final JSON summary. No links are imported and no
catalog data is changed.

## Allocation and evidence

An artist's turn inspects one candidate (metadata, then verification if usable).
Every artist receives a first-candidate turn before any artist receives a
second-candidate turn; subsequent rounds keep the original artist order.
An unavailable account or inconclusive review enables the next saved candidate.
A positive review suggestion or an unsupported candidate ends that artist's
turns. No alternative is selected merely because the budget ran out.

Metadata is cached only within the running process for an **exact canonical
Instagram URL**, after a completed receipt. Shared URLs need only one metadata
call, but each catalog artist requires a separate model assessment. Shared
handles remain ownership conflicts, not positive suggestions. URLs in aliases,
search snippets, biographies or external links never expand the frozen scope.
No archived captures or uncertain requests are automatically replayed on launch.

Candidate inspection statuses are:

- `uninspected`: no completed inspection in this run; preserve the saved link.
- `unavailable`: a completed provider receipt could not supply usable evidence.
- `inconclusive`: captured details or a review do not resolve identity, or work
  stopped with an uncertain outcome.
- `unsupported`: an observed identity conflict, recorded model mismatch, or
  complete evidence that cannot fit the supported request. Not proof that an
  account is missing.
- `positive_review_suggestion`: review-only, never verified ownership.

Artists with no saved URLs are `no_saved_candidate`. All candidates and their
individual states remain in checkpoints, even when an alternative succeeds.

## Spending and interruption

Both providers and every round use **one parent budget row**. Every admitted call
reserves two cents transactionally, regardless of its reported cost or outcome.
The runner checks available allowance before each call, and the coordinator
enforces the cap again under the parent row lock. There are no child allowances,
refunds, automatic retries, automatic resumes, or releases of unused allocations.
Provider-reported model costs remain separate from conservative metadata costs.

Acknowledged metadata server errors may be archived and skipped without retry;
they are unavailable evidence, not a mismatch or proof of absence. Funding,
authentication, rate limits, uncertain outcomes, changed verifier models,
coordination errors and failed archive writes stop all further dispatch. A
claimed budget cannot be reopened, including after a crash or lost commit
acknowledgement. Review uncertain admissions before approving any subsequent
paid work; a fresh run is not an automatic recovery mechanism.

## Read-only batch results import

Prepare a UI archive from a runner output directory (not the approval file):

```
node scripts/src/import-saved-alternatives.mjs generated-artifacts/new-alternative-run generated-artifacts/new-alternative-ui
```

The output directory must be new. The importer uses only local files and never
loads provider credentials, starts a run, discovers URLs, or accepts links.
It reads `scope.json`, `admissions.jsonl`, `outcomes.jsonl`, `summary.json` and
the exact raw metadata/model response archives when present. A missing final
summary is explicitly shown as the last durable checkpoint; torn journals,
conflicting final summaries and mismatched identities fail rather than being
silently repaired. Missing raw response files are labelled unavailable, never
reconstructed. An interrupted checkpoint's budget may precede newer admissions;
the journaled reservation total is shown separately and is not a complete bill.

Publish the prepared directory using the existing additive publisher described
in `scripts/SAVED_VERIFICATION_UI_ARCHIVES.md` (substitute the new UI directory
in the final command). Publication stores immutable review documents in App
Storage and preserves previous batches. It is not a paid execution approval.
The archive identity includes the scope and checkpoint hashes so later durable
observations do not overwrite earlier ones.

Open **Bulk → Artists → Saved artist batch results**. Each saved candidate
retains its own status, original evidence, journaled requests and completion
receipts. Frozen saved snippets/context are labelled available, not necessarily
sent. A journaled admission is not a completed provider receipt. Positive
suggestions remain review-only with no verified link. Filters preserve the six
distinct candidate/no-candidate states; parent spending details stay at batch
level. With no journal event, the displayed date is explicitly the source
checkpoint file's modification time, not an invented approval/dispatch time.

## Offline verification

```
node --test scripts/src/instagram-saved-alternatives.test.mjs \
  scripts/src/import-saved-alternatives.test.mjs \
  scripts/src/instagram-next-saved-batch.test.mjs \
  scripts/src/instagram-saved-batch-gate.test.mjs \
  scripts/src/instagram-likely-review-policy.test.mjs
```

These tests inject both providers and transactional coordination. They do not
connect to application databases or use provider credentials.
