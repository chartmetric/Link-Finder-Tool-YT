# Video uploader evaluation: offline review package

## Status and spending boundary

This delivers **only a non-executable offline prototype**. No paid request,
database migration, live approval, campaign resumption, catalog write or frozen
campaign edit is part of this work. No existing runner imports the new module.
The completed direct-channel test's approval and any unused reservations are
inapplicable. No spending approval has been obtained or inferred here.

The prototype is `scripts/src/youtube-video-uploader-review.mjs`, building on
`youtube-video-discovery-offline.mjs`. It has no network, credential, filesystem,
database or CLI execution path. Preparation cannot set an approval flag.
Simulation always returns `admitted:false, executable:false`, including when
the simulated checks pass. A later separately reviewed implementation and
explicit fresh exact-plan spending approval are both required before dispatch.

## Public provider documentation reviewed on November 12, 2026

These are documentation observations, **not live provider receipts**:

| Source | Confirmed detail |
|---|---|
| [API reference](https://docs.scrapecreators.com/v1/youtube/video) | `GET /v1/youtube/video`, required `url`, `x-api-key` authentication; one credit per request |
| [Endpoint overview](https://scrapecreators.com/youtube/endpoints/video-short-details) | Base URL `https://api.scrapecreators.com`, video/Short details; optional `language` and `cache_max_age` |
| [Public pricing](https://scrapecreators.com/#pricing) | Freelance: $47 / 25,000 credits; Business: $497 / 500,000 credits |

The exact proposed request allows only GET with one `url` parameter holding
the canonical HTTPS watch URL. No body, extra parameters, redirects, transcript
fetch, related-video traversal, language variant or cache variant is authorized.
The mapper never follows a URL. API-key headers are a future transport concern
and must never appear in the plan or raw-response archive.

At the published Freelance rate, one credit is $0.00188 = **0.188 cents**;
Business is $0.000994 = 0.0994 cents. Forty uploader requests are 40 credits,
$0.0752 at the higher of these public rates. Reserve **80 cents** (two cents
each) anyway. These are marginal credit costs, not a promise about account
contracts, taxes, top-up purchases, or a measured charge. This task does not
buy credits or read account credentials. A later executor must revalidate the
applicable price before approval; an unbounded cost stops activation, rather
than increasing the 200-cent cap. Keep search/channel/model price checks too:
the uploader price does not validate those providers' costs.

The reference's success example includes `success:true`, `credits_charged:1`,
top-level `id` and `url`, `channel:{id,url,handle,title}`,
`uploader:{channelId,author,url}`, and
`ownerByline:{channelId,name,url,...}`. Its `uploader.url` is HTTP and its
`channel.url` is a handle URL. The reference also documents 403 (age restriction),
404 and 500. None establish artist account absence. Optional cache usage can
cost zero credits but does not release or recycle an admission's reservation.

### Mapping decisions

1. Require original response bytes, status 200, `success:true`, exact `id`,
   matching video URL and valid top-level `channel.id`. Never select a channel
   from `watchNextVideos`, collaborators, video title, or search snippet.
2. When present, `uploader.channelId` and `ownerByline.channelId` must exactly
   agree with `channel.id`; malformed or conflicting identities block mapping.
   They are not assumed synonymous in the face of conflicting evidence.
   Missing optional objects do not prevent mapping a valid `channel.id`.
3. Map `channel.id` to canonical `uploader.channelId` and `channel.title` to
   `uploader.displayName`. Keep every other provider field in the raw receipt.
   This identifies the video's channel, **not the artist's owned channel**.
4. Preserve provider channel URLs as non-dispatchable observations.
   Valid handle/legacy URLs do not prove ID/handle equivalence. A conflicting
   ID URL or unsafe host fails closed. The documented HTTP URL is retained
   verbatim, inspected only for safety, never followed or silently promoted to
   an accepted channel alias.
5. Require `credits_charged` to be 0 or 1 for this documented contract. Unknown,
   increased or malformed billing requires review. Retain the original response
   before parsing even if mapping fails; never retry to repair a missing field.

The fixture uses synthetic values in this documented shape. It is neither a
live capture nor proof the current provider always conforms. Ownership flags
remain false, even for exact artist-name agreement; an independent ownership
check is still required under the existing acceptance policy.

### Raw receipt and exact identity

The mapper requires expected fresh run ID and exact plan hash separately from
the receipt; it checks profile ID, Chartmetric artist ID, video ID, operation
kind/key, exact method/URL request and request hash. The existing discovery
resolver also validates clue identity and sources. Raw input is a Buffer,
maximum 2 MiB, strictly decoded as UTF-8, with a matching SHA-256 and immutable
workspace-relative archive path plus capture time. Invalid JSON, oversized data
and unsafe paths fail closed.

The returned envelope contains exact bytes as base64, their hash and path, run,
plan, request, artist and video bindings, HTTP status and charged credits.
Canonical mapping and its separate hash are retained alongside original search
sources. Whitespace in raw JSON remains intact. **Returning bytes is not durable
persistence**: a future caller must save original bytes before invoking the
mapper, save the binding envelope/mapping separately, and only then acknowledge
the receipt transactionally. Failed or unparseable receipts must remain archived
with their original reservation; errors never become no-matches or refunds.

## Replacement allocation, not extra allowance

| Kind | Per exact artist | 20-artist calls | Reserved cents |
|---|---:|---:|---:|
| `search` | 1 | 20 | 40 |
| `video_uploader` | 2 | 40 | 80 |
| `metadata` (channel capture) | 1 | 20 | 40 |
| `model` | 1 | 20 | 40 |
| **Total** | **5** | **100** | **200** |

This replaces the old two-channel capture/check breadth, not supplements it.
Direct channels consume the same single metadata/model slots. Two resolved
videos may yield zero, one or two candidate channels; only one may proceed.
Selection is discovery relevance, not presumed ownership. Preserve alternatives,
deferred videos and truncation. No slot transfers across artists or kinds and
no reuse of failed, uncertain, cached, skipped or inexpensive reservations.

`prepareOfflineVideoEvaluation` freezes a fresh namespaced run ID, paused parent
identity, exact unique profile/Chartmetric pairs, runtime/evidence hashes,
per-kind limits, every operation key, exact request (including any model body),
video identity, request hash and two-cent reservation into a hashed plan.
It rejects duplicate keys/requests, out-of-cohort tuples, wrong video URLs and
overallocated kinds. A smaller saved-case plan cannot use its empty slots
without a new plan. Its approval status always requires fresh spending approval.

This exact-request proposal is for **saved cases**, where inputs are already
known. Live search outputs, channel IDs or model bodies not yet known cannot
be prefilled or wildcarded. Stop preparation, freeze the new evidence and seek
a separately reviewed exact plan; a dynamically bounded fresh-discovery policy
would require its own explicit authorization. Do not represent fixture requests
as an executable cohort or request approval for this synthetic test plan.

## Future transactional per-kind admission design

This is a design contract, **not an installed schema or live gate**. A separately
reviewed implementation must use a new coordinator namespace rather than change
the completed bounded test or frozen campaigns.

Required durable records:

- Immutable plan and explicit user approval bound to its hash, new run ID,
  runtime/evidence hashes, exact scope, 100-call / 200-cent maximum, operation
  allowlist and per-kind/per-artist limits. One active plan per run; preparation
  and code review are not user spending approval.
- A run row containing parent, owner/generation, status, approval fingerprint,
  nondecreasing reserved cents and calls.
- Immutable operation rows binding run, profile, Chartmetric artist, kind, key,
  request hash/shape and video ID for uploader work. Unique `(run,key)` and
  `(run,profile,cmArtist,kind,inputSha256)` constraints; slot ordinals unique per
  exact artist/kind. Uploader key includes both artist identities and video ID.
- Append-only admissions and raw-receipt references, with two-cent reservations.
  Receipt return is a fenced transition, not deletion/reinsertion or a refund.

One admission transaction must:

1. Begin; lock parent then new run in consistent order. Require parent stopped,
   matching owner/generation, eligible artist and running new run.
2. Verify committed, fresh explicit user approval equals the immutable plan hash,
   scope and runtime. Reject completed run IDs and historical approval reuse.
3. Match exact operation row and request hash, method, URL/body, artist tuple and
   video ID. A separately reviewed transport guard must validate the endpoint
   before admission. No caller-supplied cost or kind relabeling.
4. Reject prior uncertain/admitted work or any provider failure. For this
   conservative future evaluation, use a sequential gate, not campaign-wide
   concurrency assumptions. Reject the unique key if previously reserved.
5. Under those locks, count **all** admissions (including failures/uncertainty)
   against total calls, total reserved cents, run kind count and artist/kind
   count. Require a frozen unused slot. Do not calculate availability only from
   successful receipts.
6. Insert the two-cent admission, consume its exact slot, increment call and
   reserved counters with guarded updates, and commit **atomically**. Roll back
   every write on any failure. Only then may a future worker journal and dispatch
   once. A crash after commit is uncertain even if dispatch is not proven.

Receipt acknowledgment must lock/recheck the run owner/generation/status and
exact admission/request binding, require already-durable raw bytes and mapping
hashes, and update only that admission. Timeouts, non-200 statuses, oversized or
invalid receipts, owner loss or schema uncertainty close dispatch. Never retry,
refund, reset counters, or mark a saved local receipt acknowledged without the
required reconciliation approval.

`simulateOfflineVideoReservation` models one locked-snapshot transition:
expected revision, parent/owner, immutable plan reconstruction, exact historical
requests and receipt hashes, no uncertainties/failures/duplicates, nondecreasing
reservations and all limits. It returns a **simulated** admitted-state record
but never an actual admission. Revision checking is not a database lock; tests
cannot establish cross-process atomicity. That must be tested on an isolated
future coordinator before any activation.

## Review and approval checklist for a later task

- Recheck documentation, actual account pricing and raw schema; disclose the
  single-channel breadth loss and all unresolved assumptions.
- Implement and separately review the isolated coordinator, transport guard,
  raw persistence and acknowledgment fences; keep frozen workers unchanged.
- Prepare a real exact-request cohort and seal runtime/evidence and plan hashes.
- Ask the user to explicitly approve **that** new run ID/hash, operation mix,
  maximum 100 calls and 200 cents. Save that explicit approval immutably and
  commit it in the coordinator. Approval changes neither completed-run records
  nor the parent campaign's original authorization.
- No paid request before those checks, no reuse of this offline task as approval.

## Offline checks

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-video-uploader-review.test.mjs \
  scripts/src/youtube-video-discovery-offline.test.mjs \
  scripts/src/youtube-bounded-test-gate.test.mjs \
  scripts/src/youtube-bounded-test-plan.test.mjs
```

The fence disables fetch, HTTP, sockets, TLS and DNS. Tests cover documented-shape
mapping, HTTP handle observations, conflicting IDs, wrong artist/video/request/
run/plan identities, exact raw-byte retention, schema/billing uncertainty,
malformed/oversized data, altered plans, simulated owner/revision fences,
100 calls / 200 cents, nontransferable slots and non-replayable admissions.
The existing transport-rejection fixture continues to prove `video_uploader`
is rejected before real admission or dispatch.
