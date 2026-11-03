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
