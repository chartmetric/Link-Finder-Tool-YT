# Offline source-policy impact report

This runner compares **unchanged current-gate decisions** with the existing
experimental source-policy contract on supplied captured cases. It is not a
verifier accuracy benchmark, label adjudication, the live CSV outcome filter, or
a production activation tool. Every simulated URL is **NON-IMPORTABLE** and
**PRODUCTION-UNAPPROVED**, even when the simulation accepts it.

The runner makes no HTTP requests, reads no credentials, calls no providers,
submits no claims, and changes no database, application gate, export or catalog.
It imports only local pure policy modules and Node file/path/hash builtins.
No running application or workflow restart is needed.

## Run

```sh
node scripts/src/instagram-source-policy-impact-cli.mjs \
  --input /absolute/path/to/captured-impact-cases.json \
  --output unique-review-name \
  --evaluation-time YOUR_EXPLICIT_UTC_ISO_TIMESTAMP \
  --minimum-source-identity-score YOUR_EXPERIMENTAL_SCORE \
  --max-evidence-age-ms YOUR_EXPERIMENTAL_WINDOW_MS \
  --max-verifier-age-ms YOUR_EXPERIMENTAL_WINDOW_MS
```

Replace every placeholder yourself. There are no recommended or default settings.
The evaluation time must be a valid UTC ISO timestamp with seconds and optional
three-digit milliseconds, for example the *format* `YYYY-MM-DDTHH:mm:ss.sssZ`.
The score is a finite number in `[0,1]`; windows are positive safe integers in
milliseconds. All flags are required, exactly once. Unknown flags, live mode,
paths as output names and missing settings fail before output creation.

The only output location is:

```text
generated-artifacts/instagram-source-policy-impact/<unique-review-name>/
  report.json
  report.md
```

Both Git and deployment ignore the entire `generated-artifacts` directory; the
runner checks those ignore declarations before writing. Output ancestors cannot
be symlinks. Directory creation is exclusive: reusing even a partial run's name
fails, and files use exclusive writes. Choose a new name after a failed write;
the runner will not clean up, overwrite or resume an old directory. Keep captured
inputs under the ignored directory too; never commit original requests or source
captures. No production artifacts are created or presented by this CLI.

## Input contract

The JSON file has exactly two top-level fields:

```json
{
  "schemaVersion": "instagram-source-policy-impact-v1",
  "cases": []
}
```

Supply at least one case. Each case has exactly these fields:

| Field | Meaning |
| --- | --- |
| `caseId` | Unique nonempty capture/case identifier, not an artist name used as identity. |
| `player` | Original captured catalog player accepted by the current gate, including stable `profile_id`, `artist`, `account_ids`, and `accounts`. |
| `result` | Original captured discovery result, including `methodsUsed`, `profiles`, bound identity metadata and original `jevVerification` decisions. |
| `websiteEvidence` | Explicit array of independently supplied source observations accepted by `assessOfflineSourcePolicy`; use `[]` when missing. |
| `historicalVerifiers` | One original request/decision binding for every candidate with a `jevVerification` decision; use `[]` only when there are no such decisions. |

Do not rebuild `result` using today's serializer or augment its candidate
metadata, ownership context or cross-links with new website facts. Those facts
belong only in `websiteEvidence`. The report hashes both lanes separately.
Do not set `ownershipContext` from an expected ownership answer to force a pass:
unknown or missing ownership context must remain unknown or missing.

### Historical request and decision binding

Each `historicalVerifiers` record contains:

```text
candidateIndex: integer index into result.profiles
requestProvenance: "original_captured"
requestBody: exact original serialized JSON request, as a string
requestSha256: SHA-256 of requestBody UTF-8 bytes
decision: verbatim original result.profiles[candidateIndex].jevVerification
decisionSha256: SHA-256 of JSON.stringify(decision), UTF-8
```

The decision must itself contain:

- `requestSha256` equal to the original request hash;
- `profileId` equal to the player's stable `profile_id`;
- `accountUrl` equal to the candidate's normalized Instagram account;
- a nonempty `model` identifier;
- the archived verdict, score and observation time (unknown times stay unknown).

The runner validates all bindings before either decision can be reported. It
does not supply a model, attach a new timestamp, rescore a decision, generate an
original request, or accept a reconstructed request declaration. Raw request
bodies are used only for validation/hashing and are **not copied into reports**.
Request and decision hashes bind supplied content; they do not authenticate the
collector, prove the binding's historical truth, or prove any source facts.
The `original_captured` declaration is the input supplier's responsibility.

