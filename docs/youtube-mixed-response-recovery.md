# Recover an already-saved YouTube channel response

This workflow is separate from `run-youtube-mixed-captures.mjs`. That original
runner remains one-shot: **never rerun it, delete its run record, change its owner,
or reset its reservations** to recover a response.

Building or testing these tools does not authorize a real recovery or any paid
request. All examples below require deliberate operator action. Use the exact
IDs, fingerprints and caps from the proposals you actually reviewed.

## What qualifies

A single original mixed-source or direct-search capture run must be **stopped**
in PostgreSQL. Its exact original plan, original approval and sealed runtime
must still be present. Every admission must form the original sequential paid
prefix, with valid saved raw bytes and a receipt. Exactly the final admitted
operation may be saved but unacknowledged. Earlier admissions must already have
matching returned receipt/raw hashes and HTTP 200 acknowledgments.

The audit checks the original owner, plan/approval/runtime fingerprints, exact
requests and artist/allocation identities, raw and receipt hashes, known billing
(zero or one reported credit), channel-ID/URL binding, and identity claims.
All original reservations survive unchanged. A saved channel response establishes
transport and channel metadata only, **not artist ownership or import eligibility**.

Missing/partial receipts, raw-only files, orphan receipts, malformed data,
non-success responses, unknown billing, conflicting channel IDs, and conflicting
artist claims remain unresolved. No provider call is replayed to repair these
states. Even conflict-free saved responses require separate exact approval to
acknowledge. Generic recovery does not acknowledge conflicting metadata; older
conflict-specific workflows have different, narrower contracts.

## 1. Read-only preparation and offline audit

From the workspace root:

```sh
node scripts/src/prepare-youtube-mixed-response-recovery.mjs \
  --prepare-only \
  --source-id=youtube-mixed-captures-ORIGINAL \
  --id=youtube-mixed-response-recovery-NEW
```

Preparation reads the coordinator, source-chain archives and current catalog;
it never creates coordinator tables, admits requests or edits catalog links.
It writes only a **new** directory under `generated-artifacts/`, containing a
sealed runtime and `plan.json`. Existing directories are not overwritten.

The embedded `evidence` object in that plan is a portable offline audit input:
original plan and approval, full original run/admissions, saved receipts with
exact receipt-file hashes, base64 raw bytes, and the captured identity-claim
snapshot. Save that object as a JSON file to audit it without credentials:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/prepare-youtube-mixed-response-recovery.mjs \
  --audit-offline --evidence=generated-artifacts/REVIEW/evidence.json
```

Offline validation is not a fresh catalog observation, approval, acknowledgment,
or permission to continue. It does not infer missing data.

## 2. Approve and acknowledge only the saved response

Review the proposal fingerprint, original owner and approvals, admission history,
raw bytes, returned metadata, prior reservations and untouched requests.
Authorize the sealed recovery with **zero additional cents**:

```sh
node generated-artifacts/youtube-mixed-response-recovery-NEW/runtime/run-youtube-mixed-response-recovery.mjs \
  --authorize-prepared --id=youtube-mixed-response-recovery-NEW \
  --plan-sha256=EXACT_LOWERCASE_SHA256 --approve-cents=0

node generated-artifacts/youtube-mixed-response-recovery-NEW/runtime/run-youtube-mixed-response-recovery.mjs \
  --acknowledge-approved --id=youtube-mixed-response-recovery-NEW
```

The apply step takes the original shared campaign lock and rechecks the stopped
owner, full ledger, unchanged reservations, exact archives, source-chain readiness
and current catalog/historical claims. It updates **only** the original admission's
receipt status, receipt/raw hashes and HTTP status. It makes no provider requests,
new reservations, ownership claims or catalog changes. The original run stays
stopped; old `returns.json` and other archives are not rewritten.

The same exact approval can safely be applied again if the process died during
the transaction, its commit reply was lost, or the new result file was not saved.
The ledger must be either the exact original snapshot or exactly its approved
acknowledgment projection. Any other change blocks recovery. Result publication
uses an exclusive, atomic install; a partial temporary file cannot masquerade as
a finished result. The new `recovery-result.json` records the approval and scope,
but does not count as a successful artist match.

## 3. Separately prepare and approve untouched work

Acknowledgment grants **no dispatch authority**. If untouched operations remain:

```sh
node scripts/src/prepare-youtube-mixed-response-recovery.mjs \
  --prepare-continuation \
  --recovery-id=youtube-mixed-response-recovery-NEW \
  --id=youtube-mixed-captures-recovered-NEW
```

This requires the acknowledged ledger projection and unchanged original archives.
It seals a fresh runtime and the **exact original untouched suffix**, with no
replacement artists, channels, operations, discovery, uploader calls or models.
Review it, including fresh eligibility, before granting a new exact approval:

```sh
node generated-artifacts/youtube-mixed-captures-recovered-NEW/runtime/run-youtube-mixed-response-recovery.mjs \
  --authorize-prepared --id=youtube-mixed-captures-recovered-NEW \
  --plan-sha256=EXACT_LOWERCASE_SHA256 --approve-cents=EXACT_REMAINING_CENTS

node generated-artifacts/youtube-mixed-captures-recovered-NEW/runtime/run-youtube-mixed-response-recovery.mjs \
  --run-approved --id=youtube-mixed-captures-recovered-NEW
```

Each new admission retains the stopped original run and original reservations,
revalidates the complete original ledger and source chain, checks independent
profile/Chartmetric artist/channel exclusions across all runs, and enforces:

**original reservations + new reservations ≤ original combined ceiling**.

The continuation uses the existing one-shot metadata executor. It saves raw
bytes before acknowledgment, stops on failure, and cannot resume or rerun. Do
not delete its launch marker after an interruption. This workflow does not
generalize aggregate bundle recoveries, chain multiple interrupted continuations,
or migrate recovered captures into ownership review archives automatically.
Those need separate reconciliation contracts, not reused approval or budget.

## Synthetic verification

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-mixed-response-recovery.test.mjs \
  scripts/src/youtube-mixed-channel-captures.test.mjs
```

Tests use disposable synthetic archives and an in-memory transactional coordinator,
with actual networking fenced. They cover offline rejection boundaries, changed
owners/ledgers/archives, idempotency, pre/post-commit interruptions, result-publication
interruption and separately approved untouched dispatch under the original cap.
They do not connect to a real coordinator or use provider credentials.
