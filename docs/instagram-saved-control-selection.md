# Saved comparison control diversity

`scripts/src/instagram-saved-fix-rerun.mjs` selects at most 20 distinct target
catalog profiles using the existing priority and saved-decision ranking. It
reserves that complete target set **before** choosing control accounts.

Controls must have readable, account-bound saved Instagram metadata. Selection
excludes overlaps with any target's profile ID, Chartmetric artist ID, catalog
account IDs, canonical catalog/reference URLs, normalized artist name or saved
Instagram URL. Other saved observations sharing target catalog identities are
also reserved. A saved direct or reciprocal catalog cross-link to any target
excludes that control account, including duplicate observations of that account.
These conservative exclusions are not ownership adjudications.

Eligible accounts are grouped by normalized Instagram profile URL, sorted
deterministically, and rotated without replacement before balanced reuse.
Duplicate archive rows, URL casing, host aliases and tracking parameters do not
increase distinct-account counts. Saved model verdicts do not supply ownership
labels for controls.

When controls are scarce, targets remain in the scope: accounts are reused only
after distinct eligible accounts have been used; if none is suitable, the target
has `control: null` and no control call is planned. No missing evidence is fetched.
The preparation return value, new prepared scope, manifest selection metadata
and any future run summary include `controlCoverage`:

- `targetArtists`, `assignedComparisons`, `unassignedTargets`;
- `distinctControlAccounts`, `reusedComparisons`, `distinctAccountShortfall`;
- planned `diversityStatus`, explicitly `insufficient_control_diversity` if
  distinct accounts cannot cover all targets;
- evaluated comparison, distinct account, distinct target and distinct pair
  counts, plus a separate `evaluatedDiversityStatus` so partial/stopped runs do
  not inherit planned coverage;
- gate-pass observations, **not** a false-positive rate.

## Offline exclusion breakdown

New preparation also returns `controlExclusions` and freezes it inside the new
`prepared-scope.json` (covered by its receipt). No paid run or collection is
needed to inspect it. `prepareSavedCaseSelection(pool, limit)` exposes the same
diagnostic for an in-memory saved pool; `selectSavedCases` retains its array
return value.

`accounts` contains one row per normalized saved Instagram account, including
eligible accounts, plus separate rows for observations without a valid account
URL. Each row includes:

- `eligible`, all applicable `exclusionReasons`, `assignedComparisons` and
  `duplicateObservations`;
- every source observation's `archive`, one-based `resultLine` in
  `results.jsonl`, zero-based `profileIndex` in the saved profiles array, catalog
  profile/artist IDs, artist name and original `savedUrl`;
- observation-level `reasons` and specific `metadataIssues` (for example a
  candidate URL not bound to the saved account or missing comparison metadata).
  Missing source coordinates in manually supplied pools remain `null`.

Reasons distinguish `unreadable_metadata`, `invalid_account_url`,
`target_account`, `target_catalog_identity_overlap`, `target_artist_name_overlap`
and `target_cross_link`. Reasons accumulate rather than stopping at the first
failure. Identity reservations include transitive aliases, as before.
`reasonCounts` counts account/report rows for each exclusion reason; **these
counts overlap and must not be summed**. `distinctSavedAccounts`,
`eligibleAccounts`, `excludedAccounts` and `invalidUrlObservations` keep valid
account counts separate from unidentifiable observations.

Repeated saved rows/URL aliases receive `duplicate_account_observation` at the
observation level; duplicates cannot increase diversity but do not by themselves
disqualify the account. An unreadable observation does not disqualify a readable
duplicate unless the existing identity, name or cross-link rules block the group.
Rows previously skipped because comparison metadata or a saved verification was
missing are retained in the report as `excludedBeforeSelection`, not introduced
into the target/control pool. Their diagnostics cannot relax or change selection.

These are **cross-artist synthetic challenges**, not independently
source-reviewed negative ownership labels. Distinct saved URLs do not establish
independent artists, current owners, or statistical independence. Ownership
labels remain unassigned, accuracy remains unscored, and no calibrated
false-positive rate is reported. Accuracy scoring must follow the separately
approved benchmark policy using independently source-reviewed evidence.

Existing frozen inputs, prepared scopes, receipts and results are not rewritten.
The pure `summarizeSavedControls(cases, results)` helper can describe a legacy
scope's reuse without changing it. New preparation uses exclusive output
creation. This change is not authorization for another paid run, new collection,
threshold changes, imports, claims or catalog writes.

## Offline regression fixtures

```sh
node --test scripts/src/instagram-saved-fix-rerun.test.mjs
```

The fixtures forbid network access and cover deterministic rotation, global
identity and cross-link exclusions, URL/observation deduplication, scarce and
absent controls, legacy reused controls, evaluated versus planned counts,
overlapping exclusion reasons and archive coordinates, unreadable ingestion rows,
exclusive preparation and byte-for-byte preservation of frozen source files.

## Read-only cross-run comparison report

Compare one or more saved run directories without rerunning preparation or
evaluation:

```sh
node scripts/src/instagram-saved-control-report.mjs \
  path/to/first-run path/to/second-run \
  --output generated-artifacts/new-control-overlap-report
node --test scripts/src/instagram-saved-control-report.test.mjs
```

Each input directory must contain `prepared-scope.json` with a `cases` array.
`summary.json` with a `results` array is optional: a missing summary is reported
as unavailable evaluated evidence, **not** proof that no calls occurred. Invalid
JSON, missing identities and invalid control-account URLs fail explicitly.
Legacy scopes need not contain `controlCoverage`; the report derives counts
from the saved rows, never from potentially stale aggregate fields.

Without `--output`, JSON is printed to stdout. With it, `report.json` and
`report.md` are created exclusively in a **new** directory outside all input
archives. The output's parent must already exist. No frozen archive file is
written, including receipts, scopes and summaries. SHA-256 fingerprints of the
exact input bytes are recorded. Duplicate input paths (including symlinks) are
rejected; copied runs may be compared, but their shared accounts and pairs still
count only once in the combined union.

Counting rules:

- A target is a trimmed catalog `profile_id` (numeric and string forms agree),
  not a display name, Chartmetric ID or the control source's catalog profile.
- An account is the same normalized Instagram URL used by saved-control
  selection: lowercase handle, canonical host and trailing slash, ignoring
  tracking queries and fragments. A URL is not proof of stable current ownership.
- A pair is a target ID plus normalized control-account URL. Duplicate rows
  remain comparison **occurrences** but cannot increase distinct counts.
- Planned controls come only from non-null `cases[].control`; all scope targets,
  unassigned case occurrences and targets without any planned control remain visible.
- Evaluated controls come only from `summary.results` with `variant: "control"`
  and `status: "evaluated"`. Candidate results, held requests and unresolved calls
  do not count as evaluated controls. Saved control statuses are shown separately.
  An evaluated pair missing from the saved plan is retained and flagged, not
  silently matched to another control. Gate passes are observation counts only.
- Per-run and combined totals distinguish occurrences, distinct targets,
  accounts and pairs. Combined totals are set unions, not sums of per-run
  distinct totals. Pairwise overlaps and account/pair run membership expose
  reuse even when targets or assignment patterns differ. Planned and evaluated
  overlap are never mixed.

All report counts describe **synthetic challenges**. Source ownership labels
and model verdicts are not imported as ground truth. There is no accuracy or
false-positive scoring, provider access, catalog write, policy change or paid
run authorization. Distinct accounts and repeated runs do not establish
independent ownership evidence or independent statistical coverage.
