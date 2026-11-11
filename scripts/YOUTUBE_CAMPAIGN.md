# Continuous Tier 1–5 YouTube sourcing

This is the separately approved, uncapped YouTube campaign. It does not modify
Instagram execution, funding or catalog links. Results are review suggestions.

## Scope and authorization

Explicit operator preparation freezes the current global Tier 1–5 musicians
missing a connected, non-empty catalog YouTube account URL. Saved candidates and
catalog Instagram links do not exclude an artist. Both platforms have their own
denominators; never sum them as a unique artist count.

The initial query is not limited to a sample. Workers process small internal
chunks automatically until the frozen queue is exhausted or a safety stop is
required. The queue denominator remains fixed. Before each chunk, the worker
rechecks current catalog identity, global tier eligibility and missing YouTube
URL. Ineligible identities are deferred, not counted as searched.

The initial 20-artist test's paid attempts are held as historical references
rather than automatically recharged. These deferrals remain visible and are not
invented rejections, no-matches or completed searches in the new campaign.

## Explicit preparation and launch

Only after the user approves this platform and spending scope:

```
node scripts/src/run-youtube-campaign.mjs --prepare-approved
node scripts/src/seal-youtube-campaign-runtime.mjs --seal-prepared
node generated-artifacts/full-tiers-1-5-no-youtube-uncapped/runtime/run-youtube-campaign.mjs --run-approved --uncapped-approved
```

The first command performs read-only catalog selection and explicit development
coordinator setup; it has no provider dispatch. The second seals the exact local
dependency graph and changes fingerprints only while the coordinator is still
prepared, has reserved zero funds and has no admissions. Runtime isolation
prevents other app/task merges from altering an active campaign.

These are not deployment migrations or application startup commands. Do not run
them again to recover a stopped campaign. Launch atomically requires `prepared`;
a second worker cannot replace the owner or reset charges.

## Evidence and spending

- Preserve full artist context, search evidence, raw channel receipts and exact
  model inputs. Search snippets are never channel biographies.
- Search uses the existing YouTube query wording. Channel captures and exact
  identity judgments reuse the shared YouTube ownership policy.
- Topic, fan, organization and reused channels remain distinct from artist-owned
  accounts. A bound `likely` result has no arbitrary 0.9 cutoff.
- Request bounds are 64 KB for complete model inputs and 2 MB for responses.
  Larger model inputs are held explicitly, never silently truncated.
- New admissions reserve two cents conservatively. Reported model cost must be
  at most that amount. Reservations are not invoices.
- No total cap is represented by a deliberately null cap in a separately bound
  authorization, not an arbitrarily increased numeric ceiling.
- Transactions serialize admissions, enforce owner/scope/approval, and reject
  every new dispatch while an earlier outcome is uncertain. Unique operation
  keys are never removed or reused.
- Receipts are saved before marking a request returned. A 120-second deadline
  retains uncertain charges and stops the worker without replay. Funding,
  authentication, rate limiting, protocol errors and server failures stop too.
- New cross-artist channel reuse holds earlier positive summaries as well as the
  later artist. Original evidence stays immutable; any future export must also
  apply current coordinator conflict holds, not blindly trust an old positive.

## Read-only publication

```
pnpm --filter @workspace/api-server run youtube:publish-campaign \
  --publish --run-id=full-tiers-1-5-no-youtube-uncapped --watch
```

This separate observer reads the coordinator in a consistent read-only
transaction, reconciles reservation totals, validates committed result hashes,
and mirrors immutable evidence and a counter-only progress snapshot to App
Storage. It never imports the paid worker or admits/retries work.

Only committed returned receipts and completed results are eligible for
archival; a newly visible file might still be being written. Evidence objects
are generation-fenced and content-hashed. The API prefers this campaign's
snapshot over the original test, which remains separately preserved.

Progress and success are different: processed artists include completed
no-channel searches; success is likely artists divided by artists with at least
one ownership assessment. Held metadata, deferred identities and provider
failures are not account absence or ordinary rejections.

## Explicit interruption recovery (new runtime, never the active runtime)

Recovery is an operator action, **not** an observer action, workflow restart,
deployment migration, provider probe, or automatic retry. Installing this code
does not authorize or start recovery. Do not rerun initial preparation, reseal
the original runtime, edit its approval, reset its status, or delete its files.
No recovery commands were run as part of implementing this capability.

### 1. Drain and prepare

