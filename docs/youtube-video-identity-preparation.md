# Identity preparation for channels discovered through videos

This is an **offline preparation tool**, not a paid runner. It reads immutable
saved files and creates a new local review archive. It does not call providers,
read or write databases, change catalog links, rewrite prior findings, authorize
retries, or resume either full campaign. Do not modify any existing sealed worker.

The separately implemented workspace executor is documented in
[`youtube-video-identity-execution.md`](youtube-video-identity-execution.md).
It requires a new execution supplement and fresh explicit exact-plan approval;
the preparer's commands and local approval records remain non-executable.

## Prerequisite and approval boundaries

The separately approved uploader stage must have completed, with all exact
requests returned. Missing receipts, a missing completion summary, stopped work,
unacknowledged/uncertain calls, changed evidence, and invalid uploader identities
stop preparation. The tool reconstructs discoveries from original raw responses,
not editable result JSON or CSVs.

An uploader approval does **not** approve channel capture or a model request.
Channel responses are still unknown after uploader resolution, so a combined
“exact capture and model approval” would not actually bind the model's evidence.
Use these separate boundaries:

1. **Prepare channel captures** from completed uploader receipts. Review the exact
   channel IDs, catalog identities, all alternatives, source video bindings,
   receipt/raw-response hashes, shared-channel flags and operation reservations.
   Ask for fresh approval of this exact plan and cap.
2. A **separately implemented, separately approved execution gate** may capture
   only those exact channel requests. This task supplies no such dispatcher.
   Never run a legacy campaign/test command with this approval.
3. **Prepare model requests** only from completed immutable channel returns.
   The tool checks the returned channel ID against the resolved uploader, not
   merely a name or handle. Review the full exact model bodies, their byte counts,
   request/policy-input hashes, capture receipts, and reservations. Ask for another
   exact-plan approval, separate from the capture approval.
4. Model answer review can later use the pure `reviewVideoIdentityAnswers`
   function. It binds every answer to the exact saved request and evidence.
   No result is a catalog import or a measured ownership-accuracy result.

Local approval records have `executionEnabled:false`. They document the exact
reviewed spending scope; they are not a transactional admission mechanism.
The preparer intentionally has **no `--run-approved` mode**.

## Exact selection policy and loss of breadth

Policy: `first-distinct-uploader-in-frozen-operation-order-v1`.

For each artist, traverse the original uploader plan's operations in their
already-frozen order. Group repeated uploader channel IDs and preserve every
video observation. Select the **first distinct channel ID**, without reranking by
name agreement, Topic wording, artist-ownership answers or a known correct link.
Select at most **one channel per artist**.

This is less breadth than the previous two-channel capture test. All other
distinct channel IDs remain in the plan and CSV with
`deferred_by_one_channel_cap`; they are uncaptured and unresolved, not no-matches.
There is no replacement capture if the selected channel fails or is a label,
fan, Topic lead, shared channel or wrong identity. A second channel would need a
new plan and separate approval. Provider-observed aliases are retained but never
dispatched or treated as proven equivalent without channel capture.

Shared-channel checks include **all** source uploader alternatives, including
deferred alternatives. Each affected pair records the conflicting catalog
profile/Chartmetric identities. Shared channels are held unresolved and receive
no model allocation; the capture slot is still visible, not quietly reassigned.
These offline checks cover the source cohort only. Outside-cohort catalog or
historical channel claims remain **unchecked**, not clear. Before any future
dispatch, its gate must check those claims, current artist eligibility and the
stopped parent campaign, and halt on changes rather than mutate an approved plan.
After channel capture, shared captured handle aliases also hold all affected
artists, even if their original uploader channel IDs differed.

## Allocations and evidence

- Capture plan: at most one exact `metadata` GET per artist, reserving **2 cents
  per operation** (20 artists: at most 20 calls / 40 cents).
- Model plan: at most one exact `model` POST for each selected artist/channel
  that needs identity assessment and fits the existing **6,000-byte** transport
  limit, again reserving **2 cents per operation**. Supported Topic links,
  explicit organizations/fans, observed conflicts and unresolved unsupported Topic
  leads do not become artist-ownership model calls.
- Request bodies exceeding the limit are held, not silently truncated. All
  original evidence remains in the archive; no paid request is allocated for
  that pair. Preparing a different evidence policy requires fresh review.
- Allocations bind artist profile ID, Chartmetric ID, exact channel ID,
  catalog-evidence hash, all video provenance, exact request hash and (for models)
  immutable channel receipt/raw-body hashes and policy-input hash.
- Every plan embeds the original uploader source files, including exact raw
  response bytes, source plan/approval, source runtime and evidence fingerprints.
  Its own offline preparation runtime is sealed and hashed as well.
