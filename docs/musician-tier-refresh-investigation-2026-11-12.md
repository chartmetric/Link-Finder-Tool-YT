# Why older musician tiers were not refreshed

## Conclusion

**The November 11 database refresh completed its selected set; it did not stop
partway through writing that set. However, the available evidence does not
establish whether excluding older artists was intentional or an upstream
selection/producer defect.**

The strongest supported explanation is a **source/mapping selection gap followed
by selective overwrites**, not a demonstrated failed tier-table write. Older rows
remain because the table retains assignments per artist rather than replacing the
entire global population at each computation time.

Do **not** classify the 9,404 artists as demoted, deleted, or currently eligible
from their old assignments. No campaign policy was changed.

## Scope and evidence

Investigated November 12, 2026 UTC, starting at 00:35:13. The job-evidence window
was November 9–11 UTC; source-state reads were made later in this investigation.
This was a read-only audit of existing catalog data and the connected ClickHouse
account. There were **zero paid searches, database changes, campaign starts or
restarts**. Local evidence/report files were created.

Baseline:
`generated-artifacts/instagram-tier-gap-investigation-2026-11-11/final-summary.json`.
That saved audit established that all 9,404 affected profiles retained November
10 01:30:15 UTC assignments: Tier 2: 61; Tier 3: 548; Tier 4: 5; Tier 5: 8,790.
These are retained assignments, not authoritative current eligibility.

New evidence:
`generated-artifacts/musician-tier-refresh-audit-2026-11-12/`.
The evidence bundle includes exact SELECT statements, responses, errors, scoped
numeric cohort identifiers, an integrity manifest, and the offline verification
summary. Large evidence files remain outside Git.

## 1. The date split is real, but it is not a complete-snapshot marker

An independent `FINAL` read confirmed:

| Retained computation time, UTC | Distinct musician profiles |
|---|---:|
| November 11, 01:30:22 | 151,383 |
| November 10, 01:30:15 | 13,881 |
| November 9, 01:30:12 | 5,359 |

Additional older dates are retained too. These are current retained-row counts,
**not** original job input counts or daily historical population totals.

The assignment table is a `SharedReplacingMergeTree`, keyed by
`(profile_type, grain, profile)`, with no date partition. `computed_at` is not a
snapshot identity in its replacement key. An overwrite refreshes selected
profiles while profiles without a replacement can keep their older assignments.
`FINAL` does not recover a complete history of overwritten versions.

Evidence: `global_tier_dates-rows.json`, `tier_shape-rows.json`,
`tier_columns-rows.json`.

## 2. Producer-facing database logs show successful selected-set writes

The musician/global tier configuration describes the tiers as mirrored from
`chartmetric_analytics.prioritised_artist_track_tier_cache`, with Tier 1 highest
priority and ranking by `final_artist_score`.

Actual query logs identify the immediate input as
`synced.prioritised_artist_track_tier_cache`. The observed selection:

- Groups eligible source rows by `cm_artist`, using a tier-range predicate.
- Maps those IDs through active profiles of a specified profile type with a
  non-null `cm_source_id`.
- Writes assignments in Native-format batches.

The source SQL was normalized before retrieval, so literal predicate values are
redacted. The explicit 1–5 cohort queries below are separate audit queries, not
an assertion that redacted log literals were recovered.

| Mirror run date, UTC | Source artist selection rows | Mapped profile selection rows | Successful write batches | Written rows |
|---|---:|---:|---:|---:|
| November 10 | 157,346 | 154,039 | 31 | 154,039 |
| November 11 | 157,598 | 151,383 | 31 | 151,383 |

On November 11 the two selections finished at 01:30:24 and 01:30:26.
The 31 writes finished between 01:30:27 and 01:30:35: thirty batches of 5,000
and one of 1,383. All returned `QueryFinish`, with exception code zero.
The 151,383 written rows also match the retained November 11 global musician
assignment count.

This is strong evidence against an interrupted/truncated database write of the
selected population. It is **not** a job-owner attestation that the selected
population was the correct or complete intended population. Native insert
payloads and the historical selected-ID list are not contained in these logs.

Important access distinction: the application's catalog reader could not read
`system.query_log` (ClickHouse code 497). The already-connected ClickHouse
account could read it. Query logs are replica-local; inspecting only one replica
initially omitted relevant runs. The decisive evidence used
`clusterAllReplicas('default', system.query_log)` after discovering the cluster's
name and two-replica topology. No application permission was changed.

Evidence: `global_tier_config-rows.json`,
`vert-all-replica-tier-refresh-io.json`,
`vert-all-replica-refresh-totals.json`, `vert-cluster-names.json`,
`query_log_probe-error.json`.

## 3. Source membership changes are observable, but not their intent

All 9,404 saved profile IDs still resolve to active, non-deleted musician
profiles in the current catalog. This does not reconstruct their mapping at
the historical run time.

The upstream tier-history table contains the following membership for the
9,404 saved `cm_artist` identities:

| Source snapshot label, UTC | Present artists | With any Tier 1–5 source row | Present but no Tier 1–5 row | Absent from source snapshot |
|---|---:|---:|---:|---:|
| November 9, 00:00:00 | 9,325 | 9,230 | 95 | 79 |
| November 10, 00:00:00 | 2,316 | 78 | 2,238 | 7,088 |
| November 11, 00:00:00 | 2,706 | 1,128 | 1,578 | 6,698 |