First stop and **confirm the prior worker and any in-flight requests have
drained**. Record the exact coordinator owner UUID and how drain was established.
A stale progress timestamp, dead observer, expired lease, or absent local process
alone does not prove remote requests have finished. An interrupted request whose
outcome is unknown stays uncertain even after the process exits.

Only then, from the workspace root:

```
node scripts/src/recover-youtube-campaign.mjs --prepare-recovery \
  --prior-worker-drained --prior-owner=PRIOR_OWNER_UUID \
  --operator="Operator name" --drain-evidence="How worker exit and request drain were confirmed"
```

Preparation has zero provider calls and no catalog writes. It:

- Locks the original campaign and reconciles **every** committed admission,
  reservation, exact request hash, and returned receipt hash, regardless of
  whether a local admission journal or final artist file was saved.
- Freezes original metadata packets and result hashes. Search snippets are not
  substituted for missing metadata. A completed result must still match its
  committed hash.
- Retains all artist states, the whole queue denominator, historical deferrals,
  channel ownership rows, original approval hash, and every reserved cent.
- Creates a new, separately sealed dependency graph and immutable
  `recoveries/NEW_OWNER_UUID/plan.json`, then claims that prior-owner generation
  transactionally. Competing plans cannot replace its owner or authorization.
  Preparation never changes the campaign's running/stopped status or owner.

The command prints the new owner, plan SHA-256 and blockers. **Inspect the plan
before approval.** Missing or mismatched committed receipts, acknowledged
provider failures, missing original metadata for paid work, and uncertain
admissions block approval and all further paid continuation. A locally saved
receipt without a committed `returned` state remains uncertain: recovery never
promotes it, removes its admission, repeats it, or infers a refund.

A blocked plan is an evidence record, not permission to proceed around the
blocker. Stop for operator review; do not hand-edit the plan or coordinator.
Evidence or coordinator changes after preparation invalidate approval. There is
no timeout-based takeover or automatic replacement of an existing claim.

### 2. Record separate approval (does not start work)

After reviewing the exact owner-bound plan and its unchanged evidence, explicitly
authorize continuation of the same uncapped scope:

```
node scripts/src/recover-youtube-campaign.mjs --approve-recovery \
  --owner=NEW_OWNER_UUID --plan-sha256=REVIEWED_PLAN_SHA256 \
  --operator="Approving operator" --uncapped-approved
```

This records a resume attestation in both `resume-approval.json` and the
transactional recovery claim. The database claim is authoritative; a local file
alone is not authorization. Repeating this approval with the same operator and
plan is idempotent, including after an interruption between file save and commit.
It never launches a worker. Original spending approval and reservations are not
replaced or reset.

### 3. Explicitly resume the new sealed runtime

Only after the separate approval was recorded:

```
node generated-artifacts/full-tiers-1-5-no-youtube-uncapped/recoveries/NEW_OWNER_UUID/runtime/recover-youtube-campaign.mjs \
  --resume-recovery --owner=NEW_OWNER_UUID \
  --plan-sha256=REVIEWED_PLAN_SHA256 --uncapped-approved
```

Resume refuses mutable source execution. Under the campaign row lock, it checks
the prior owner, unchanged snapshot and all frozen evidence again, then consumes
the approval once and rotates ownership. The old worker is fenced out of new
admissions and result commits. Operator drain remains required because old code
also has local filesystem activity outside that transaction fence.

The new worker reconstructs interrupted artist work using the original full
metadata. Returned search, channel and model requests must match their exact
saved request/receipt hashes and are returned from disk **without dispatch or a
new reservation**. Changed inputs stop rather than creating replacement keys.
Only untouched operations may receive new two-cent reservations. An uncertain
new dispatch stops this generation with its reservation intact; restarting this
same plan cannot resume it.

Completed results are not replayed or overwritten. A result saved just before
interruption can be committed only if reconstruction matches it exactly. Global
channel conflicts survive ownership changes, hold both earlier and later
positive summaries, and never rewrite the original evidence. Current catalog
eligibility is still rechecked before processing remaining artists.

Recovered candidate inputs use the original campaign's `inputs/` directory,
which the read-only publisher archives for every completed artist. An existing
input must match reconstructed evidence exactly; a mismatch stops recovery
without overwriting the input or marking that artist completed.

### Isolated checks

```
node --test scripts/src/youtube-campaign-recovery.test.mjs \
  scripts/src/youtube-campaign.test.mjs \
  scripts/src/youtube-ownership-execution.test.mjs
```

These use temporary directories, fake HTTP responses and in-memory transactional
coordinators/SQL doubles. They do not connect to the campaign database, call
providers, run recovery, restart a workflow, or modify the catalog.