Archives lacking original request bytes or original identity/request bindings
are **ineligible for this historical replay contract**. Do not fabricate these
fields to include them. A genuinely unverified candidate can omit
`jevVerification` and has no historical binding; it is explicitly reported as
having no historical model decision. Do not strip an existing historical
decision just to bypass a binding failure.

### Supplied website observations

Use the existing `instagram-source-policy-offline.mjs` contract unchanged:

```text
websiteEvidence[]:
  profileId
  page:
    sourceUrl, observedAt, bodySha256, links[], packetSha256
  catalogDeclaration:
    kind: "catalog_reference_external_links"
    sourceUrl, observedAt, bodySha256, links[], packetSha256
```

`page.links` contains typed observations with `url`, `contextKind` and `contextId`.
The exact Instagram and catalog music-identity links must share the same
artist-specific context. The separate catalog declaration must be observed on
an active catalog-bound reference and must declare the exact website page.
`bodySha256` hashes the captured source body. `packetSha256` is the hash of
`JSON.stringify(snapshotWithoutPacketSha256)`; the pure `sealOfflineSnapshot`
helper can seal an observation that was actually captured. It must not create
a missing declaration or establish trust from its own digest.

Missing, stale, future, malformed and tampered packets remain missing/held in
the simulation. Missing proof is not an ownership negative. A website containing
the correct music ID does not, by itself, establish domain trust or ownership.
See [the source-policy contract](INSTAGRAM_SOURCE_POLICY_VALIDATION.md) for exact
admission requirements and limitations.

### Grading isolation

No answer/label file is read. Grading fields such as `expectedArtistOwned`,
`labelEvidence`, `labelTier`, `adjudication`, `stratum`, `groundTruth`, `grading`
and `expected` are rejected recursively in the case input and parsed historical
request JSON. Do not paste grading material into free-text fields either.
Keep any answer review in separate files outside the input pipeline. No grading
label is used to synthesize a declaration, ownership context or source link.

## Report interpretation

The report includes:

- Frozen explicit experimental settings, input-file byte hash, input-object
  hash, original player/result hashes, and supplied-evidence hashes.
- Full per-case current and simulated gate outputs, including empty/failed cases.
- Each artist/account pair's baseline/proposed decisions, reasons and change
  (`unchanged`, `new_simulated_acceptance`, `new_simulated_hold`).
- Every occurrence and original request/decision hash, model, observation time,
  score and verdict, separate from newly supplied source facts.
- Source/body/packet hashes, digest validity, missing proof, source/verifier
  freshness (`fresh`, `stale`, `future`, `missing_or_invalid`), conflicts and
  selected proof hashes where the source route qualifies.
- Distinct artists, normalized accounts and artist/account pairs; repeated
  pairs/extra occurrences; account reuse across artist IDs; blocked/empty cases;
  baseline/simulated accepted-pair and change counts.

Current-gate acceptance uses its **final URL set**, not just a favorable
candidate status: a contradictory duplicate cannot hide behind a supported
occurrence. Cross-case repeated pairs aggregate with **all occurrences must
pass**, while retaining each original result. This is a reporting aggregation,
not a change to either gate. Shared accounts across different artist IDs are
flagged as unresolved ownership risks, **not adjudicated automatically**.
Invalid account occurrences remain visible and are not counted as accounts.

“Historical model replay” means the archived model's decision is reused, not
that a model was run again. The new website observations enter only the policy
simulation. The report always states that the old model is **not asserted to
have seen these facts**. A simulated recovery cannot predict how the model
would answer a new request with different evidence.

The current gate is rerun unchanged today on the original metadata; it is not
represented as an archived historical gate decision. There is no accuracy
denominator, correctness grade, calibration claim, held-out claim or population
estimate. Failed discovery, no candidates and missing proof do not confirm
account absence. Simulated acceptances authorize neither import nor production.

## Verification

```sh
node --test \
  scripts/src/instagram-source-policy-impact.test.mjs \
  scripts/src/instagram-source-policy-offline.test.mjs \
  scripts/src/musician-instagram-matching.test.mjs
```

These tests use clearly synthetic request/decision/source fixtures, not measured
model decisions or a real artist comparison. They cover binding failures,
grading isolation, unchanged gate behavior, thresholds/freshness, repeated/shared
accounts, blocked/empty cases, reporting and exclusive offline writes.
A real-data report requires the user's supplied captures and explicitly chosen
settings. Running these tests does not choose those settings or establish
production readiness.