Counts use **any qualifying row**, not a misleading assumption that an artist's
minimum tier alone determines whether the range filter matches.

At investigation time, the immediate synced source had one retained
`synced_at` value, November 11 22:00:14 UTC. For the cohort it contained:

- **6,702** artists absent entirely.
- **1,550** artists present but with no Tier 1–5 row.
- **1,152** artists with a Tier 1–5 row.

Thus a substantial source-membership change is directly observable, independently
of older destination assignments. But neither the upstream midnight snapshot
labels nor the later 22:00 synced snapshot can be assumed to equal the exact
source input read by the 01:30 mirror. In particular, the 1,152 later qualifying
artists cannot be declared historically selected, currently campaign-eligible,
or safe to resume automatically.

Evidence: `deferred-source-selection-history.json`,
`deferred-current-source-selection.json`, `vert-sync-snapshots.json`,
`deferred-profile-state.json`.

## 4. Other job records do not establish the cause

- No tier-related scheduled job definition matched the inspected name,
  question, or execution-plan fields.
- No ingestion jobs appeared in the November 9–11 window, nor any historical
  ingestion job with `tier` in its job type.
- The inspected window had 53 successful and two failed scheduled-job runs,
  **without a demonstrated connection to the musician tier producer**.
  Those two failures are not evidence that this refresh failed.
- `refresh_log` contained four `profile_tier/newcomer` runs. Their sampled
  reasons concern football/basketball placement, not this musician/global
  mirror. Their success cannot establish musician-refresh success or intent.
- Synced-source logs show successful staging writes and table exchanges.
  A table-name inventory found only the current synced tier-cache table, not
  a retained historical staging table for reconstructing the 01:30 input.

Evidence: `scheduled_tier_jobs-rows.json`,
`scheduled_runs_inventory-rows.json`, `ingestion_job_types-rows.json`,
`tier_ingestion_history-rows.json`, `vert-tier-run-summary.json`,
`vert-sync-write-patterns.json`, `vert-retained-sync-table-inventory.json`.

The preliminary broad text search in `tier_refresh_log_matches-rows.json`
returned unrelated link logs containing the word “tier”; it was limited to 60
rows and is **not** used to assert absence of musician producer events.
The decisive narrower tier-entity summary is separately identified above.

## What remains unavailable

This workspace and connection do not provide a verified producer/orchestrator
run manifest, its declared full-versus-partial refresh contract, the intended
artist universe, per-artist exclusion reasons, or the code/configuration revision
that generated the changed source population.

We also do not have a preserved, version-bound copy of the exact synced input
and profile mapping read at 01:30 on November 11. Upstream history rows are
available, but their midnight labels alone do not establish that binding.
The application repository contains tier consumers; the upstream producer's
selection policy was not found here.

Therefore:

| Explanation | Finding |
|---|---|
| Database writer crashed before finishing its selected set | Not supported: selected and written counts reconcile, with successful completions. |
| Refresh overwrote a selected subset and left older assignments untouched | Supported by selection/write logs and the retained-row storage shape. |
| That subset was intentionally the complete approved scope | Unproven: no producer contract or exclusion manifest. |
| An upstream computation, ingestion, mapping, or selection defect omitted artists | Still possible; cannot be distinguished from intentional source changes with the available evidence. |
| The 9,404 artists were demoted | Not established; neither old assignments nor source absence proves demotion. |

## Evidence needed to close the remaining question

Request a **read-only export**, not a rerun, from the upstream owner:

1. The November 10–11 producer/orchestrator run records, completion/error
   status, deployed selection policy, and declared refresh scope.
2. The exact source version consumed at November 11 01:30 UTC and the
   corresponding profile-ID-to-artist-ID mapping.
3. The expected, selected, written, intentionally excluded, and failed artist
   counts, with exclusion reasons for the 9,404 saved identities.

An intentional partial refresh requires an explicit scope and matching
exclusions. A producer failure requires evidence of an unmet declared scope,
an error, or missing expected output. The current records establish neither
intention nor such a failure. Keep the artists deferred and preserve existing
freshness/eligibility rules unless a separate policy change is approved.

## Reproducibility and validation

The initial catalog probes can be repeated against a **new** output directory:

```sh
node scripts/src/investigate-musician-tier-refresh.mjs generated-artifacts/NEW-AUDIT
node scripts/src/investigate-musician-tier-refresh.mjs generated-artifacts/NEW-AUDIT producer
node scripts/src/investigate-musician-tier-refresh.mjs generated-artifacts/NEW-AUDIT jobs
```

The script has a fixed historical job window; new observations must not be
presented as if they were captured on the original audit date. It accepts SELECT
only through the existing read-only transport and does not import paid workers.
Files use exclusive creation to avoid silently overwriting previous evidence.

The broader connected-account queries and their responses are archived in the
evidence JSON files; they require that account's read access, not relaxed
application permissions. SQL text from observed jobs is normalized to redact
literal values. Recorded failures and the oversized initial query response are
preserved rather than represented as empty results.

Offline checks reconcile the 9,404 saved identities, selected/written counts,
batch totals, exception codes, source-membership buckets, and artifact hashes.
No application code, campaign worker, or user interface was modified; no app
restart or browser test was needed.
