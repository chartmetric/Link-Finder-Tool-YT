# Instagram provider capture diagnostics

The starting evidence is the read-only audit in
`generated-artifacts/latest-250-candidate-audit-reviewed/`: 144 readable
candidate occurrences without captured links and 40 failed metadata lookups.
Neither count proves that Instagram has no website link. Screenshots may show
links that the provider omitted even when its response contains empty fields.

New candidate normalization records `linkCapture`:

- `explicit_empty`: the provider explicitly returned an empty `bio_links` list
  and an empty/null `external_url`, with no rejected entries.
- `links_captured`: both fields have the expected types and at least one usable
  link was retained. This is not a guarantee that every visible link was captured.
- `incomplete_fields`: a field is missing, malformed, or a link was unusable.
  Usable links from a partial response are still retained.
- `restricted_response`, `error_response`, `identity_conflict`: resource
  restrictions, provider/network/billing failures, or missing/conflicting
  response identity. These never establish account or link absence.
- `unknown_legacy_capture`: no capture diagnostic was saved. A historical
  normalized empty array must not be relabeled an explicit provider empty.

`linkResolution` is separate: `capped`, `error_response`,
`checked_unresolved`, `exact_catalog_music_identity`, or `not_attempted`.
An exhausted public-page allowance must not look like a completed empty path.
All diagnostics retain the candidate source URL. `absenceConfirmed` is always
false; even an explicit empty is a provider observation, not Instagram truth.

The runner preserves diagnostics through verifier holds and metadata failures.
New JSON/CSV workflow, candidate, final-outcome and saved-audit exports expose
them. Unsupported results with known incomplete capture/resolution are reported
as incomplete, not completed no-link outcomes. Existing supported links still
require the unchanged independent evidence and numeric/verdict gates.
Legacy archives are not rewritten; export commands retain exclusive creation.

No fallback fetch, retry, new provider, ownership rule or spending allowance is
introduced. A future capture fallback requires its own explicit budget
authorization and candidate/source binding. The existing bounded music-page
resolver is not a capture fallback, nor is official-site ownership verification.

Offline verification:

```
node --test scripts/src/instagram-link-capture.test.mjs \
  scripts/src/instagram-pilot-live.test.mjs \
  scripts/src/instagram-pilot-runner.test.mjs \
  scripts/src/instagram-bulk-shadow-report.test.mjs \
  scripts/src/instagram-saved-candidate-audit.test.mjs \
  scripts/src/public-music-links.test.mjs
```

Fixtures are generic, synthetic provider shapes informed by the saved audit;
they do not assert ownership, screenshot contents, or improved live model scores.
