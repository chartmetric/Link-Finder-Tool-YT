# YouTube video-to-channel discovery — offline proposal

## Boundary

This is a **non-executable Main prototype**, not an enabled discovery policy.
`scripts/src/youtube-video-discovery-offline.mjs` has no transport or database
dependency. No paid runner imports it. The completed 20-artist test, campaign
runtimes, acceptance thresholds and catalog links are unchanged.

The existing parser in `youtube-discovery-test.mjs` accepts direct channel URLs
only; `youtube-music-search.mjs` ranks those direct candidates. The bounded
runner searches once, selects up to two channels, captures each, then checks
ownership. Video links are lost before ranking; channel subpages are lost too.
The saved audit found video results for seven of eight artists without direct
channel candidates. This does not establish seven missed owned channels.

## Discovery design

- Accept HTTPS on the exact existing YouTube hosts; short video URLs use only
  `youtu.be`. Reject credentials, nonstandard ports, lookalike hosts, escaped
  paths, backslashes, whitespace, dot-segment paths and arbitrary redirects.
- Normalize known channel tabs to the channel root, retaining every original
  result URL, index, title, snippet, result digest, search receipt digest,
  original request digest, capture time and exact catalog artist identity.
  Do not guess equivalence between a handle and a channel ID.
- Recognize watch, shorts, live and short URLs with exact 11-character video
  IDs. Deduplicate video IDs **within** an artist; retain all source occurrences.
- Queue at most two videos with a whole normalized catalog-name/alias mention.
  Prefer results without Topic/distribution or organization/third-party hints.
  Keep excluded and deferred videos visible. This relevance heuristic can match
  song titles, collaborators and unrelated same-name performers: it is not an
  identity judgment and does not change ownership acceptance.
- Preserve snippet handles as text mentions only. They do not identify the
  uploader and are never converted into channel captures or owner declarations.
- A saved canonical uploader receipt must bind the artist, exact operation,
  request digest, response digest and video ID to an exact uploader channel ID.
  A conflicting channel URL fails closed. Missing uploader data remains
  unresolved, not no-match. An uploader may be a label, fan, Topic channel or
  another musician. Even an exact artist-name uploader remains unverified.
- Deduplicate repeated channel observations only inside the exact
  profile/Chartmetric artist/channel tuple. Keep every receipt and occurrence.
  Never share an ownership verdict across artists; existing shared-channel,
  conflict, Topic and organization rules still apply to any later verification.

## Proposed operation and request allocation — not approval

