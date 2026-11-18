# Release collection versus artist channel: offline regression and proposal

## Scope and finding

This is a shared, **review-only** correction proposal. It does not change the
transport normalizer, artist-representation parser, historical suggestions,
sealed campaigns, catalog, or workers. No sources were refreshed and no paid work
was replayed. The new module has no transport, persistence, or activation path.

The motivating source review is
[`youtube-58-accuracy-review.md`](youtube-58-accuracy-review.md), “Important
unresolved cases.” A read-only inspection of the already-saved
`generated-artifacts/youtube-test-100-coverage-75-20261117-recovery-cont1/results.json`
confirmed this common shape:

| Captured title | Captured description | Captured external help URL |
| --- | --- | --- |
| Wicked With You | empty | `https://support.google.com/youtube/answer/2579942` |
| Ambiance | empty | `https://support.google.com/youtube/answer/2579942` |
| Unsure | empty | `https://support.google.com/youtube/answer/2579942` |

These names are evidence motivating the regression, **not overrides or test
identities**. All test artists, releases, IDs, answers and receipts are synthetic.
This investigation does not independently establish that those three pages are
collections, nor reject their artists' music presence.

### Where the ambiguity is lost

`normalizeYoutubeChannel` correctly keeps the captured release title, empty
description, external help URL, and unknown badges. Search wording remains in
`candidate.searchEvidence`; it is not physically copied into channel metadata.

However, `parseArtistRepresentationResponse` permits a positive
`topic_identity_supported` answer when safety returns `needs_identity_check`,
even if the captured title is a release rather than the artist, the only
auto-generation clue is a help link, and artist attribution is only in search
text. The synthetic reproduction asserts that this unchanged baseline returns
`reviewSuggestion: true` and `Topic — auto-generated`.

This demonstrates a permissive interpretation boundary, **not proof of why a
historical model chose its answer**. No fresh model was queried and synthetic
answers are not accuracy measurements.

## Separate correction proposal

`scripts/src/youtube-collection-review.mjs` is imported only by its offline tests.
It first runs the unchanged parser, retaining all its receipt, catalog, request,
model, billing and conflict checks. It then creates a separate derived review:

- An exact captured auto-generated-channel help article plus a channel title
  inconsistent with the catalog artist or supplied aliases retains
  **release-collection / unresolved-auto-generated-channel ambiguity**.
- The help article alone does not establish a collection or artist Topic page.
  A release-title match is source-path evidence of the ambiguity, not required
  proof of a collection and not an artist identity bridge.
- Auto-generation flags (even true), generic verification, exact outgoing music
  links and search wording cannot resolve this specific title/type ambiguity.
- A previously positive review suggestion is held with
  `release_collection_channel_identity_unresolved` and labeled
  **Unresolved — release collection or artist channel**.
- Existing negative, uncertain and conflict decisions remain unchanged.
  The original model category and receipt remain intact, separately from the
  derived safety decision.
- Artist-name-consistent Topic captures remain subject to the original identity
  safeguards and are labeled **Topic — auto-generated**, never artist-managed.
  Name consistency is not itself identity proof.
- Only captured handle/ID aliases are recognized. URL equivalence does not prove
  artist identity or channel type. Unrelated handles, channel IDs and video URLs
  cannot use that capture.

The wrapper never modifies a request, capture, answer, archive or original
result. It returns `reviewOnly: true`, `executionEnabled: false`,
`policyActivated: false`, `ownershipAccepted: false`, `importEligible: false`,
`catalogWritten: false`, and retains false live-link/verified flags.

This intentionally conservative proposal can hold a legitimate artist page
whose different stage name is not supplied as a catalog alias. It also cannot
detect every collection: missing/other help links and artist-name-consistent
collections are outside this narrow guard. It is not a production-ready channel
taxonomy or a replacement for source-bound identity review. Do not wire it into
existing workers or reinterpret historical decisions without separate approval.

## Offline checks

Run with network operations blocked:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-collection-review.test.mjs \
  scripts/src/youtube-artist-representation.test.mjs \
  scripts/src/youtube-ownership-badges.test.mjs \
  scripts/src/youtube-topic-links.test.mjs \
  scripts/src/youtube-ownership-policy.test.mjs \
  scripts/src/youtube-ownership-legacy.test.mjs \
  scripts/src/youtube-context-revision.test.mjs \
  scripts/src/youtube-combined-ownership.test.mjs
```

Coverage includes legacy positive promotion; collection versus genuine Topic
captures; absent, null, malformed, true and false badges; generic verification;
search-only and malicious attribution; source immutability; supported Topic
music presence without management; exact help URL boundaries; explicit aliases;
captured handle-to-ID and ID-to-handle bindings; unbound aliases; shared channels,
contradictory captures and Spotify conflicts; negative/uncertain answers; and
tampered receipt/request/capture rejection.

Result: **88 tests passed, 0 failed**, including 10 new synthetic regression
tests, with network operations blocked.

No UI, running service, or campaign workflow was changed or restarted. Recovery
evidence retention and collaborator Topic attribution remain separate work.
