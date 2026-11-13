# Approved video-channel identity execution

`scripts/src/run-youtube-video-identity.mjs` is a **separate workspace-only
executor**, not a replacement for the offline preparer, a campaign worker, or an
authorization to spend. Adding it to the workspace starts nothing. It is not
registered as an application workflow or exposed through an API.

This implementation task authorizes **no paid run, catalog writes, campaign
resume, saved-response recovery, or retry**. The commands below are operator
instructions for a future explicitly approved stage, not commands to run now.

## Separate approvals

1. Prepare captures with `prepare-youtube-video-identity.mjs`, review the exact
   plan and cap, and obtain its existing local preparation approval using the
   sealed preparer. That record remains `executionEnabled:false`.
2. Prepare the separate executor **offline**:

   ```sh
   node scripts/src/run-youtube-video-identity.mjs \
     --prepare-executor --id=CAPTURE-ID
   ```

   This adds only `execution/` to that identity archive. Its manifest binds the
   unchanged plan, preparation approval, stopped parent ID, and sealed local
   executor dependency hashes. No database or provider access occurs.
3. Review the manifest's execution hash, exact plan hash and operation-specific
   cap. Obtain **fresh explicit approval** for this exact execution supplement,
   not a reference to an uploader approval, unused allowance, or old campaign.
   Only after that approval:

   ```sh
   node generated-artifacts/CAPTURE-ID/execution/runtime/run-youtube-video-identity.mjs \
     --authorize-execution --id=CAPTURE-ID \
     --plan-sha256=EXACT-PLAN-HASH --execution-sha256=EXACT-EXECUTION-HASH \
     --approve-cents=EXACT-STAGE-CAP
   ```

   This writes exclusive `execution/approval.json`; it does not start work or
   reserve funds. Mutable-source authorization and duplicate authorizations fail.
4. A later deliberate dispatch uses only that sealed executor:

   ```sh
   node generated-artifacts/CAPTURE-ID/execution/runtime/run-youtube-video-identity.mjs \
     --run-approved --id=CAPTURE-ID
   ```

   There are no retry, resume, fallback, top-up or substitution flags.
5. After transactionally completed captures, prepare an independent model plan
   using the existing preparer and `returns.json`. Review the full exact model
   bodies, then repeat **all** preparation/execution approval steps under the
   new model ID. Capture approval never authorizes model spending.

IDs above are explanatory placeholders; real IDs retain the preparer's
`youtube-video-identity-...` format. A zero-operation held model plan may complete
with zero reservations and no provider credential or requests.

## Live admission requirements

The executor uses the existing read-only ClickHouse catalog connection and the
existing PostgreSQL coordinator connection. Missing configuration or tables,
unreadable history, stale tiers or failed catalog queries stop work. There is no
local-lock or archive-only admission fallback.

At explicit dispatch, it installs only three new identity coordinator tables.
It never updates the original campaign, source uploader runs, legacy admissions,
catalog accounts, or old result files. Each transaction locks the stopped
YouTube parent row, fencing concurrent activation, reservation, and parent
resume at the admission boundary.

The gate requires:

- exact plan, preparation approval, executor approval and current owner hashes;
- a stopped parent and no other running campaign/test/uploader stage;
- no unreturned admission in campaign, bounded-test, uploader, or identity
  history, including other runs;
- a transactionally completed uploader source whose individual receipt hashes
  and raw hashes match the embedded original evidence;
- for models, transactionally completed channel captures whose acknowledgment
  hashes match the exact embedded receipt **bytes**, not reconstructed JSON;
- current undeleted catalog identity/name, unchanged global Tier 1–5 assignment,
  a tier snapshot at most 36 hours old, and no connected YouTube catalog URL;
- catalog and historical shared-channel checks for **all alternatives** and
  provider-observed aliases, including deferred channels and outside-cohort
  profiles. HTTP provider/catalog URL representations are inspected as HTTPS
  only for comparison; they are never dispatched;
- the next exact operation, two cents reserved atomically with its admission,
  and an unchanged exact cap. Reservations are never refunded after failure.

Global identity exclusions apply **independently** to each profile, each
Chartmetric artist, and each channel, scoped by operation kind across all
execution IDs. Changing the channel, profile, Chartmetric ID or request body
does not permit reusing any previously reserved identity for that kind.
Separate unique indexes enforce these exclusions transactionally, including
uncertain and completed admissions. A plan with repeated allocations for any
of those identities is rejected before dispatch rather than partially executed.
Exact prior request hashes for that profile/kind
in legacy campaign and bounded-test ledgers also block dispatch. Unknown prior
outcomes block the entire gate, not just a matching request.

Known source-cohort shared channels remain visible in the frozen capture plan;
new claims halt execution rather than changing the selection or reallocating a
slot. If multiple selected allocations repeat a channel, the independent
channel exclusion rejects the whole stage before any spending; approval does
not bypass it. Captured handle collisions are checked before acknowledgment. Model
preparation continues to hold shared channels rather than granting ownership.

## Receipts and failure behavior

Only the exact prepared GET or POST is sent, with redirects forbidden, one
120-second deadline, no retries and a two-MiB response limit. Channel responses
must return the exact channel ID, successful status and known zero/one credit
charge. Models use the unchanged exact-input parser, model allowlist, 6,000-byte
body policy and bounded billing evidence.

Original provider bytes are exclusively saved and synced to
`receipts/<digest(operation.key)>.raw`; the original UTF-8 receipt envelope is
exclusively saved and synced beside it. File and directory syncs precede the
owner-fenced database acknowledgment. Invalid, failed or unacknowledged responses
leave the reservation admitted and block subsequent spending. An oversized or
interrupted response is not a complete return and is never acknowledged.

Only after all exact operations are acknowledged and final eligibility/claims
checks pass does the executor complete the coordinator run and exclusively
write `returns.json`. It uses the immutable preparation contract unchanged:
the original preparation `approval`, the exact four-field completed `summary`,
and one base64 original receipt/raw-body pair per operation.

The coordinator is authoritative. If a crash occurs after database completion
but before saving `returns.json`, or after saving a receipt but before database
acknowledgment, **do not rerun**. A separately reviewed recovery-only operation
would be needed; this executor intentionally provides none. An existing receipt
directory, return file, run ID, admission, or approval is never overwritten.
Source uploader archives and embedded prior results remain unchanged.

Returns are policy-review evidence only: no live accepted links, ownership
accuracy measurement, or catalog import is produced.

## Verification without spending

```sh
node --test scripts/src/youtube-video-identity-execution.test.mjs \
  scripts/src/youtube-video-identity.test.mjs \
  scripts/src/youtube-video-stage.test.mjs \
  scripts/src/youtube-topic-links.test.mjs

node scripts/src/check-youtube-video-identity-postgres.mjs --temporary-tables-only
```

The first command uses synthetic provider replies and an isolated real CLI with
network transports blocked and inherited credentials removed. The second uses
only connection-local temporary tables and synthetic catalog checks. It makes
no provider calls, queries no live catalog, changes no persistent schema, and
never operates on real campaign admissions.