- Reservations are conservative bounds, not claims about billed costs.
  Preparation and approval perform **zero paid calls**.
- No searches, uploader repeats, redirects, fallback providers, top-ups,
  alternate channels or automatic retries are covered.

## Commands

From the workspace root, after the uploader stage has actually returned:

```sh
node scripts/src/prepare-youtube-video-identity.mjs \
  --prepare-captures \
  --source-id=youtube-video-review-UPLOADER-ID \
  --id=youtube-video-identity-NEW-CAPTURE-ID
```

IDs use lowercase letters, digits and hyphens. Output goes to a **new**
`generated-artifacts/ID/` directory:

- `plan.json`: full immutable evidence, alternatives, exact requests, allocations
  and approval boundaries;
- `summary.json`: pending plan hash, call/cap totals, deferred/shared counts and
  explicit unmeasured-accuracy status;
- `identity-alternatives.csv`: one row per preserved video/channel observation,
  including deferred alternatives and conflicts;
- `runtime/`: sealed offline preparer and its local dependencies.

Only after the user explicitly approves that hash and exact cap:

```sh
node generated-artifacts/CAPTURE-ID/runtime/prepare-youtube-video-identity.mjs \
  --authorize-prepared --id=CAPTURE-ID \
  --plan-sha256=EXACT-HASH --approve-cents=EXACT-CAP
```

This writes an exclusive `approval.json` only; it starts nothing. Preparation
does not grant permission to run this command. Changed inputs require a new ID,
plan hash and approval, never editing a pending or sealed archive.

After an independently approved capture executor has saved `returns.json` in
the capture archive:

```sh
node scripts/src/prepare-youtube-video-identity.mjs \
  --prepare-models --source-id=CAPTURE-ID \
  --id=youtube-video-identity-NEW-MODEL-ID
```

Use the same sealed `--authorize-prepared` pattern for the new model plan only
after a new explicit approval. A model plan never inherits capture spending.

## Immutable return contract for future execution

`returns.json` must contain:

- `approval`: the exact matching local approval record;
- `summary`: exactly `{id, planSha256, status:"completed", returnedCalls}`, where
  `returnedCalls` equals the number of allocated operations;
- `receipts`: exactly one entry per operation, no duplicates, each containing
  `receiptBytesBase64` (original UTF-8 envelope bytes) and `rawBodyBase64` (original
  provider response bytes).

Each receipt envelope binds `runId`, `planSha256`, `approvalSha256`,
`operationKey`, `profileId`, `cmArtist`, `channelId`, `kind`, `request`,
`inputSha256`, `status:200`, `capturedAt`, `rawPath` and `rawBodySha256`.
`rawPath` is `receipts/` + raw-byte `digest(operation.key)` + `.raw`.
Channel responses must report successful exact channel identity and known
`credits_charged` of 0 or 1. Model responses use the existing exact-request parser,
including its resolved-model allowlist and bounded billing evidence.

This contract is **not proof of a database acknowledgment or actual payment**.
A future live executor must write/sync these bytes before acknowledgment and
enforce per-operation reservations, owner fencing, global non-replay, uncertain
admission blocking and current eligibility in PostgreSQL. Do not fabricate a
completion summary to bypass that gate.

## Results and accuracy

Keep these categories distinct:

- **Artist-owned suggestion**: a positive exact bound model assessment under the
  existing ownership policy. Still not independently verified or accepted live.
- **Supported Topic — auto-generated**: captured Topic evidence tied to the exact
  catalog artist through corroboration under `youtube-topic-links.mjs`. This is
  music presence, **not artist ownership**. A name containing “Topic” alone is
  insufficient.
- **Unresolved**: missing/oversized evidence, unsupported Topic leads, shared or
  music-ID conflicts, model uncertainty/mismatch, or deferred alternatives.
  Detailed decisions preserve explicit fan/organization outcomes; grouping them
  here does not mean an ownership check is pending.

Uploader identity and video title relevance are discovery clues, never ownership
proof. `ownershipAccepted` and `liveLinkAccepted` remain false.
`ownershipAccuracy` remains null until independent source review; model agreement,
name agreement, completion counts and policy suggestions are not accuracy.
The targeted recovery cohort is not an all-artist success estimate.

## Offline verification

```sh
node --test scripts/src/youtube-video-identity.test.mjs \
  scripts/src/youtube-video-stage.test.mjs \
  scripts/src/youtube-topic-links.test.mjs
```

Fixtures cover exact receipts, mutation rejection, approvals, breadth loss,
deferred shared-channel conflicts, Topic separation, request byte limits, bound
answer review and a real CLI preparation/authorization round with provider and
socket access blocked and inherited credentials removed.
