# Offline mixed-channel archive regression

Run from the workspace root:

```sh
pnpm --filter @workspace/scripts run test:youtube-mixed-channel-archives
```

This is a real-archive check, separate from the synthetic unit suite:

```sh
node --test scripts/src/youtube-mixed-channel-captures.test.mjs
```

## Required evidence

The replay requires the original local folders under `generated-artifacts/`:

- `youtube-mixed-captures-fresh-twenty-2026-11-13`
- `youtube-test-20-review-search-2026-11-13`
- `youtube-video-review-fresh-twenty-2026-11-13`
- `youtube-video-review-fresh-eight-continuation-2026-11-13`
- `youtube-video-review-fresh-six-hold-2026-11-13`

These archives are intentionally not committed to Git. A fresh checkout without
them fails with a required-archive error, not a skipped or passing test. Restore
the exact saved archives from your existing archive copy. Do not rerun paid
preparation, refetch providers, generate replacement receipts, or update the
pinned fingerprint to make a failure pass.

The prepared plan's pinned SHA-256 binds the source-file manifest. The harness
checks all 353 bound source files, source approvals and frozen runtime hashes,
then reconstructs candidates from the twenty search receipts and uploader
results from the 24 saved responses. The uploader archives include stopped stages;
their two contradictory responses must remain unresolved, not become new channels.
The output must exactly reproduce all prepared decisions: 13 selected channels,
19 held leads and 2 deferred alternatives.

The regression suite also changes **in-memory copies only** to challenge snippet
overrides, held-uploader overrides and duplicate observations. It checks unresolved
handle targets, separate channel alternatives and retained Topic/Music labels.
Neither a candidate nor a selected capture target is an accepted artist identity.

## Safety

The command preloads `youtube-ownership-offline-fence.mjs`; the replay module also
imports it so calling the module directly stays fenced. Fetch, HTTP(S), socket,
TLS, UDP and covered DNS operations are blocked. No credentials, database, paid
provider or execution CLI is needed. The harness only reads archives, writes no
output files, and rechecks the fingerprints of everything it read before
returning. A source mismatch or missing file is a hard failure.
