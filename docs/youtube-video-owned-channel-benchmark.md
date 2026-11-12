# Saved video relevance and artist-ownership benchmark

## Finding

**The saved evidence cannot identify how often these videos lead to artist-owned
channels.** There are no video-to-uploader metadata receipts. All 90 uploader
identities and ownership labels are explicitly **unknown**; the scored ownership
denominator is **zero**, and the ownership rate is **null**, not 0%.

This benchmark independently source-labels the **text relevance** of all 90
artist/video pairs from the completed November 11 main-fixes pilot (20 artists,
84 distinct video IDs). It measures the heuristic and allocation without claiming
missing ownership ground truth. Shared videos remain separate artist pairs;
within-artist URL aliases retain their source occurrences under one video ID.
The empty trxllface search remains an empty saved search, not account absence.

No paid refetch, external page refresh, catalog access/write, model invocation,
acceptance change, budget recycling, transport extension, campaign activation or
worker reseal was performed. The existing offline heuristic is unchanged.

## What was independently adjudicated

The curator read each saved primary title and snippet and wrote the labels in
`scripts/fixtures/youtube-video-relevance-adjudications.tsv` separately from
evaluation. Predictions are then computed by the real `planVideoDiscovery`
implementation, not copied into the answer labels. Archived model answers and
acceptance decisions do not determine any source label.

This is **single-curator source adjudication**, not two-human agreement or a
blinded review. The curator knew the heuristic, and the sample was already used
in development. It is not a held-out calibration set or a representative
population sample.

The adjacent `youtube-video-benchmark-policy.json` pins the exact replay SHA-256,
review date, reviewer identity, definitions, prior exposure and missing evidence:

| Dimension | Meaning | Saved label availability |
|---|---|---|
| Text relevance | Primary recording/title explicitly credits the target name as performer or contributor | 66 relevant; 3 unrelated; 21 unknown |
| Exact catalog identity | That performer is the exact profile/Chartmetric artist, rather than another same-named performer | Unknown for all video cases |
| Actual uploader identity | Exact video ID bound by saved metadata to an exact uploader channel ID | Unknown for all video cases |
| Artist ownership | Independently supported ownership of that uploader by the catalog artist | Unknown for all video cases |

“Relevant” is deliberately weaker than “the catalog artist made this video.”
Short names inside longer performer names remain unknown. Distributor credits,
recommendations, official-video wording, generic channel verification, exact-name
handles and “Go to channel” text are not uploader bindings or ownership proof.
Original channel captures identify those direct candidates only; they cannot be
joined to a video because a snippet mentions the same channel.

## Results

| Subset | Pairs | Relevant | Unrelated | Unknown | Precision on scorable text |
|---|---:|---:|---:|---:|---:|
| All saved video clues | 90 | 66 | 3 | 21 | 66/69 = 95.7% |
| Heuristic-eligible videos | 90 | 66 | 3 | 21 | 66/69 = 95.7% |
| Two-video queue | 37 | 28 | 2 | 7 | 28/30 = 93.3% |
| Deferred eligible videos | 53 | 38 | 1 | 14 | 38/39 = 97.4% |

All 90 saved videos match the heuristic, including the three source-text
negatives. Eligibility recall on the 66 text positives is 100%; specificity is
not estimable from this all-eligible sample. The two-video queue retains 28/66
text positives (42.4%), but this is **not uploader or ownership recall**.
Unknowns are explicitly excluded from scored precision, not counted as negatives.
The eligible confusion counts are TP 66, FP 3, FN 0, TN 0, unscored 21.

For both all clues and the queue, ownership precision is undefined. The only
logical identification bounds are 0–100%; these are not confidence intervals.
No ownership false-positive rate, channel recovery count, or launch-readiness
claim follows from text precision.

### Strata and examples

All cases have a rationale, tags and exact receipt/result provenance in the
output. Tags can overlap; stratum counts must not be added as disjoint samples.

- **Song-title collisions:** Highland Spirit is a Taylor Davis work title in
  `uHJucQj1C-Q`, and a track credited to Aaron Dolan in `F1zipMUI34o`. Both are
  unrelated at the primary target-artist-credit level, despite passing the
  name-overlap heuristic. Their actual uploader channels remain unknown.
- **Related-item contamination:** Feliipejk appears after “Go to channel” in
  `4bIavF_TfW4`; the primary recording is *Con Mi Mente* by BTC. Other truncated
  related-content cases are unknown rather than asserted wrong identities.
- **Collaborators:** mxbeats/DRYFTMODE/Suzi/RXTUAL recordings, Sophia Heart
  collaborations and prodbytwelve production credits establish text relevance,
  not which contributor owns the uploading channel.
- **Distributor / Topic:** “Provided to YouTube by” and auto-generation text
  appear in saved credits. “Topic” also occurs inside related-item snippets.
  Neither establishes the actual video uploader or artist control. A distributor
  name is not automatically the uploader's name.
