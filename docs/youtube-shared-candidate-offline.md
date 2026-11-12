# Shared YouTube candidate guard: offline comparison

Status: **proposal disabled; explicit approval required**. This work is not an
acceptance policy, a paid experiment, or permission to resume a campaign.

## Measured result

The comparison covered 20 artists and all 16 original candidate pairs. The three
blanket shared-channel holds would become three independent identity reviews;
none has source-supported competing claims in the supplied evidence. This is
not three recovered matches: ownership remains unknown. No new model checks,
provider requests, catalog writes or historical changes occurred.

The archive replay and 23 credential-free tests passed. Both source directories
were unchanged, including scope hashes, approval, frozen runtime, receipts,
original inputs, answers and the earlier offline audit.

## What the frozen test establishes

The completed `generated-artifacts/youtube-test-20-main-fixes-2026-11-11`
test retrieved channel `UCVbraeFV_56E1Ygj3zsOXew` for DRYFTMODE, mxbeats and
Suzi. The sibling `-offline-review/summary.json` and `evidence-detail.json`
record three `channel_reused_across_catalog_artists` decisions before model
checks. No ownership answer exists for any of those three pairs.

Release snippets mention several collaborators. That explains a possible
discovery path, not three source-supported ownership claims. The captured
channel describes Suzi and links an Apple artist page, but the frozen catalog
packets do not connect that Apple ID to any of the three artists. The Spotify
destination is a playlist, not an artist reference. Suzi has no frozen linked
accounts, including no Spotify reference. Name agreement does not prove ownership.

## Current guard and proposed review design

Inspected source paths:

- `scripts/src/run-youtube-bounded-test.mjs` builds a channel-to-profile set
  for the whole cohort and checks prior channel discoveries. All repeated
  channels become shared holds before preparing model inputs.
- `scripts/src/run-youtube-campaign.mjs` records discovered profile/channel
  pairs and retroactively clears earlier likely flags when another artist
  retrieves the channel.
- `scripts/src/youtube-campaign-core.mjs` dispatches an identity check only
  after the shared guard permits it.
- `scripts/src/youtube-ownership-policy.mjs` gives sharing precedence over
  metadata, music-ID conflicts and identity checking.
- `scripts/src/youtube-channel-dedup.mjs` binds metadata aliases within an
  exact profile/music-catalog identity. It does not authorize sharing ownership
  judgments between artists.

**None of these files or sealed copies were changed.**

The separate offline comparator distinguishes:

| Evidence | Proposed review route |
| --- | --- |
| Repeated retrieval, collaborator text or same-name candidate only | Separate artist-specific identity review; still unresolved |
| Multiple distinct music-catalog identities with exact bound declarations or matching channel music IDs | Hold competing source-supported claims; select no winner |
| Duplicate observations or profiles sharing a music-catalog ID | Retain every occurrence and mark possible duplicate catalog identity; never infer ownership |
| Conflicting catalog music IDs or account declarations/captures | Keep contradictions and hold the affected pair |
| Missing or invalid channel capture, Topic/fan/organization gate | Keep the existing hold/exclusion |
| Unknown ownership or no reference | Unknown, not mismatch or confirmed absence |

Source-supported claims are review signals, **not independently verified owners**.
Search snippets, collaborator credits, generic badges and name similarity do
not create claims. Music ID comparison includes Spotify artist and Apple Music
artist IDs in this offline proposal; playlists are excluded. Other unparsed
links remain in the evidence rather than being declared nonconflicting.

Every occurrence carries the original input and hash, exact profile ID,
music-catalog ID, channel ID and URL. Peer inputs, claims, alias observations and
contradictions are retained in a separate review envelope, whose assessment hash
includes both the target pair and all peer evidence. Adding or changing a peer
invalidates that envelope. Original model answers are retained only as historical
answers bound to their original input; none is applied to this new envelope.
Metadata may establish account alias equivalence, but never artist equivalence.

The prototype performs no model checks and returns **no accepted links**, even
for a direct declaration or favorable historical answer. A possible future
implementation must require separately approved policy activation, exact-pair
assessments over the full shared envelope, existing channel-type and conflict
gates, unchanged acceptance criteria, and order-independent reconciliation when
later evidence introduces a competing claim. It must not upgrade a sealed worker.

## Reproduce without credentials

From the workspace root:

```sh
env -i PATH="$PATH" HOME="$HOME" node \
  --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  --test scripts/src/youtube-shared-candidate-offline.test.mjs \
  scripts/src/youtube-ownership-policy.test.mjs

env -i PATH="$PATH" HOME="$HOME" node \
  --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/compare-youtube-shared-candidates.mjs \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11 \
  generated-artifacts/youtube-shared-candidate-comparison-2026-11-12
```

Choose a new output directory for a rerun: exclusive creation prevents overwrites.
Both source directories are fingerprinted before and after. The runner checks
scope, approval, supplemental packet and frozen module hashes; every reconstructed
pre-model input must match its archived decision hash. Actual model inputs also
must match the original receipt state and outgoing request hash. A hash-matching
pre-model reconstruction is explicitly labeled, never described as a request that
was sent. No database, provider client, secret or running workflow is needed.

Outputs are `comparison.json`, `exact-inputs.json`, `archive-proof.json` and
`review.md`, under ignored `generated-artifacts/`, not committed source archives.
The comparison includes all 16 original candidate occurrences, not just the
three motivating holds, and leaves all other historical decisions visible.
