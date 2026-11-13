# Fresh 20-artist staged YouTube test

This test uses 20 currently eligible Tier 1–5 catalog artists without catalog
YouTube links. Selection follows tier/queue order and excludes previous YouTube
campaign, bounded-test and uploader admissions, as well as saved test results.
Preparation reads catalog/coordinator data but never calls paid providers or
changes catalog links.

## Approval stages

1. **Search:** exactly one frozen search request per artist, 20 calls maximum,
   reserving 40 cents. Keep direct channel leads and all saved video evidence.
   Plan at most two relevant video uploader leads per artist, retaining a
   distribution/Topic clue within that limit when available.
2. **Uploader resolution:** after search returns, prepare exact saved-video
   requests. Up to 40 calls / 80 cents, with a separate exact-plan approval.
   Existing direct channel leads do not need a video request.
3. **Channel capture:** prepare exact discovered channel requests after uploader
   resolution. Proposed ceiling is two distinct channels per artist, up to
   40 calls / 80 cents. Selection/deferred alternatives must be disclosed in the
   later plan; this search approval does not authorize a selection policy.
4. **Identity:** prepare exact requests from returned channel evidence, up to
   40 calls / 80 cents, under another approval. Topic channels need supported
   artist association and remain clearly separate from artist-managed channels.

The conservative proposed ceiling across all four stages is **$2.80**, not a
funded shared budget and not spending authority. Only the **40-cent search
stage** can be approved from the initial plan. Later limits are planning bounds,
not permission to dispatch unknown requests or transfer unused allocations.
No link is accepted from a search result, matching name or video uploader alone.
Failures and uncertain admissions stop work without automatic retries.

## Commands

Collect the read-only catalog context using a fresh unapproved bounded-test
preparation, then create the separate search-only plan:

```sh
node scripts/src/run-youtube-bounded-test.mjs --prepare-only \
  --test-id=youtube-test-20-staged-catalog-2026-11-13 --artists=20
node scripts/src/run-youtube-staged-search.mjs --prepare-only \
  --id=youtube-test-20-staged-2026-11-13
```

Do not authorize the catalog-preparation archive's legacy direct-only runner.
The staged archive has its own plan, frozen runtime, 20 exact searches and
40-cent cap. Only after explicit approval, use that archive's sealed
`runtime/run-youtube-staged-search.mjs` with `--authorize-prepared`, its exact
`--plan-sha256`, `--approve-cents=40`, and the same `--id`; execute using
`--run-approved` only after that authorization.

The runner rechecks current eligibility and all existing attempt histories
before launching, claims the cohort transactionally, and binds each admission
to a frozen exact search request. Full campaigns remain paused. Source catalog
context and raw search receipts are retained for later exact-plan preparation.
