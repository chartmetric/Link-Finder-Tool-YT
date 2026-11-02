---
name: Cricket catalog identity
description: Source identity constraints for future cricketer discovery support.
---

Cricket uses separate Sportmonks tables, including `poc_new_verticals.cricketers_sportmonks` and `sportmonks_cricket_lineups`, keyed by provider player IDs.

**Why:** The user supplied this source-system distinction when asking about social-link discovery for cricketers.

**How to apply:** When adding cricket support, preserve provider-qualified player identity; do not treat a Sportmonks player ID as an existing general-catalog profile ID. Keep source tables read-only.

Single-profile discovery may start from text alone, such as “cricketer: virat kohli: instagram link.”

**Why:** The user explicitly requested text-based search after learning Sportmonks does not supply public reference-profile URLs.

**How to apply:** Do not present a text description as a verified reference account or count discovery-only results as resolved platform coverage.

User-initiated cricketer batches may search from names and country/team context without an existing profile link.

**Why:** After the text-search pilot, the user explicitly requested scaling discovery to a selected batch of 1,000 cricketers.

**How to apply:** This is a cricket-specific exception to linked-only catalog discovery, not permission to broaden brand/creator/artist bulk eligibility. Keep results unverified, retain provider-qualified player IDs, and never automatically replay uncertain paid calls.

The desired cricket coverage includes the “Top 16 countries” and both “current (latest)” and “the greatest cricketers.”

**Why:** The user stated this coverage goal when authorizing the second batch.

**How to apply:** Do not equate imported lineup frequency with a complete current-and-historical shortlist. Resolve the country/ranking scope before claiming top-16 coverage, and assess historical greats separately from recent activity.

Famous retired-player names can match younger Sportmonks namesakes even when the country matches.

**Why:** Comparing ICC Hall of Fame careers against catalog birth years exposed incompatible matches during the historical-player audit.

**How to apply:** Do not join historical lists by name and country alone. Check career-era compatibility or another independent biographical identifier; hold ambiguous identities for review rather than spending on the wrong athlete.
