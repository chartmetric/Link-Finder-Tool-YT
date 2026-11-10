# Offline trusted-source policy harness and proposed validation criteria

## Scope and status

User authorization covers **offline implementation and validation preparation only**.
No production gate, coverage, saved result, export, claims submission or provider
configuration is changed. No network, credential access, paid call or import is
part of the harness. This is not permission for a pilot or full rerun.

Run the synthetic contract tests:

```sh
node --test scripts/src/instagram-source-policy-offline.test.mjs
```

The isolated module is `scripts/src/instagram-source-policy-offline.mjs`. It
imports only Node hashing, a pure catalog-profile URL normalizer and the current
pure candidate gate. It is not imported
by the live research runner or API. Every result is labeled offline-only,
production-unapproved and claims-disallowed. `simulationUrls` are not an export
or an approved-link field.

For a batch impact comparison of supplied captured cases, see
[Offline source-policy impact report](INSTAGRAM_SOURCE_POLICY_IMPACT.md).
That CLI requires explicit settings and original request/decision bindings,
retains per-case and per-pair outcomes, and writes only exclusive ignored reports.
It does not implement the later paid evaluation criteria below.

## Source trust supported in this first harness

Only the conservative catalog-reference route is simulated:

1. An account belongs to the specified profile and is not disconnected.
2. A separately captured external-link observation on that exact catalog reference
   declares the exact website page.
3. A separate page observation includes the exact candidate account and music
   identity within the **same artist-specific section**.
4. Candidate/reference metadata and verifier results bind to the same identities.
5. Ownership context is artist-account, with no related-entity indicators,
   contradictions, competing profile claims or conflicting duplicate occurrence.

Search results, candidate self-links, copied assertions, global footer links,
promoted creators, release IDs and matching website names cannot establish the
route. Label/management-directory trust is **not implemented**; it needs a separate
trust-admission design rather than an unchecked `trusted: true` flag.

Snapshots carry observation times, source URLs, body hashes, selected links and
a digest of the entire observation. The digest detects packet modification;
it does **not** prove that the page is genuine or that a collector classified
link context correctly. This harness consumes supplied observations. An approved
collector must establish their real provenance before any real-data use.
No source-reviewed grading fixture is converted into a trust declaration.
Replay must retain the original verifier request hash. Supplying new website
observations to this policy simulation does not establish that an earlier JEV
response saw those observations or predict a fresh model verdict.

## Independent catalog website acquisition (offline only)

`scripts/src/catalog-website-source.mjs` supplies declarations to this harness,
not to live matching. It prefers original archived catalog-profile HTTP bodies;
it does **not** promote historical `referenceMetadata.externalUrls`, search
receipts, candidate self-links, known-answer labels, or the three grading sites
into declarations. Missing raw source context remains explicitly unresolved.

The supported source layouts are deliberately narrow:

- Spotify: a unique inert `__NEXT_DATA__` JSON script, exact artist URI/type
  under `props.pageProps.state.data.entity`, and website-labeled entries in
  that entity's `externalLinks.items`.
- YouTube: a unique inert `ytInitialData` assignment, exact channel metadata,
  and website-labeled `primaryLinks` in the selected About tab's
  `channelAboutFullMetadataRenderer`. Handle-based catalog accounts require an
  exact metadata handle URL; a channel ID alone cannot bind an unrelated handle.
- Only labels `Website` / `Official Website` are admitted. Arbitrary bio anchors,
  publisher/global footers, descriptions, recommended channels and social/search
  links are ineligible. Unsupported/currently changed layouts remain unresolved;
  the synthetic fixtures do not claim every current public page uses these shapes.

Raw archives use this input contract (body is the original UTF-8 HTML string):

```json
{
  "kind": "catalog_profile_http",
  "sourceUrl": "https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA",
  "finalUrl": "https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA",
  "observedAt": "2026-11-09T19:00:00Z",
  "status": 200,
  "body": "<original HTML>",
  "bodySha256": "<SHA-256 of original HTML bytes>",
  "redirects": []
}
```