`video_uploader` is a **new** proposed operation, not `metadata` under a different
URL. Its candidate request is GET
`https://api.scrapecreators.com/v1/youtube/video?url=<canonical-watch-url>`.
The endpoint, response mapping and billing have **not** been confirmed with a
live request. The fixture receipt's `{videoId,uploader:{channelId,channelUrl?,
displayName}}` is an adapter contract, not an observed provider response schema.
Before activation, review provider documentation/schema and conservative
per-operation pricing; if the existing two-cent reservation cannot bound the
operation, stop and redesign within the same caps. Do not increase them.

For a future separately prepared 20-artist run, replace the existing
`1 search + 2 captures + 2 model` maximum with:

| Operation | Maximum per artist | Calls for 20 artists | Reserved cents |
|---|---:|---:|---:|
| Search | 1 | 20 | 40 |
| Video uploader | 2 | 40 | 80 |
| Channel capture | 1 | 20 | 40 |
| Ownership model | 1 | 20 | 40 |
| Total | 5 | 100 | 200 |

Unused slots are not recycled to other operations or artists. Direct candidates
use the same single capture/model slots; they do not unlock extra slots.
At most one channel per artist may advance to capture/verification in this
proposal. Two video resolutions may resolve to one channel or neither. Choose
using discovery relevance only, retain alternatives, and label truncation; never
select based on an assumed owner. This costs candidate breadth and needs review
before adoption. No new video operations fit the **completed** test: its approval
cannot be extended and its unused budget cannot be reused.

### Required before any future execution

1. Prepare a fresh cohort and immutable runtime/evidence manifest with a new run
   identity, new plan hash, exact operation allowlist, slot counts and request
   shapes. Bind any later approval to that exact plan, never the historical ID.
   Freeze search outputs and artist/video requests before a separate saved-case
   evaluation; dynamic fresh discovery requires its own approved bounded plan.
2. Extend transport validation explicitly for `video_uploader` (exact endpoint,
   canonical video parameter, GET, no body, no redirects). The existing
   `campaignTransport.validateRequest` currently rejects it before admission.
   Preserve frozen workers rather than editing their allowlists.
3. Extend the **new** transactional admission path: lock parent/run, require
   paused campaign, owner, approved plan/scope, artist eligibility, exact
   operation/request hash, operation slot and unique key; atomically reserve two
   cents before journaling or dispatch. Enforce total calls, total reservations,
   per-kind and per-artist bounds together. The current bounded gate accepts
   only search/metadata/model and cannot execute this proposal.
4. Persist original raw response bytes and canonical adapter mapping with
   immutable hashes and source paths. A future channel capture may establish
   ID/handle alias equivalence; a video snippet may not. Keep channel metadata
   distinct from video and uploader metadata in ownership inputs.
5. Keep uncertain admissions non-replayable across interruption/restart. Stop
   after provider errors, timeouts, oversized/unparseable receipts, owner loss,
   spent caps or schema uncertainty. No automatic retries or reservation refunds.
   Receipt persistence and return acknowledgment must retain existing fences.
6. Obtain explicit new spending approval after that design is reviewed. This
   task does not authorize implementation of a live transport, a paid test,
   campaign resumption, threshold changes or catalog writes.

`assertProposedAllocationSlot` is a pure fixture model and always returns
`admitted:false, executable:false`; it cannot substitute for these transactional
requirements or authorize work.

## Offline verification and saved replay

Run fixtures (the network preload fences HTTP, fetch, sockets, TLS and DNS):

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-video-discovery-offline.test.mjs \
  scripts/src/youtube-bounded-test-gate.test.mjs \
  scripts/src/youtube-bounded-test-plan.test.mjs
```

Replay all saved searches, using an unused sibling output directory:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/replay-youtube-video-discovery.mjs \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11 \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11-video-discovery-offline
```

The replay compares all 200 files/symlink targets with both manifests in the
original sibling `-offline-review/archive-proof.json` before reading cases,
then fingerprints again before and after writing only to the new output
directory. Symlinks are hashed as targets, not traversed. It fails if any entry,
content or symlink target differs, or if the output already exists. Outputs
include per-artist clues, proposed requests, original unchanged decisions,
separate unresolved uploader/verification counts and a full before/after proof.
No synthetic uploader is inserted into saved cases: provider-schema fixtures
are labeled synthetic by their construction in the unit tests.

### Saved replay results

The network-disabled replay of the completed November 11 archive produced:

| Measurement | Result |
|---|---:|
| Artists replayed | 20 |
| Original artists without direct candidates | 8 |
| Those with video clues and eligible queued videos | 7 |
| Distinct artist/video clues | 90 |
| Proposed video-resolution operations | 37 |
| Eligible videos deferred by the two-per-artist bound | 53 |
| Channel-subpage result occurrences normalized | 8 |
| Snippet-handle mentions retained as text | 12 |
| Uploaders actually resolved | 0 |
| New verified matches | 0 |
| New provider calls / catalog writes / changed decisions | 0 / 0 / 0 |
| Original entries identical to earlier audit | 200 of 200 |

The seven video-only cases are Feliipejk, Bee Blackwell, RXTUAL, VAMPXL,
Ammar Haikal, Sophia Heart and prodbytwelve. trxllface's saved organic search
was empty; the prototype does not invent a candidate or assert account absence.
The eight subpage occurrences belong to Highland Spirit (1), The Nightclubs (1),
Damon. (1), Sophia Heart (3) and ЦУЕФА (2). Occurrence counts are not unique
channels or verified owners.

Bee Blackwell has seven saved video clues. The two proposed requests retain
`7QlExUa3fak` (“CLAWS”) and `Arq18EhTx64` (“THE KNIFE”) with their complete
search provenance. The latter snippet mentions `@beeblackwellmusic103`;
that text remains a mention, not a resolved handle, fetched channel or
ownership match. All seven uploaders remain unknown in this replay.
