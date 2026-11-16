# Identity preparation from mixed-source channel captures

This workspace-only preparer reads the **new mixed capture contract**, not the
older completed-uploader contract. It performs no provider calls, database access,
approval, catalog writes or campaign resumption. All output is a proposal.

```sh
node --import ./scripts/src/youtube-ownership-offline-fence.mjs \
  scripts/src/prepare-youtube-mixed-identity.mjs --prepare-only \
  --source-id=youtube-mixed-captures-fresh-twenty-ready-2026-11-13 \
  --id=youtube-mixed-identity-fresh-twenty-2026-11-14
```

The command creates an exclusive new `generated-artifacts/ID/` directory. It has
no execution or authorization mode. Do not run an old video identity worker with
the new plan: its source contract, approval policy and byte allowance differ.

## What is frozen

- `plan.json`: all original source bytes (base64), original catalog packets,
  source and capture runtime hashes, exact receipt and raw metadata bytes,
  captured canonical IDs/aliases, discovery kinds, all held/deferred alternatives,
  policy assessments and exact model requests with UTF-8 sizes and SHA-256 hashes.
- `approval-proposal.json`: the new plan/allocation hashes, exact request and
  body hashes, proposed request-byte ceiling and proposed model reservations.
  **Not approved, not executable.**
- `identity-review.csv`: one row per captured artist/channel pair, policy
  disposition, Topic status, request binding and immutable evidence hashes.
- `summary.json`: separate captured/uncaptured, held, proposed-call and Topic
  counts; preparation spending/writes and accepted links are all zero.
- `runtime/`: the sealed offline preparer and local dependencies.

The mixed capture runner wrote complete `returns.json` but did not update its
earlier `prepared_not_approved` summary. This tool does not rewrite that summary
or manufacture a completed uploader stage. It validates every expected capture
against its original approved request, saved receipt, raw bytes, billing fields
and independently reconstructed normalized capture. Missing/duplicate returns,
unknown charges, unbound canonical IDs, changed source/runtime bytes, invented
metadata and symlink inputs stop preparation. Local completeness is **not** a
fresh database acknowledgment; live coordinator reconciliation is a future
execution precondition.

## Artist identity, not mere music association

The existing ownership policy, catalog evidence assembler and Topic policy are
reused unchanged. Original catalog observations remain contextual evidence, not
independent human adjudication. Search text, uploader names, co-credits, song-title
mentions, lyric uploaders, labels and related groups cannot establish ownership.
Direct-search observations remain direct-search observations; no uploader/video
evidence is synthesized.

Captured aliases are checked across every original alternative, including held
and deferred claims. New aliases do not erase shared identity conflicts. External
catalog/historical claims must still be checked under lock before any paid work.

Supported Topic associations are labeled **Topic — auto-generated** and remain
music-presence suggestions, never artist-owned links. A matching Topic name alone
remains unresolved. Policy-held pairs receive no model allocation; uncaptured
artists and alternative channels are deferred, not completed no-matches.
All links remain unapproved and ineligible for import. Ownership accuracy is
unmeasured; policy/model agreement would not measure it.

## Full-body size and spending approval

Full catalog evidence is not truncated or summarized to fit the legacy
6,000-byte transport. The new proposal measures every complete request body and
proposes the smallest byte ceiling covering them. Oversized legacy requests are
explicitly counted; existing byte allowances and sealed workers are unchanged.
This is a new proposed allowance, not permission to widen a live transport.

Each proposed model operation reserves two cents and preserves the original
capture allocation (including unresolved-URL allocation keys). This reservation
is **not a confirmed provider-enforced price ceiling** for larger requests.
Pricing must be confirmed and the full exact scope, byte ceiling and cost ceiling
explicitly approved before a separately sealed executor can dispatch anything.
The capture approval, unspent earlier allowances and older stopped stages confer
no model spending permission.

A future executor must reconcile all prior charges/acknowledgments, retain every
prior and uncertain allocation, and transactionally check independent
kind-scoped profile, Chartmetric artist and canonical channel exclusions across
runs. It must also recheck current eligibility/claims and the stopped parent
campaign. No retries, recaptures, replacement channels or catalog changes are
included. No coordinator records are installed/reset during preparation.

## Verification

```sh
node --test scripts/src/youtube-mixed-identity.test.mjs \
  scripts/src/youtube-ownership-policy.test.mjs \
  scripts/src/youtube-ownership-evidence.test.mjs \
  scripts/src/youtube-topic-links.test.mjs
```

The CLI fixture runs with inherited credentials removed and all provider/socket
access fenced off. Tests cover original packets, historical stopped stages,
direct provenance, Topic support versus name-only leads, group/label conflicts,
deferred alias conflicts, receipt/raw mutations, exact UTF-8 sizing, unapproved
links, independent non-replay identities and overwrite/execution rejection.
