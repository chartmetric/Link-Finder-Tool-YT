---
name: Cricket catalog identity
description: Source identity constraints for future cricketer discovery support.
---

Cricket uses separate Sportmonks tables, including `poc_new_verticals.cricketers_sportmonks` and `sportmonks_cricket_lineups`, keyed by provider player IDs.

**Why:** The user supplied this source-system distinction when asking about social-link discovery for cricketers.

**How to apply:** When adding cricket support, preserve provider-qualified player identity; do not treat a Sportmonks player ID as an existing general-catalog profile ID. Keep source tables read-only.

Single-profile discovery may start from text alone, such as “cricketer: virat kohli: instagram link.”

**Why:** The user explicitly requested text-based search after learning Sportmonks does not supply public reference-profile URLs.

**How to apply:** Treat this as permission for user-initiated single-profile text searches, not automatic name-only bulk jobs. Do not present a text description as a verified reference account or count discovery-only results as resolved platform coverage.
