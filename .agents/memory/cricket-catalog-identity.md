---
name: Cricket catalog identity
description: Source identity constraints for future cricketer discovery support.
---

Cricket uses separate Sportmonks tables, including `poc_new_verticals.cricketers_sportmonks` and `sportmonks_cricket_lineups`, keyed by provider player IDs.

**Why:** The user supplied this source-system distinction when asking about social-link discovery for cricketers.

**How to apply:** When adding cricket support, preserve provider-qualified player identity; do not treat a Sportmonks player ID as an existing general-catalog profile ID. Keep source tables read-only.
