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
