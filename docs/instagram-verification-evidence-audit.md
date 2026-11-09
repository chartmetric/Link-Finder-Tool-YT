# Why exact artist evidence can still be held

## Scope and finding

This is an offline investigation of the saved Frankelly completion, not a fresh evaluation or an acceptance-policy change. No paid calls, public HTTP reads, database operations, claims, imports or journal changes are part of this audit.

The saved completion is under:

`generated-artifacts/musician-instagram-verification-pilot-2026-11-05/live-updated-remaining-989/complete-unsent-frankelly-jev`

Its summary and successful HTTP 200 response agree: the independently discovered trailing-underscore account received **likely / 0.42**, while the cymbal brand and another drummer received mismatch / 0.01 and mismatch / 0.02. The 0.83 confidence on the **likely label** is not the same-identity score and cannot replace 0.42.

The positive candidate's saved music path contains:

1. Its Instagram external link to OneRPM.
2. The OneRPM Spotify button targeting the exact album.
3. That album's sole track.
4. That track's single credited artist, matching the catalog Spotify artist ID.

This is strong music-identity evidence. It is not, by itself, a measured conclusion about who owns the Instagram account. An associated label, fan or collaborator can link to the same recording.

## Serialization and questions

Earlier investigation already identified a lossy historical representation: intermediate destination edges were omitted, `ownershipConfirmed:false` represented an unperformed assessment as a negative, and the binary false criterion conflated insufficient evidence with a different identity. The current serializer repairs those distinctions:

- Retains page targets, content identities and credits.
- Emits `ownershipAssessment:unassessed`, without changing the archived resolver object.
- Describes unavailable evidence as uncertainty rather than mismatch.
- Keeps direct bio observations separate from derived music paths. A legacy enriched artist URL is not silently relabeled as an Instagram bio observation.
- Keeps model, endpoint, bounded typed questions and the 6,000-byte ceiling.

The original completion response does **not** contain the outgoing decision request. A reconstruction made with today's serializer is therefore not the historical request. Do not attribute the saved 0.42 to today's wording or claim that an offline serialization repair fixed the model. Later comparison experiments are documented in `scripts/INSTAGRAM_CANDIDATE_MATCHING.md`; none are rerun here, and none authorizes a fresh paid call.

At this audit, serializing **all three historical candidates together** with the current questions produces **7,216 bytes**, exceeding the unchanged 6,000-byte dispatch ceiling. The audit reports this explicitly; it does not truncate source evidence, remove controls, increase the limit or dispatch. Earlier recorded byte counts describe earlier serializers/experimental packets and must not be treated as the size of this current reconstruction. This is a separate input-budget issue, not an explanation for an already completed historical model response.

The typed response asks separate `noul` identity and categorical verdict questions. The existing acceptance gate additionally requires bound metadata, an exact cross-link, likely deterministic comparison, no related-entity or mismatch concern, **verified and score ≥0.90**. A verified label below 0.90 is still held. A likely label at 0.99 is also held. No global threshold is changed.

## Offline fixture matrix

`scripts/src/fixtures/instagram-verification-evidence-matrix.json` holds evaluator-only scenario labels. The runner uses fictional identities, the real public-page parser/resolver, the real request serializer and the real matching gate. Model responses are injected fixtures, not predictions or provider measurements.

| Family | Cases | Interpretation |
|---|---|---|
| Positive contract | Exact multi-hop path, direct bio link, reciprocal reference link, exact numeric boundary | Adequate source evidence plus an injected qualifying model decision can pass research matching, never claim approval |
| Missing evidence | Name only despite model approval; unavailable page | No account-absence or wrong-identity conclusion |
| Ambiguous association | Multiple credited artists despite model approval | Shared music credits do not establish sole ownership |
| Wrong identity | Different credited artist with mismatch and with model approval | Distinct IDs are not repaired by similar names or a confident model; the latter remains held for missing target evidence |
| Related entity | Fan and record-label accounts linking the exact target artist | A correct music link cannot override explicit association-only identity |
| Missing binding | Exact path attached to another Instagram account's metadata | Source evidence must belong to the candidate being assessed |
| Model disagreement | Exact path with likely, mismatch, or high-score likely | Source connection and model conclusion stay separate; a model mismatch is a gate rejection, not independently proved ground truth |
| Numeric gate | Exact path with verified / 0.89 | Categorical verification is insufficient under the unchanged gate |

These are contract checks, not an accuracy score or a calibration dataset. The fixture's expected classification is never sent to the verifier. A source-path mismatch is distinguished from a model mismatch; missing evidence is not mislabeled as either. Synthetic passing URLs do not promote any historical account.

## Reproduce without spending

```sh
node --test scripts/src/instagram-verification-evidence-matrix.test.mjs
node scripts/src/instagram-verification-evidence-audit.mjs
```

The audit prints source-file hashes, the archived scores, source and current serialized paths, current request size/hash and matrix results. It only reads files and writes stdout; it has no live flag or dispatch path. Missing source files fail explicitly. Optional archive directory input allows inspecting a copy without touching the original. Keep any redirected report under ignored `generated-artifacts/`, outside the source pilot directory.

No default verification behavior, discovery answers or historical decisions change. Further paid evaluation needs separate approval and a new exclusive journal; never replay the failed pilot or its completion admissions.
