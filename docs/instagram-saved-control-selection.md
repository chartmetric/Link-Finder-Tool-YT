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
exclusive preparation and byte-for-byte preservation of frozen source files.
