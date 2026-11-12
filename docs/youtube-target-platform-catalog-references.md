# Target-aware catalog references for future YouTube preparation

The saved pilot's zero Instagram references describe its delivered inputs, not
catalog availability: its collector excluded Instagram before assembly. No live
catalog availability or ownership conclusion was established by this change.

## Preparation contract

`scripts/src/target-platform-catalog-metadata.mjs` provides explicit
`targetPlatformMetadataQueries` and `collectTargetPlatformMetadata` entry points.
Both default to the existing Instagram-target behavior. Unsupported targets fail
closed.

For **new YouTube preparation**, accounts and profile snapshots exclude YouTube,
not Instagram. Account reads require the active account and connected
profile/account link, joined through `new_vertical.profile` with
`cm_source='cm_artist'`. Returned rows must also match the scoped profile and
Chartmetric artist, have an account ID, and explicitly retain active/connected
status. Instagram references must have a valid HTTPS Instagram profile URL.
Inactive, disconnected, malformed and mismatched rows are not references.

The account-first collector ignores caller-supplied account lists and campaign
likely candidates. It freezes only qualifying rows from its catalog account
query, then uses those references for remaining metadata reads. Each reference
retains profile, Chartmetric artist, account, source, update/connection dates,
observation time and account-query hash. Packets retain the SELECT queries.
Spotify IDs discovered in this first step are available to release queries.

The future bounded-test preparer and uncached saved-YouTube review preparation
use this collector explicitly with `targetPlatform: 'youtube'`. Existing saved
review overlays are not silently upgraded. Supplemental exports retain the new
packet provenance and bind account snapshots to exact account IDs and platforms.

## Evidence and authorization boundaries

- A catalog reference remains a catalog observation, not independently verified
  ownership.
- Profile/platform snapshots remain context, not account-level declarations.
- Exact account snapshots may supply **catalog** declarations. Independently
  captured declarations remain separately labeled and bound by their existing
  receipt checks.
- No ownership policy, acceptance threshold, transport or channel decision was
  changed.
- The shared Instagram collector, continuous campaign/recovery worker sources,
  sealed runtimes and all historical archives remain unchanged.
- This code change grants no permission to collect live evidence, spend money,
  rerun models, resume a campaign, or write catalog links. Existing output
  directories are not reusable fresh-run destinations.

## Offline verification

Run from the workspace root:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs --test \
  scripts/src/target-platform-catalog-metadata.test.mjs \
  scripts/src/instagram-artist-metadata-overlay.test.mjs \
  scripts/src/youtube-ownership-evidence.test.mjs \
  scripts/src/youtube-ownership-policy.test.mjs \
  scripts/src/youtube-ownership-legacy.test.mjs
```

All catalog responses are synthetic fixtures. The preload blocks fetch, HTTP,
TCP, TLS, DNS and datagram network operations. Fixtures cover active bindings,
candidate exclusion, unchanged Instagram defaults, supplemental export,
outgoing request construction, catalog-versus-captured evidence distinctions,
and immutable source files. They do not measure model accuracy or predict a
changed historical verdict.
