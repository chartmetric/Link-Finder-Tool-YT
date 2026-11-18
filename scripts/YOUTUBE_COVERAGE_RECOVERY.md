# Bounded YouTube coverage recovery

Coverage and precision are separate:

- **Artist-level coverage:** artists with at least one supported review suggestion
  divided by the original artist cohort. Multiple channels do not count as
  multiple covered artists.
- **Reviewed precision:** suggested channel links subsequently confirmed correct
  in review. Unreviewed links have unknown precision.

The coverage recovery is a separately approved follow-up to the completed
100-artist test. It addresses the 75 artists without suggestions, not a new
100-artist search. The original 25 covered artists and archived receipts are
preserved. Combined outputs retain the original 100-artist denominator.

## Discovery change

Previously a direct channel result prevented video-uploader fallback even if
that channel was later held or rejected. The new opt-in runner tries unused saved
channels and video leads for artists still without supported suggestions.
Targeted direct-channel and Topic searches follow only when necessary.

This does **not** relax the existing representation verifier or imply that
uploader identity establishes artist ownership. Shared channels, conflicting
provider fields and failed identity assessments remain separate from suggestions.
Topic music presence is clearly distinguished from artist-facing channels.

## Execution boundaries

- A separate $10 allowance; previous charges are neither refunded nor reset.
- Two-cent conservative reservations per new request, at most 500 total.
- At most 12 new calls per artist: up to two searches, six metadata operations
  (including at most two uploader resolutions), and four model checks.
- Eight parallel artist lanes; each artist has at most one live request.
- Rounds prioritize saved leads across the cohort before repeated targeted work.
- An exact historical successful request is reused only with checked identity,
  request, receipt and raw-response hashes. Older-stage operations not supported
  by this cache are held rather than paid again.
- Unknown historical admissions, owner conflicts, provider failures, billing
  uncertainty and malformed responses stop new dispatch. No automatic retries.
- A fully saved, acknowledged metadata 404/410 is an unavailable-resource
  outcome, not a successful capture. Keep its reservation, do not repeat it, and
  allow other unused leads to proceed. Other provider errors still stop dispatch.
- Current no-YouTube catalog eligibility is checked before launch and each round.
- The original results remain immutable; recovery observations and combined
  exports are saved separately. No catalog writes or production-policy activation.

The `youtube-test-100-coverage-75-*` identifier uses the existing coordinator's
supported $10 namespace. It does not change the actual paid cohort size: 75.
The existing database constraint is not widened or removed.

## Preparation and launch

Only after explicit approval of the additional $10 recovery allowance:

```
node scripts/src/run-youtube-coverage-recovery.mjs --prepare-approved NEW_RUN_ID
node generated-artifacts/NEW_RUN_ID/runtime/run-youtube-coverage-recovery.mjs \
  --run-approved NEW_RUN_ID
```

The ID must match the namespace above. Preparation freezes the original results,
the recovery scope, model pricing, limits and dependency tree. It writes an
approval-bound plan but does not dispatch providers. Launch is one-shot; a
`run-started.json` marker must not be removed to repeat execution. Failed or
interrupted execution requires separate reconciliation, not another launch.

A one-source continuation can be prepared with
`--prepare-continuation-approved NEW_RUN_ID STOPPED_RUN_ID`.
It checks every original admission and saved receipt, retains the combined
results, and binds the stopped source ledger. Source reservations plus new
reservations share the same $10 ceiling. Per-artist call counts and uploader
limits also carry forward. A fresh nominal coordinator row is not a fresh
allowance. The original stopped generation remains immutable.

Outputs include `progress.json`, `summary.json`, combined `results.json`,
`youtube-review.csv`, and suggestion-only `youtube-suggestions.csv`.
Spending figures are conservative reservations, not final invoices.
Coverage improvements and accuracy must not be claimed from preparation or
synthetic tests; report actual completed results and review separately.

## Offline checks

```
node --test scripts/src/youtube-coverage-recovery.test.mjs \
  scripts/src/youtube-coverage-execution.test.mjs
```

These use synthetic provider replies and a transaction double. They perform no
paid requests or catalog writes.
