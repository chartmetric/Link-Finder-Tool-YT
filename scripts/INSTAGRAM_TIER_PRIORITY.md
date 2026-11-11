# Strict Instagram tier priority

The user approved replacing saved-first ordering with Tier 1 → 2 → 3 → 4 → 5,
including fresh searches for higher-tier artists without saved candidates.
This is the real remaining campaign, not a pilot. The existing uncapped
spending approval remains in effect. Results are review suggestions only.

## Safety and preservation

- Keep the original frozen queue and its denominator unchanged.
- Fence the parent and active child owners together. Allow the active paid
  request to return; do not terminate it. A later admission fails before network
  dispatch, and the old worker archives its stopped state.
- Reconcile every historical admission, reservation and receipt. Preserve
  explicitly abandoned historical charges without replaying them.
- A `stopped_no_retry` journal entry can occur *before* admission when ownership
  is fenced. Exclude that entry only with the exact handoff proof, absence from
  admissions, unchanged reservations and timestamp/owner checks.
- Retire only the stopped child's unused allowance. Never reduce its reserved
  charge or reopen an admission.
- Seed completed historical identities into the priority coordinator. Every
  new admission rejects an artist with a legacy paid admission.
- Check tier order inside the admission transaction, not just when sorting.
  Higher-tier queued or in-progress work blocks every lower-tier dispatch.
- Revalidate current catalog identity, global tier eligibility and absence of
  a catalog Instagram link before paying. Changed eligibility is deferred.

## Execution and evidence

Use saved candidates for each artist when available. Otherwise use the existing
Serper query wording, with the existing second query only if the first returns
no candidate. Capture candidate account metadata and use the existing ownership
policy. Check alternatives until there is a positive review suggestion or all
retrieved candidates are exhausted. A completed search with no candidate is a
valid recorded outcome, not proof that no Instagram account exists.

Retain exact metadata, complete candidate lists, decision inputs, returned
answers, hashes and conservative reservations under
`generated-artifacts/instagram-tier-priority/`. No catalog writes occur.

The sealed runtime is immutable after launch. The coordinator is additive and
does not replace ClickHouse. Every request is admitted and charged at most
once; an uncertain request stops the worker without automatic retry.
Acknowledged server errors retain their reservation and skip the artist
without retrying that request. Authentication, funding and rate-limit errors
stop the run.

## Operator commands

These are one-time commands for an explicitly approved handoff, not restart
commands:

```sh
node scripts/src/instagram-tier-handoff.mjs --fence-approved
# Wait for the old child and parent to archive their stopped state.
node scripts/src/prepare-instagram-tier-priority.mjs --prepare-approved
node generated-artifacts/instagram-tier-priority/runtime/run-instagram-tier-priority.mjs \
  --run-approved --strict-tier-order-approved
```

Run the final command in a persistent background task with keep-alive. A
prepared coordinator can be claimed only once. Do not rerun preparation or
reset a launched coordinator to recover from a stop.

The existing Instagram observer detects the approved priority handoff and
reads its coordinator in a read-only repeatable-read transaction. It publishes
the original campaign's counters, original denominator and original uncapped
authorization hash. It never starts paid work.

```sh
node --test scripts/src/instagram-tier-priority.test.mjs \
  scripts/src/instagram-campaign-recovery.test.mjs
```