Redirects must form a contiguous chain, retaining each
`{sourceUrl, finalUrl, status}` hop. Both ends must retain the exact catalog
identity. Only profile/About and Spotify artist/embed representations are
supported, not external redirect destinations or another artist. The source
and final URLs remain distinct in the output; the policy independently checks
both against the reference. If an original `packetSha256` exists, it must
validate and is retained as `originalPacketSha256`. Every output includes the
raw archive packet digest, body hash, original observation time, selected link
label/URL/structured field path, active catalog account IDs and catalog-input
snapshot hash, and a digest of the complete declaration.
Digests detect modification, **not authenticity** of caller-supplied archives.
Archive producers and active catalog snapshots must have independent provenance.
Unknown observation times are never filled with a file date or replay time.

The newest matching archive is considered first, including failed/removed
declarations. A newer missing or invalid declaration cannot be rescued by an older
favorable page. Conflicting captures at the same time stay unresolved. Freshness
requires an explicit evaluation time and maximum age; no window is recommended.

### Running the local adapter

```sh
node --test scripts/src/catalog-website-source.test.mjs \
  scripts/src/instagram-source-policy-offline.test.mjs
node scripts/src/collect-catalog-website-sources.mjs \
  --input generated-artifacts/source-trust/manifest.json \
  --out generated-artifacts/source-trust/report.json
```

The manifest contains `player` in the gate's existing catalog-account shape
(`profile_id`, active `account_ids`, `accounts`), `now` as ISO time or epoch
milliseconds, `maxEvidenceAgeMs`, optional `archives` / `archiveFiles`, and optional
already captured/sealed `pages`. File paths are workspace-relative. Output is
created exclusively under ignored `generated-artifacts/`; existing files are not
overwritten. Input bodies total at most 20 MB, individual bodies at most 2 MB,
input files at most 5 MB, and supported catalog references at most 20.
No source site, artist exception or grading answer is hardcoded into acquisition.

`declarations` are sealed `catalog_reference_external_links` packets.
`websiteEvidence` joins them only to supplied page snapshots at the **exact
declared page**, not all URLs on that domain. Both the join and gate compare the
full normalized HTTPS URL, retaining query parameters, fragments, and path
trailing slashes; query-selected artist pages cannot share declarations.
Page same-artist-section evidence,
packet validity/freshness, ownership context and verifier identity/request hash
still have to pass the offline gate. This is not general webpage extraction and
never creates missing page context or modifies benchmark labels.

### Optional bounded public acquisition

No public fetching was authorized merely by adding this adapter. It is disabled
unless the caller explicitly opts in. The CLI additionally requires
`--allow-public-fetch` and explicit manifest `publicFetch` limits:
`maxRequests` (1–20), `maxBytes` (1–2,000,000), `timeoutMs` (1–15,000) and
`maxRedirects` (0–3). There are no implicit limits, retries, credentials or paid
fallbacks. Valid archived declarations avoid public requests.

The separate `catalog-website-source-fetch.mjs` reader requests only fixed
Spotify/YouTube profile hosts bound to active references. It uses HTTPS with
normal TLS hostname validation, exclusively public IPv4 DNS results, DNS/socket
pinning, manual same-identity redirects, no agent/proxy/cookies/auth, identity
encoding, response byte caps and a deadline spanning DNS plus HTTP. Every hop
consumes the shared request budget, including failures. Declared artist sites
are **never fetched**. Safe transport alone does not establish source trust:
the captured body must separately pass the structured context/identity validator.

Public captures preserve actual acquisition time and are returned in
`capturedArchives`, including safe but context-invalid captures. Because acquisition
finishes after preflight, `sourceEvaluationTime` reports the later actual check
time. Gate replay must use an explicit time at or after the captures and independently
enforce its freshness windows. Old archive times are never refreshed by fetching
or re-adaptation. Neither public acquisition nor a successful simulation grants
production approval, approves spending or establishes population accuracy.

