# Continuous Tier 1–5 YouTube sourcing

This is the separately approved, uncapped YouTube campaign. It does not modify
Instagram execution, funding or catalog links. Results are review suggestions.

## Scope and authorization

Explicit operator preparation freezes the current global Tier 1–5 musicians
missing a connected, non-empty catalog YouTube account URL. Saved candidates and
catalog Instagram links do not exclude an artist. Both platforms have their own
denominators; never sum them as a unique artist count.

The initial query is not limited to a sample. Workers process small internal
chunks automatically until the frozen queue is exhausted or a safety stop is
required. The queue denominator remains fixed. Before each chunk, the worker
rechecks current catalog identity, global tier eligibility and missing YouTube
URL. Ineligible identities are deferred, not counted as searched.

The initial 20-artist test's paid attempts are held as historical references
rather than automatically recharged. These deferrals remain visible and are not
invented rejections, no-matches or completed searches in the new campaign.

## Explicit preparation and launch

Only after the user approves this platform and spending scope:

```
node scripts/src/run-youtube-campaign.mjs --prepare-approved
node scripts/src/seal-youtube-campaign-runtime.mjs --seal-prepared
node generated-artifacts/full-tiers-1-5-no-youtube-uncapped/runtime/run-youtube-campaign.mjs --run-approved --uncapped-approved
```

The first command performs read-only catalog selection and explicit development
coordinator setup; it has no provider dispatch. The second seals the exact local
dependency graph and changes fingerprints only while the coordinator is still
prepared, has reserved zero funds and has no admissions. Runtime isolation
prevents other app/task merges from altering an active campaign.

These are not deployment migrations or application startup commands. Do not run
them again to recover a stopped campaign. Launch atomically requires `prepared`;
a second worker cannot replace the owner or reset charges.

## Evidence and spending

- Preserve full artist context, search evidence, raw channel receipts and exact
  model inputs. Search snippets are never channel biographies.
- Search uses the existing YouTube query wording. Channel captures and exact
  identity judgments reuse the shared YouTube ownership policy.
- Topic, fan, organization and reused channels remain distinct from artist-owned
  accounts. A bound `likely` result has no arbitrary 0.9 cutoff.
- Request bounds are 64 KB for complete model inputs and 2 MB for responses.
  Larger model inputs are held explicitly, never silently truncated.
- New admissions reserve two cents conservatively. Reported model cost must be
  at most that amount. Reservations are not invoices.
- No total cap is represented by a deliberately null cap in a separately bound
  authorization, not an arbitrarily increased numeric ceiling.
- Transactions serialize admissions, enforce owner/scope/approval, and reject
  every new dispatch while an earlier outcome is uncertain. Unique operation
  keys are never removed or reused.
- Receipts are saved before marking a request returned. A 120-second deadline
  retains uncertain charges and stops the worker without replay. Funding,
  authentication, rate limiting, protocol errors and server failures stop too.
- New cross-artist channel reuse holds earlier positive summaries as well as the
  later artist. Original evidence stays immutable; any future export must also
  apply current coordinator conflict holds, not blindly trust an old positive.

## Read-only publication

```
pnpm --filter @workspace/api-server run youtube:publish-campaign \
  --publish --run-id=full-tiers-1-5-no-youtube-uncapped --watch
```

This separate observer reads the coordinator in a consistent read-only
transaction, reconciles reservation totals, validates committed result hashes,
and mirrors immutable evidence and a counter-only progress snapshot to App
Storage. It never imports the paid worker or admits/retries work.

Only committed returned receipts and completed results are eligible for
archival; a newly visible file might still be being written. Evidence objects
are generation-fenced and content-hashed. The API prefers this campaign's
snapshot over the original test, which remains separately preserved.

Progress and success are different: processed artists include completed
no-channel searches; success is likely artists divided by artists with at least
one ownership assessment. Held metadata, deferred identities and provider
failures are not account absence or ordinary rejections.
