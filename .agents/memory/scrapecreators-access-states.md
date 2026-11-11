---
name: ScrapeCreators access states
description: Instagram profile response-contract changes and limits on interpreting historical errors.
---

Do not assume every Instagram Profile API HTTP 403/404 is a transient scraping failure or an exhausted-credit response.

**Why:** ScrapeCreators' introduction documentation describes October 2026 recovery changes: confirmed age gates can return HTTP 403, and restricted/unavailable pages can return HTTP 404. Its October 19 correction makes confirmed states use `success: true` while retaining the non-2xx HTTP status. Actual scraping failures use `success: false`. Generic historical error messages without response bodies cannot distinguish these cases.

**How to apply:** Recheck the live provider contract before changing handling. Distinguish confirmed access restrictions, unavailable pages, and actual provider failures using documented body fields. An access restriction is not evidence that no account exists, nor permission to bypass the user's stop-on-unavailable-metadata rule. Do not infer that retrying every 403/404 will recover it.

Skip confirmed restricted starting profiles and continue the batch; do not retry them on Resume or attempt to bypass the restriction.

**Why:** The user relayed the founder's confirmation that restricted profiles caused these responses and asked to pass those profiles.

**How to apply:** Treat the individual profile as skipped, with downstream platforms unsearched and uncovered, rather than successful, absent, or a provider failure. Only explicit restriction evidence qualifies; historical bare HTTP codes cannot be safely reclassified. Other metadata failures still stop that profile's investigation.

Source: https://docs.scrapecreators.com/ — introduction and October 18–19, 2026 contract notes.

Confirmed restrictions also occur as HTTP 404 with `success: true`,
`error: "not_found"`, `errorStatus: 404`, and `message: "Profile is restricted"`.
Require the returned handle to match the requested account before treating this
as an individual skip.

**Why:** This exact archived response stopped a continuous campaign despite
confirming an account restriction rather than a provider-wide failure.

**How to apply:** Retain the receipt and reservation, skip without retry or
claiming account absence, and let untouched artists continue. Funding and rate-limit
checks must run first; a generic 404 or mismatched handle is not sufficient.

In a saved-candidate verification job, inspect retained profile fields even when
the response flags private content as unavailable.

**Why:** A completed response was HTTP 200 with `success: true`, an error flag
and “Profile is private”, while also containing a username-bound display name
and biography. The error flag alone did not mean that all profile metadata was
unavailable.

**How to apply:** Reuse only the actual, request-bound metadata already returned;
do not refetch the account or attempt private-content access. Preserve the access
restriction and incomplete-link uncertainty. This does not override the separate
rule to skip restricted starting profiles in full investigations.