## Unresolved parameters stay explicit

The source route requires caller-supplied offline experimental parameters:

- Minimum source-route identity score / numeric-versus-verdict consistency floor.
- Maximum source-evidence age.
- Maximum verifier-observation age.
- Explicit evaluation time and `mode: "offline"`.

There are **no accepted defaults** for these parameters. Missing or invalid
source parameters disable the source bypass. Unit-test values are arbitrary
synthetic boundaries, not a recommendation derived from three artists.

The unchanged supported-match route still uses its existing exact-link,
likely-comparison, verified-verdict and **0.90** requirements. Additional
ownership/conflict checks in the simulation do not modify the current gate.
Report current-gate outcomes separately from proposed simulated outcomes.

## Contract checks required now

- A qualifying synthetic example passes only the simulation, never live approval.
- Default gate output and all original inputs remain unchanged.
- Missing parameters, malformed scores, stale/future observations and wrong
  artist/account bindings fail closed.
- Packet tampering, wrong trust origins and lookalike domains fail closed.
- Related entities, shared-handle conflicts, global/promoted links, different
  artist sections and significant underscore changes cannot qualify.
- Every duplicate occurrence must pass; a favorable result cannot hide a mismatch.
- Failed discovery is not absence; expected-answer fields cannot enter gate input.

These tests establish implementation behavior, **not JEV accuracy**.

## Proposed criteria for a later real-data comparison

These are recommendations awaiting approval, not an activated release gate.

### Freeze the evaluation before any paid call

- Freeze the selected source rules, numeric consistency floor, freshness windows,
  model/version, source collector and full serialized requests.
- Approve acceptable wrong-acceptance and missed-positive rates before seeing
  the results. No rate is inferred from the current small convenience sample.
- Obtain a separate explicit spending cap and reconcile the shared reservation
  ledger before paid dispatch. Never replay uncertain calls.
- Keep grading answers outside requests, evidence construction and admission.
  Record whether a source was selected using previously known answers.

### Build a genuinely new evaluation set

- Recommended development minimum: **20 distinct positive artists**, rather than
  20 repeated decisions over a few artists. This is not a statistical safety guarantee.
- Include independently reviewed wrong-person, near-name impersonator, fan,
  label, brand, venue, festival, shared-handle and copied-site controls.
- Include negative pages linking the exact correct music ID, so the test cannot
  pass simply by checking music association.
- Separate missing-proof, restricted, stale/conflicting-source and incomplete-search
  cases from known ownership negatives.
- Record original source times, label provenance, independent source relationships,
  prior exposure, curator disagreements and distinct artists/accounts/pairs.
  Do not rename already exposed development examples as held-out examples.
- Current three positive reference sites remain useful regressions, but do not
  by themselves satisfy this new evaluation requirement or website-trust admission.

### Report and stop rules

- Compare default and proposed outcomes on the same captured evidence. Distinguish
  improvement from new evidence versus improvement from a decision-rule change.
- Report correct acceptances/holds and wrong acceptances separately, including
  each related-entity category, evidence-only holds and model-only holds.
- Zero acceptance of known wrong controls is a development hard gate: any wrong
  acceptance stops progression and requires investigation, not threshold tuning
  against that example. Zero observed errors still does not establish a low
  population error rate.
- Correct-positive recovery must improve over the current rule, and the improvement
  must not depend on grading leakage, special artist exceptions or skipped controls.
- Missing trust evidence, stale labels, unresolved ownership disagreements,
  incomplete calls or model changes make the comparison incomplete, not passed.
- Passing synthetic tests or a development set cannot authorize production.
  Population-risk claims require an appropriately sampled independent validation
  set and uncertainty analysis that accounts for reused accounts and sources.

Only after these decisions and results are reviewed should a separately approved,
bounded **shadow** correction batch be considered. It must not submit claims or
change catalog links. Any later ingestion remains `account_links/claims.record`
followed by resolve, never direct live-table writes.
