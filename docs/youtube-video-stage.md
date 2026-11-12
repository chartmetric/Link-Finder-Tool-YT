# Prepared saved-video YouTube recovery test

This is a separate, workspace-only test. It never resumes the full campaign,
reuses a completed run's approval, or writes catalog links.

## Scope and approval stages

1. Select exactly 20 currently eligible Tier 1–5 artists from the completed
   100-artist test who had no captured candidate channel. Reuse their acknowledged
   saved search receipts and catalog context. Sort by current tier, then original
   campaign order; do not select by an ownership answer or a known correct link.
2. Freeze up to two eligible video URLs per artist, the exact uploader requests,
   evidence bytes, source plan, and executable modules. Preparation performs
   catalog/coordinator reads but **no paid requests and no persistent database
   writes**.
3. Ask for a new exact-plan approval covering **only those video-uploader
   requests**. Forty requests reserve at most **80 cents** (two cents each).
   Unused slots cannot become searches, channel captures, model calls, or retries.
4. Once approved, resolve uploaders, retain original response bytes, and report
   the discovered channels as **discovery clues**, not accepted ownership.
5. Prepare exact channel and identity-check requests from those returned results
   and ask for **separate approval**. They are unknown during initial preparation
   and are deliberately not authorized by stage 1.

This is a targeted recovery sample, **not an estimate of all-artist success**.
It includes Topic leads with clear labels, but a name containing “Topic” is not
itself a confirmed channel-type capture or an exact artist association. Shared
channels are flagged. All uploader alternatives remain in the findings. A later
one-channel capture allowance has less breadth than the previous two-channel
test; disclose the exact selection policy and deferred alternatives before
approving that later stage.

## Safety checks

- The full YouTube campaign must remain stopped, and no other bounded test or
  uncertain paid admission may be active.
- Recheck active catalog identities, global tiers, fresh snapshots, and absence
  of catalog YouTube links before execution.
- Require a matching plan hash, exact cap, approval, and sealed runtime.
- Reserve the exact request in a locked PostgreSQL transaction before dispatch.
- Fence every reservation and receipt acknowledgment by owner, run, approval,
  artist, video, request, and remaining budget.
- Enforce global artist/video uniqueness across these stages: no automatic replay.
- Save and sync original response bytes and mapped evidence before acknowledging
  a return. An interrupted or malformed response blocks further dispatch.
- Stop on timeouts, HTTP failures, unexpected schemas, conflicting uploader IDs,
  changed evidence/runtime, or unknown/increased provider credits.
- No transcript calls, redirects, related-video traversal, provider fallbacks,
  purchases, catalog writes, or automatic resumption.

The live stage creates its isolated coordinator tables only after approval.
It is rejected in deployment environments and is not imported by the web app.

## Provider contract checked on November 12, 2026

- Endpoint: `GET https://api.scrapecreators.com/v1/youtube/video?url=...`
- Documentation: https://docs.scrapecreators.com/v1/youtube/video
- One credit per request; mapping requires `success:true`, the exact video ID,
  a valid `channel.id`, consistent optional uploader/owner IDs, and a known
  `credits_charged` of zero or one.
- Public pricing: https://scrapecreators.com/#pricing — $47 / 25,000 credits
  (0.188 cents/credit) and $497 / 500,000 credits.
- Two cents per request is a conservative reservation, not a billed-cost claim.
  No credit top-up or purchase is authorized.

## Commands

From the workspace root:

```sh
node scripts/src/run-youtube-video-stage.mjs --prepare-only --id=youtube-video-review-NEW-ID
node --test scripts/src/youtube-video-stage.test.mjs
node scripts/src/check-youtube-video-stage-postgres.mjs --temporary-tables-only
```

The last command verifies transaction/owner/non-replay behavior with **only
connection-local temporary tables**. It performs no provider requests, creates
no persistent coordinator schema, and closes the connection afterward.

After explicit user approval, use only the prepared runtime:

```sh
node generated-artifacts/RUN-ID/runtime/run-youtube-video-stage.mjs \
  --authorize-prepared --id=RUN-ID --plan-sha256=EXACT-HASH --approve-cents=EXACT-CAP
node generated-artifacts/RUN-ID/runtime/run-youtube-video-stage.mjs \
  --run-approved --id=RUN-ID
```

Preparation does not authorize either command. Never edit a sealed runtime or
pending plan; prepare a new ID if the scope or implementation changes.
