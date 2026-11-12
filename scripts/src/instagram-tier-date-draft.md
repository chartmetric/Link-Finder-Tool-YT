# Offline tier-date proposal — not activated

The campaign currently restricts global tier records to the single newest
computation timestamp. A per-artist latest assignment can be valid even when
another artist has a newer computation date.

The draft query retrieves the latest available global musician assignment for
each selected ID. It does not discard demotions before selecting the latest row.
The pure evaluator requires an explicit UTC clock and age limit. The proposed
ceiling is 36 hours, not an assertion that this is an already approved per-artist
campaign policy. Missing, stale, future and malformed records remain held.

## Boundaries

- No worker imports this module. No database or provider calls occur on import.
- No changes to sealed runtimes, approvals, queues, results or deferrals.
- `tierCheckPassed` is only a tier check, not full eligibility or paid admission.
- A future integration must separately recheck current active profile identity,
  the absence of a catalog Instagram link, and all prior-paid/uncertain-request
  fences. Preserve the fixed campaign denominator and strict tier order.
- A frozen starting tier is not a fallback for absent or stale current records.
- Get explicit approval for the freshness policy and separately for any restart.
  Do not silently extend the 36-hour ceiling to process the investigated cohort.

## Verification

Run `node --test scripts/src/instagram-tier-date-draft.test.mjs`.
An offline replay of the retained 9,404 records at the investigation timestamp
should hold all of them as stale. Preparation does not make them freshly eligible.