- **Cover / lyrics:** Sophia Heart cover titles, Ammar Haikal's Rockestra version,
  The Nightclubs' CD-R lyrics, and Bee Blackwell's official lyric video supply
  observed format strata. A lyric video can be artist-uploaded; these are **not**
  independently adjudicated cover/lyrics channel identities.
- **Exact-name claims:** Bee Blackwell's THE KNIFE snippet mentions
  `@beeblackwellmusic103`; The Nightclubs' Clairaudient mentions `@TheNightclubs`.
  The claims remain source text, not resolved uploader aliases.
- **Fan and exact-name uploader controls:** no saved video receipt proves either
  uploader class in this archive. Explicitly synthetic regression controls cover
  fan, cover, lyrics, Topic, distributor, collaborator and both owned/impersonator
  exact-name uploaders. They never enter the saved-sample denominator. Even when a
  synthetic receipt supplies an exact channel ID and exact artist display name,
  the resolver must still require independent ownership checking.

## Candidate breadth lost by the proposed allocation

The historical plan allowed `1 search + 2 captures + 2 model checks`. The offline
proposal replaces it with `1 search + 2 video resolutions + 1 capture + 1 model
check`, without exceeding the original 100-call / 200-cent design maximum for
20 artists. This remains a proposal, not approval to execute any operation.

### Two-video truncation

- 37 of 90 eligible artist/video pairs queued (41.1%).
- 53 deferred (58.9%), including **38 of 66 text-relevant clues**.
- 37 operations are **not** 37 distinct uploader channels. Resolutions could
  converge on the same channel, overlap direct candidates, fail, or supply no
  uploader binding. Actual new channel breadth remains unknown.

### One-capture truncation

- The historical test selected **16 direct candidate addresses across 11
  artists**, with distinct channel IDs within each artist's selected candidates.
- A one-capture limit can retain **at most 11** of those addresses: loss of
  **5 slots (31.25%)**, across DELIN, Suzi, CICERO!, Damon. and ЦУЕФА.
- These are optimistic direct-retention ceilings: video-derived candidates would
  compete for that same capture, so actual retention could be lower.
- The maximum planned capture slots for a full cohort fall **40 → 20 (50%)**.
- No direct-versus-video selection policy is specified or enabled. The report
  retains all alternatives instead of assuming that the best or owned one wins.
- Actual artist-owned channels lost cannot be measured without uploader bindings
  and independent ownership labels. Address counts, channel IDs, capture slots
  and artist/video pairs remain separate units.

The per-artist output includes original selected URLs/channel IDs, normalized
direct clue addresses, eligible/queued/deferred videos, relevant deferrals and
conservative unresolved channel-diversity bounds. Cross-artist channel reuse is
not treated as a new channel or an ownership adjudication.

## Reproduction

Both commands are network-fenced. If the replay is missing locally, reproduce it
from the intact saved source and its original audit first:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/replay-youtube-video-discovery.mjs \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11 \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11-video-discovery-offline

node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/run-youtube-video-benchmark.mjs \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11 \
  generated-artifacts/youtube-test-20-main-fixes-2026-11-11-video-discovery-offline \
  generated-artifacts/youtube-video-owned-channel-benchmark-2026-11-12
```

Outputs must not already exist and must be outside both input directories. Use
a new sibling output name for a later run; do not delete or modify an old run.
If the saved source is unavailable or differs from its audit, the benchmark
fails explicitly rather than inventing evidence or fetching replacements.

The CLI checks the replay digest, original before/after audit manifests,
artist bindings, original search request hashes, receipt hashes, result hashes
and the complete video universe. It then recomputes the heuristic from original
organic results. The curated labels must match the exact case universe: missing,
duplicate and extraneous labels fail. The original 200 files/symlinks and the
replay are fingerprinted again after output generation.

Generated outputs (kept out of Git/deployments):

- `report.html`: self-contained readable report, all case rationales and
  per-artist allocation table.
- `summary.json`: scorable/unknown denominators, confusion counts, stratum
  breakdowns, allocation measurements and explicit zero-side-effect boundary.
- `cases.csv`: all 90 labels, three distinct identity/ownership dimensions,
  every source occurrence and source hashes. Spreadsheet-formula-safe.
- `candidate-breadth.csv`: every artist, including the empty search.
- `evidence.json`: full source projections, adjudication policy and hashes of
  labels, replay and heuristic implementation.
- `archive-proof.json`: before/after manifests for both input directories.

Regression checks:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/youtube-video-benchmark.test.mjs \
  scripts/src/youtube-video-discovery-offline.test.mjs \
  scripts/src/youtube-bounded-test-gate.test.mjs \
  scripts/src/youtube-bounded-test-plan.test.mjs
```

The local archive integration check runs when the replay is present; otherwise
it explicitly skips while the synthetic contract/metric tests still run.
Fixtures do not pretend to replace independently sourced ownership evidence.
Any future collection, paid evaluation, acceptance change or campaign
activation still needs separate exact-scope authorization.
