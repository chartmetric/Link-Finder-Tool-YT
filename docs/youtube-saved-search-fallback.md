# Saved-search video fallback

The direct-channel test can return useful videos but no direct channel URLs.
That is a discovery gap, not evidence that the artist has no channel.

`prepare-youtube-saved-fallback.mjs` reads a completed test's saved search
receipts for artists with no direct captures. It validates the source plan,
approval hash, artist bindings, exact search request, response status and receipt
bytes. It preserves all video evidence and marks eligible, held and deferred
results separately, without importing a transport or database client.

The shared planner recognizes exact collaboration performer credits and bounded
`Main Artist:` credits in distributor snippets. When available, one of the two
uploader proposal slots retains a distribution/Topic lead. This replaces a slot;
it never increases the two-video ceiling. A distributor snippet is not proof of
the uploader, channel type or exact catalog artist association.

For KAIVA, this retains the saved `Too Rich` distribution lead while excluding
the similarly named film and the differently credited KAIVA VE OAPA results.

```sh
node scripts/src/prepare-youtube-saved-fallback.mjs \
  generated-artifacts/youtube-test-20-precision-2026-11-12 \
  generated-artifacts/youtube-saved-fallback-2026-11-12
```

Outputs are a non-executable proposal and a full evidence CSV. Preparation never
inherits the completed test's spending approval, acknowledges a response, checks
live eligibility, reserves money, performs provider calls, or writes catalog
links. Proposed costs are conservative uploader-only reservations, not billed
amounts or the total cost of later channel/identity checks.

Before any execution, a new sealed executable plan must recheck current catalog
eligibility and transactional non-replay/uncertain-admission state, including
old uploader stages. Exact uploader requests need separate approval. Subsequent
channel and identity requests require another preparation and approval once the
uploader identities are known.

After resolution, use shared uploader triage to exclude exact user-rejected
pairs, hold shared or unbound uploaders, label Topic leads, and keep every result
unaccepted until independent identity evidence supports the association.
No existing sealed runtime or archived result is edited by these source changes.

## Saved-response blocker and recovery-only preparation

The shared channel normalizer now accepts valid UTF-8 percent-encoded handles
containing non-ASCII letters or numbers. Decoding is restricted to the handle on
an allowlisted HTTPS YouTube authority. Encoded separators, controls, whitespace,
double escapes, legacy IDs and encoded query strings remain rejected. The
uploader mapper preserves every original URL and raw response byte; a normalized
handle is never promoted to a proven channel-ID alias or artist ownership.

For a stopped stage with multiple already-returned calls and exactly one saved
unacknowledged response:

```sh
node scripts/src/prepare-youtube-ledger-recovery.mjs --prepare-only \
  generated-artifacts/youtube-video-review-20-2026-11-12-c \
  generated-artifacts/youtube-saved-response-recovery-2026-11-13
```

This reads the coordinator in one read-only snapshot, binds the original owner,
plan, approval, reservations, admissions and saved receipts, and validates the
new mapper against the original raw bytes. It also verifies all original
evidence/runtime fingerprints, all earlier returned receipts/results and the
absence of attempt evidence for untouched requests. Output is a non-executable
proposal and a human-readable report.

The proposed action is only an exact acknowledgment of that saved response,
with its unaccepted local result. It does not resume the old run, approve its
untouched requests, spend the remaining allowance, or approve the new fallback.
No admission, reservation, historical result, approval or sealed runtime is
changed during preparation. Applying it needs separate recovery approval and a
fresh locked revalidation; a proposal alone is never authority to write.

After explicit approval of that exact recovery proposal,
`apply-youtube-ledger-recovery.mjs --apply-approved <recovery-directory>
--proposal-sha256=<approved-hash>` acknowledges only the one saved response.
It checks the original evidence and mapper hashes, locks the parent and
coordinator tables, and requires the complete ledger to match the approved
snapshot. It persists the exact unaccepted mapped result, changes only the
admission's receipt-status fields, and verifies every other row and reservation
is unchanged before committing. It writes a separate approval and application
record without replacing the original run approval, summary or exports.

Retries accept only the exact already-applied acknowledgment and identical
local result bytes; they never repeat provider work. Any unrelated ledger
change, modified source evidence or conflicting result blocks recovery.
The stopped run, two untouched requests and new fallback stage remain separate
and unapproved for execution.

## Fresh eight-request execution plan

`run-youtube-saved-fallback-stage.mjs --prepare-only
--id=youtube-video-review-kaiva-fallback-2026-11-13` prepares the original eight
saved requests for the five direct-channel misses. It refuses changes to that
saved request set, rechecks current Tier 1–5 eligibility and coordinator history,
preserves the original search receipts/catalog packets for later identity
preparation, and seals a separate runtime before asking for approval.

Small fresh stages use `exact-saved-video-uploaders-small-v1`; the historical
twenty-artist policy and its recovery constraints are unchanged. Both enforce
two uploader requests per artist, exact request hashes, two-cent reservations,
no retries, paused full campaign, and separately approved downstream identity
checks. Small stages cannot inherit recovery approvals.

Only after exact approval, use the new archive's sealed
`runtime/run-youtube-saved-fallback-stage.mjs` to authorize its exact plan hash
and 16-cent cap, then execute that same archive. Preparation performs no paid
requests and never writes an approval. Execution rechecks eligibility and uses
the existing transactional non-replay gate; viewing results cannot start it.
