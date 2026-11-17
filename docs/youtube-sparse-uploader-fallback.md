# Sparse saved-video uploader preparation

This is a **new, uploader-only approval stage**, not a continuation of any
previous search or uploader allowance. It does not approve artist ownership.

## Prepared snapshot

- Reviewed all 24 saved-video candidates against 96 historical uploader
  allocations and all 100 acknowledged parent searches.
- Froze 38 requests for 21 currently eligible artists, in two child stages
  capped at 74 cents and 2 cents: **76 cents total**.
- Preserved J.Truth, Tmax and DJ DFX as deferred because current catalog
  eligibility could not be confirmed. Their six saved requests were not
  substituted or counted as completed no-matches.
- One existing unacknowledged identity admission blocks execution. No
  acknowledgment or recovery permission is included here.
- No paid calls, repeated searches, database writes or approvals were made.

Exact prepared plan SHA-256:
`9de256031fa38b730ae6ff61bf5eee06ac954a956e08fa93d3d39560b0492637`.

Prepare with:

```sh
node scripts/src/prepare-youtube-sparse-uploaders.mjs --prepare-only
```

The command refuses to replace an existing preparation. It reads existing
archives, ClickHouse eligibility and a read-only PostgreSQL snapshot. It makes
no paid calls, writes no catalog/coordination data and creates no approval.

## Bound sources and exclusions

- The completed hundred-artist search parent and its five approved twenty-artist
  children, including sealed evidence/runtime hashes.
- All 100 original search requests, saved receipt hashes, acknowledged coordinator
  receipts and original catalog identities.
- The original 55 direct-capture selections, not the later smaller refresh.
- All historical uploader allocations, independently by profile, Chartmetric ID,
  video ID and operation identity. Returned and uncertain allocations both count.
  Unknown legacy uploader formats block rather than disappearing from history.

The remaining-artist CSV must reconcile exactly to the parent: 45 remaining
artists, 24 with a saved video queue. Current ineligibility defers a candidate;
it is never a completed search, a no-match or permission to substitute another
artist/video. Current tiers determine dispatch order and are retained separately
from original source tiers.

## Frozen output

`generated-artifacts/youtube-batch-uploaders-sparse-100-2026-11-16/` contains:

- `plan.json`: aggregate exact-request, source, evidence and runtime fingerprints,
  and the summed new spending ceiling.
- `proposed-uploader-requests.csv`: every proposed GET request, exact URL,
  request fingerprint and two-cent reservation.
- `all-video-dispositions.csv`: selected, deferred and held video evidence.
- `evidence/source-bindings.json`: complete saved fallback proposals, catalog
  packets and consumed source hashes for all five cohorts.
- `evidence/all-dispositions.json`: all 100 artists, including all direct,
  Topic/distributor, snippet, held and deferred alternatives.
- `evidence/readiness.json`: read-only historical allocations, original receipt
  reconciliation, current eligibility and execution blockers.
- `readiness.md` and `preparation.json`: concise handoff and scope summary.

Child plans remain under the unchanged small-stage policy: no more than 20
artists, two videos per artist, 40 requests or 80 cents per child. A separate
aggregate approval binds every child fingerprint and sums, rather than widens,
those ceilings. Existing historical proposal and recovery validators are untouched.

## Approval boundary

Do not authorize or run during preparation. After a user explicitly approves
the **exact frozen fingerprint and new cap**, the sealed aggregate runtime
accepts `--authorize-prepared --plan-sha256=HASH --approve-cents=CENTS`.
`--run-approved` requires that approval and fresh eligibility, receipt and
coordinator checks. Both modes must use the aggregate's frozen runtime entry
`runtime/run-youtube-sparse-uploaders.mjs`, never mutable source.

An unrelated uncertain admission is disclosed during preparation and still
blocks execution. This preparation never clears it. Each execution is one-shot;
stopped children or partial results require separately reviewed recovery, not
rerunning the command.

The newly sealed runtime explicitly binds the validated-conflict hold policy.
Only completely saved, correctly video-bound, known-billed identity conflicts
may be acknowledged and held while untouched requests continue. No conflicting
channel is selected or exported as a channel. Provider failures, unknown billing,
malformed data, missing IDs and bad video bindings still stop dispatch.

Uploader responses are discovery clues only. Exact downstream channel captures
and complete identity requests must be frozen and separately approved after the
uploader identities are known. There is no ownership-approved import here.

## Offline checks

```sh
node --test scripts/src/youtube-sparse-uploaders.test.mjs \
  scripts/src/youtube-staged-uploader.test.mjs \
  scripts/src/youtube-uploader-conflict-recovery.test.mjs
```

The tests prohibit network operations and use fake coordination clients. The
saved-parent regression additionally runs when the ignored operational archives
are available. None of these tests authorize spending or acknowledge receipts.
