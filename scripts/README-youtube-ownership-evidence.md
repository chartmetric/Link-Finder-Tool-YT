# Offline YouTube ownership evidence

This prepares evidence, not accepted accounts. It cannot resume a campaign,
send a model request, merge recovery results, or write catalog links.
Never edit a sealed runtime or its archived requests to use this work.

## Inputs and commands

The archived campaign is the source of complete original artist records,
candidate inputs, model answers, outgoing requests, provider receipts and
catalog metadata. Outputs use new exclusive paths outside that campaign.

Optional read-only catalog enrichment (database reads only; no provider calls):

```sh
node scripts/src/youtube-ownership-catalog-export.mjs --read-only \
  generated-artifacts/full-tiers-1-5-no-youtube-uncapped \
  generated-artifacts/NEW-catalog-export
```

This reads account-level snapshots, exact linked Spotify releases and catalog
track/ISRC facts. Every query and response is retained with observation time.
It does not equate a catalog link with independently verified official ownership.
It does not fetch bios, references, videos or music from external sources.

Optionally assemble exact existing reference captures from saved response
directories, without following their links:

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/collect-youtube-saved-references.mjs \
  generated-artifacts/NEW-catalog-export/packets.json generated-artifacts \
  generated-artifacts/NEW-catalog-export/packets-with-saved-references.json
```

The adapter admits only saved Instagram profile captures whose artist
occurrence, requested handle, returned handle and frozen linked catalog
account all agree. It does not promote newly discovered accounts or search
snippets. Old receipts without a request hash retain that limitation.
Provider formats outside this explicitly supported shape remain unavailable.

Prepare the offline packet (omit the optional catalog file to use only the
campaign's saved catalog metadata):

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/prepare-youtube-ownership-evidence.mjs \
  generated-artifacts/full-tiers-1-5-no-youtube-uncapped \
  generated-artifacts/NEW-ownership-preparation \
  generated-artifacts/NEW-catalog-export/packets-with-saved-references.json
```

The fence blocks fetch, HTTP(S), sockets, TLS, DNS and datagrams. It is a test
boundary, not a production transport. No credentials are needed by either
offline command.

## Output contract

- `originals/`: byte-identical complete originals, including full input and
  receipt files from failed/incomplete artist attempts.
- `manifest.json`: original file byte hashes and supplemental source hashes.
- `artists/`: original decisions and complete packets alongside reconstructed
  captures, source-bound observations, unavailable fields, context-only bios,
  separate search snippets and explicitly proposed unsent inputs.
- `summary.json` and `review.md` / `review.html`: occurrence-level counts and
  artist-level counts; reconstructed metadata is never described as acceptance.
- `approval-plan.json`: non-executable plan binding candidate/artist scope,
  catalog reference URLs, video channel targets and evidence/request hashes.
  Its budget and approval remain unset.

Channel-attributed video records must come from an exact receipt-bound channel
response and explicitly identify the publishing channel and video ID. Release
title matches in snippets, captions or third-party uploads are not such records.
Absent channel-role flags are unknown; a generic verified flag is not OAC.

Original answers are never attached to reconstructed or enriched inputs.
Every proposed request is measured against the exact byte limit in the frozen
campaign approval (64000 bytes in the paused continuous campaign, not the
separate pilot's 6000-byte limit).
Oversized proposals remain held; evidence is not silently discarded and the
limit is not raised. Supplemental declarations are evidence for a future
comparison, not a new automatic acceptance route. Existing Topic, fan,
organization, Spotify-conflict and reused-channel exclusions remain unchanged.

Any paid reference/video/model comparison needs a separate exact approval,
capped spending, current eligibility, a frozen runtime, input/request hashes
and non-replayable admissions. Added captures change request hashes and require
new approval. None of this authorizes a campaign resume or catalog import.

## Checks

```sh
pnpm --filter @workspace/scripts test:youtube-ownership-evidence
```

Synthetic fixtures are labeled as synthetic. The subprocess test exercises the
whole offline assembler with credentials removed and network operations
blocked, and checks preservation, binding, exclusions and approval boundaries.
