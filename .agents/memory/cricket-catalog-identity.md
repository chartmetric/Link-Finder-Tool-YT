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
