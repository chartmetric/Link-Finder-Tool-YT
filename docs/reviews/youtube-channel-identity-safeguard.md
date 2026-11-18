# Offline proposal: keep collaboration credits separate from channel identity

## Status and boundary

Prepared for review only. **Not activated.** No provider/model calls, database
access, catalog writes, campaign runs or historical-result rewrites are needed
to prepare or test this proposal.

The existing `artistRepresentationRequest`, `parseArtistRepresentationResponse`
and `REPRESENTATION_VERSION` contract retain their previous behavior. Executable
review, coverage and fresh-review paths still use that contract. This proposal
does not add a runtime switch or wire itself into those paths.

The separate exports in `scripts/src/youtube-artist-representation.mjs` are:

- `CHANNEL_IDENTITY_VERSION`: distinct offline proposal identity.
- `channelIdentityRequest`: copies the existing full evidence request and adds
  channel-versus-recording identity guidance; recomputes request/state hashes
  and the byte limit without trimming sources.
- `channelIdentityReviewGate`: source-based checks for positive review routes.
- `parseChannelIdentityResponse`: interprets only a response bound to this
  exact new request, preserving its raw model choice separately from any hold.

The new parser rejects old requests/answers, and the old parser rejects the new
proposal. No historical answer is reinterpreted as a new assessment.

## Shared rule

A featured, co-primary, producer or composer credit associates the artist with
a recording, not necessarily its uploader's channel. Credit order does not
determine channel identity. The proposal supplies that guidance to a future
assessment and independently constrains its positive review routes:

| Captured evidence | New offline review route |
|---|---|
| Topic identity names another artist, even with a credited recording or matching outgoing catalog link | Hold: `topic_channel_identity_not_catalog_artist` |
| Topic name agrees with the artist or an explicitly supplied catalog alias, but has no catalog bridge | Hold: `topic_channel_identity_needs_catalog_corroboration` |
| Topic identity agrees, with an exact active catalog-account link or existing source-supported Topic declaration route | Eligible for the Topic assessment route, not automatic acceptance |
| Topic capture receives an artist-facing or artist-managed answer | Hold: `topic_requires_separate_category` |
| Non-Topic capture receives a Topic-positive answer | Hold: `topic_requires_captured_topic_channel` |
| Artist-facing channel with an exact catalog reference, no existing safety conflict, and positive representation assessment | Retain artist-facing review support; management remains unverified for the representation category |
| Shared channel, contradictory pair, conflicting music identity or other existing safety rejection | Preserve the hold |

These are conservative source prerequisites, **not ownership adjudications or
proof that a matching name/account link alone is correct**. The complete model
assessment still needs combined identity/representation evidence. Missing a
prerequisite holds the suggestion; it does not assert a wrong artist or absence
of any YouTube channel. An unestablished renamed Topic identity remains held,
even if a collaboration suggests an association. No alias is invented from
credits or snippets.

## Offline checks and exposed cases

`scripts/src/youtube-artist-representation.test.mjs` covers:

- Trendy Boy / DJ Save - Topic and Section Five / Balcony Mix Africa - Topic,
  plus unrelated synthetic collaborator names and reversed co-credit ordering.
  Even deliberately positive synthetic answers cannot bypass the new hold.
- Genuine primary-artist Topic channels with collaborations, Unicode-normalized
  names and explicit catalog aliases; Topic labels and non-ownership persist.
- Name/recording-only uncertainty, valid versus altered captured declarations,
  conflicting Spotify IDs, and artist-facing collaboration channels.
- The shared `UCtXS5ljfO4NG94I6ResVFKg` hold for both Villager SA
  (`3783654 / 7006976`) and Mokgaetse (`4152222 / 16284853`), passed through the
  existing shared/contradictory safety flags. This pair-level helper does not
  discover shared usage; cohort callers must continue supplying those flags.
- Immutable original inputs, exact new-request binding, changed-context and
  request-size rejection, and unchanged executable defaults.

The artist examples are exposed development regressions, **not a new accuracy
measurement or a held-out benchmark**. Captures and answers in these checks are
synthetic; the original review and all saved adjudications remain untouched.
No work on remaining-artist recovery, saved-evidence retention, or collection
normalization is included.

Reproduce with network access blocked:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-artist-representation.test.mjs \
  scripts/src/youtube-topic-links.test.mjs \
  scripts/src/youtube-shared-candidate-offline.test.mjs \
  scripts/src/youtube-fresh-review.test.mjs \
  scripts/src/youtube-coverage-execution.test.mjs \
  scripts/src/youtube-context-revision.test.mjs \
  scripts/src/youtube-combined-ownership.test.mjs \
  scripts/src/youtube-suggestion-accuracy.test.mjs
```

Any activation, fresh paid assessment, catalog import or historical re-export
needs its own approval and exact scope. Supported Topic music presence remains
separate from artist management and live-link acceptance throughout.
