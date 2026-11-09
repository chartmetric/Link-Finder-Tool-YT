# Bounded research-only bulk workflow

The user authorized one automatically selected cohort of up to 50 musicians
across global Tiers 1–5, five workers and a maximum additional $5 reservation
within the original $10 pilot ceiling. This is not a full-tier rerun, a new
acceptance-policy activation, an ownership accuracy benchmark or an import.

`instagram-bulk-shadow-live.mjs --prepare` freezes the current global tier
snapshot, up to ten profiles per tier in deterministic profile-hash order,
active linked Spotify references, catalog/lookup identities and historical
reservation reconciliation. There are no named-artist exceptions. Profiles
with catalog Instagram links, uncertain prior discovery or prior paid pilot
admissions are excluded. A missing quota is reported rather than filled by
hand. Current legacy research candidates may be refreshed under this explicit
new batch authorization; uncertain paid attempts are not automatically replayed.

The live entry is separate from the older artist-specific regression pilot.
It uses the existing shared worker, provider transport, Serper discovery,
music-evidence resolution and unchanged artist-identity gate. No regression
holdout answers enter discovery and no synthetic source trust is created.

Before dispatch, all historical paid admission reservations are counted,
including failed/uncertain requests and older journal identity formats. A
local exclusive budget fence prevents two instances of this launcher.
Every dispatch also checks for changed reservations in other archived
experiments. This does not claim that unmodified legacy tools honor the fence;
they must not be launched concurrently. A later common ledger migration must
include this run's admissions and any unresolved requests.

The approved manifest is frozen by receipt. No automatic retry/resume is
supported; an existing output directory, admission journal or budget fence
blocks another launch. Provider credit/authentication failure, uncertain
timeout, dollar cap or result persistence failure stops further admissions.

Results and original provider packets are saved under
`generated-artifacts/instagram-bulk-shadow-2026-11-09-approved-50`.
`instagram-bulk-shadow-report.mjs <run-dir>` produces research-only artist and
candidate CSVs. Raw candidates, supported research links, unresolved results,
completed no-candidate searches and failures remain distinct.

Nothing writes ClickHouse, claims or live links. Any eventual ingestion must
use `account_links/claims.record` and resolve. A completed workflow does not
pass a known-answer quality gate or authorize a full rerun.

## Completed authorized cohort

The automatically selected cohort contained 49 profiles: nine Tier 1 and ten
each in Tiers 2–5. Historical paid reservations reconciled to $3.99 before
launch. All 49 completed Serper discovery, with 91 candidate inspections and
193 paid requests admitted. New conservative reservations were $3.33, cumulative
original-pilot reservations $7.32, leaving $2.68. There was no global stop.

Every profile had raw candidates, but no candidate passed the unchanged supported
research gate. Of 84 available candidate identity assessments, JEV returned
20 likely, 40 uncertain and 24 mismatch verdicts, with no verified verdict.
Seven inspected candidates lacked readable identity metadata. These are model
and workflow outcomes, not independent ownership truth labels.

Only nine readable candidates had an exact catalog-reference connection under
the existing comparison. Across all 91 inspections, the gate reported:
34 missing exact links, 24 model mismatches, 19 name/identity-evidence rejections,
eight inconclusive verifications despite a cross-link, five unbound metadata
holds and one related-entity hold. These reasons describe gate behavior rather
than proven attribution errors. No artist-specific follow-up was performed.

`workflow-report.json` explicitly records no quality benchmark evaluation and
no full-rerun readiness. The core worker's empty-regression-stage completion
flag is operational only and must never be read as passing ownership tests.
Original requests/responses remain available to diagnose common evidence gaps
and re-evaluate policies offline without repeating Serper discovery. Artist
and candidate CSVs are labeled non-importable research, not verified link exports.
