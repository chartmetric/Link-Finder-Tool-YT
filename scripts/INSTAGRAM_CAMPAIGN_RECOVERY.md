# Preparing recovery after a tier eligibility change

Preparation is not permission to restart. It makes no provider calls, changes no
database rows, and does not start or restart the campaign or its observer.

## Offline preparation

From the workspace root:

```sh
node scripts/src/prepare-instagram-campaign-recovery.mjs --prepare-only
```

This command uses read-only transactions to reconcile the campaign's original
approval, queue, completed artist records, every paid admission and its exact
saved response. Every historical child must already be retired to its reserved
amount. Missing responses, ledger disagreements, unexpected child allocations,
or an overlapping paid artist stop preparation rather than authorizing a retry.

It writes a new local readiness plan, exclusively, under
`generated-artifacts/next-saved-full-tiers-1-5-usd100-recovery-001/`.
Existing campaign reports and partial preparation directories are not modified.
The readiness plan binds both evidence files and coordinator dependencies.
Re-running against an existing destination refuses to overwrite the earlier plan.
Use `--output-dir=generated-artifacts/next-saved-full-tiers-1-5-usd100-recovery-002`
to retain an earlier draft and write a replacement plan after code changes.

## Eligibility handling

The coordinator rechecks the next frozen queue selection. Only artists whose
current profile/Chartmetric identity matches, whose current global tier is 1–5,
and who still lack a catalog Instagram link enter the paid scope.

Other selected artists are **deferred**, not reported as processed, no-match,
or permanently out of scope. Missing rows in a refreshed tier snapshot are not
proof of a permanent tier change. Their original identities, frozen tier and
current exclusion reasons are retained in `deferred-artists.json`.

The whole original queue remains the progress denominator. Child eligibility
proofs and paid request scopes contain only the eligible subset; the complete
selection and deferrals are archived separately. Child launch rechecks that
subset again before paid requests. A further eligibility change fails closed.

The next child directory follows the highest existing ordinal, including partial
read-only preparations, so recovery never overwrites an unfinished directory.

## Activation boundary

**Do not run this until the user explicitly approves restarting:**

```sh
node generated-artifacts/run-full-tiers-campaign.mjs --run-approved \
  --resume-prepared=generated-artifacts/next-saved-full-tiers-1-5-usd100-recovery-002/plan.json
```

Activation revalidates archived file hashes, spending history and directory
history. It compares the same ledger again under the parent campaign lock before
transferring ownership. It does not reset reservations, increase the original
$100 ceiling, reopen retired children, or reuse the earlier one-time recovery
flag. A stale plan must be prepared again, not forced through.

The coordinator is a local operations runner retained under `generated-artifacts/`;
it is deliberately not a deployed application service. Web/API workflows do not
need restarting for this preparation. The read-only progress observer is separate
and cannot authorize or establish liveness of paid work.

## Explicit uncapped continuation

Only after explicit approval, the one-time operations command
`node scripts/src/authorize-uncapped-instagram-campaign.mjs --approve-uncapped-remaining`
records a supplemental approval, retaining the original approval and all charges.
It makes the development operations ledger's total ceiling nullable and sets this
campaign's ceiling to null (unlimited). It does not change any per-child $20 gate,
admission key, reservation, or ownership decision.

Prepare a fresh recovery plan as above, then activate it with the additional
`--uncapped-approved` argument. Old capped launches cannot claim the newly
authorized campaign. The original frozen queue and saved-first ordering remain
unchanged. Artists without saved candidates require the separate discovery phase;
this saved-candidate executor must stop rather than silently count them as searched.

## Offline checks

```sh
node --test scripts/src/instagram-campaign-recovery.test.mjs \
  scripts/src/instagram-campaign-budget.test.mjs \
  scripts/src/instagram-stopped-batch-recovery.test.mjs
node --check generated-artifacts/run-full-tiers-campaign.mjs
```
