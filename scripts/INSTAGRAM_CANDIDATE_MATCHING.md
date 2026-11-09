# Artist Instagram candidate matching

`musician-instagram-research.mjs` now separates raw search hits from identity-supported research candidates. No existing ClickHouse rows are rewritten by this code change.

## Promotion policy

`instagram_urls` receives a URL only when all of these are present:

- Completed Serper discovery, with a safe direct Instagram profile URL.
- A trusted active catalog account for this profile (Spotify artist, YouTube channel, or TikTok profile).
- Reference and candidate metadata bound to those exact account identities.
- An exact cross-link between that reference and candidate, not a similar name or handle prefix.
- A `likely` metadata comparison and a JEV `verified` decision with same-identity probability of at least 0.9.
- No explicit mismatch, conflicting duplicate assessment, or label/festival/fan-account concern.

Instagram metadata retains provider-returned `external_url` and `bio_links` destinations as `externalUrls`, and exact cross-links from those fields contribute to metadata comparison and reach JEV. A generic “link in bio” text signal does not independently award a direct-link identity bonus. YouTube Music channel references normalize to the same exact YouTube channel ID.

Name-only hits, missing metadata, inconclusive JEV and related-account hits remain `needs_review`. Their original profiles, sources and provider responses stay in `result_json`; each decision is recorded in `result_json.candidateMatching`. A rejected or unresolved hit does not prove that the artist has no Instagram account.

Future explicitly started searches use a linked catalog reference when available, enabling the existing metadata/JEV verification path while retaining Serper discovery. No reference means name-only discovery can gather evidence, but cannot promote a URL.

On future preparations, completed saved results are reassessed locally rather than blindly reused or automatically charged for another search. This is not a retroactive audit or cleanup of the existing lookup view.

New CSV reports also reassess saved results before filling `instagram_urls`. A historical `candidates_found` row with unsupported hits exports as `needs_review` with no importable URLs. `saved_status` retains the original status, and `requires_claim_resolution` remains true even for supported candidates. Previously generated CSV files are not retroactively changed.

## Import boundary

The historical lookup view still contains old raw candidates. **Do not treat `status = 'candidates_found'` alone as proof of identity.** For newly gated outcomes, check `result_json.candidateMatching.policy = 'catalog-reference-identity-v1'` and the supported `instagram_urls`. The supported candidates are still not approved live links.

All live ingestion must go through `account_links/claims.record` and the normal claim resolver, never direct writes to live account/profile-link tables. That external ingestion interface is not implemented by this research script.

## Validation

Run without network calls, paid searches or database writes:

```sh
node --test scripts/src/musician-instagram-matching.test.mjs scripts/src/musician-instagram-research.test.mjs scripts/src/musician-instagram-validation.test.mjs
```

Saved regression excerpts cover Frankelly Bello, Gula Mın 76 and Rooby Jeantal. The supplied Frankelly URL is held separately as a known answer; it is never injected into discovery output. Synthetic positive cases test valid cross-links and verified metadata, not a claim that a live account has been checked.

## Pilot prerequisites

The preflight CLI supports **zero-network preflight only**:

```sh
node scripts/src/instagram-pilot-runner.mjs --dry-run generated-artifacts/musician-instagram-verification-pilot-2026-11-05/manifest.json
```

`runFixturePilot` provides a stage runner for injected fixture transports only. Every simulated provider stage uses the shared capped budget and exclusive, fsynced admission journal. Existing journals cannot be replayed. Per-artist/provider/total limits, a five-request global concurrency limit, deadlines, credit-error stops and JEV payload/output reservations are checked before dispatch. Regression cases finish before other cases, and the remaining stage requires explicit post-result regression evaluation; no evaluator means no progression. Raw inspected metadata/decisions and uninspected-candidate counts are retained. This runner has no API-key loading, database/claim writes, automatic retries or live HTTP adapter. Use temporary, non-production journals for tests.

Repairing a reference format does not silently expand the frozen paid scope: the previously blocked YouTube Music reference is recognized, but remains excluded until scope and budget are explicitly revised. Missing references remain unresolved.

The separate `instagram-pilot-live.mjs` entry point now supports the explicitly approved, frozen 50-case pilot with a $10 maximum, 34 paid-eligible cases, and the same request caps. It creates a new exclusive run directory, never replays a journal, stores raw response packets and fsynced per-artist results, and reads known-answer holdouts only after blind regression discovery. No database, claims or import adapter exists here. The ordinary preflight command never launches paid work.

An explicitly approved follow-on run can pass a smaller exact-cent ceiling such as `--approved-cap-usd=9.89` and a completed source-run directory. Its cap plus the source run's prior conservative reservations may not exceed the original $10. Cache reuse requires a successful returned admission, matching profile/provider/URL/query, and an age under 24 hours. Failed, uncertain, stale or identity-mismatched packets are not reused. JEV decisions always refresh against the new evidence. Cache receipts are journaled with zero new charge reservation and cannot fall back silently to paid HTTP if the admitted cache packet is unavailable.

Live requests reserve conservative whole cents before dispatch: Serper 1 cent, ScrapeCreators 2 cents (allowing up to ten credits), and JEV 2 cents. Reservations are never refunded automatically, including timeouts and calls blocked after admission. Those reservations are upper valuations, not reported invoice charges. Provider-returned ScrapeCreators credits and JEV usage/cost are retained separately; missing or excessive billing evidence stops admissions. Both the budget and live adapter measure JEV's whole outgoing serialized request (including questions), not the larger archived discovery object, against the unchanged conservative 6,000-byte input bound. Its typed output has a bounded question/choice structure rather than a generated-text token stream.

Price sources checked 2026-11-05: Serper Starter $1/1k at https://serper.dev; ScrapeCreators $47/25k credits at https://scrapecreators.com, profile/channel endpoints list one credit in https://docs.scrapecreators.com/v1/instagram/profile and https://docs.scrapecreators.com/v1/youtube/channel; pinned `typesafe/jev-1.13` is $0.042/M input and $0 output at https://openrouter.ai/typesafe/jev-1.13. The JEV reservation exceeds the price of its full 262,144-token context at those rates. Recheck pricing before separately approving another run.

## Music landing pages and post-level search clues

The pilot now follows candidate-sourced `onerpm.link` and `linktr.ee` pages. OneRPM's declared Spotify service button may contain a Feature.fm wrapper; only its Spotify destination is decoded, with no JavaScript execution or analytics-click request. Direct artist targets retain their exact IDs. Track/album targets use public Spotify embed metadata bound to the exact requested content URI. A single-track album can lead to its track and credited artist ID. Names, recommended artists and arbitrary ID strings elsewhere in HTML do not count. Multi-artist credits, multi-track albums without explicit artist IDs, unreadable metadata and mismatched artist IDs remain unresolved.

Every public page or redirect is a separate budget admission. The default remains **one page per artist** for old manifests; no previous approved cap is silently increased. The user approved the revised manifest allowing at most four pages per artist (136 music pages plus 33 Spotify reference reads), with the same 50 cases, 34 eligible artists and unchanged paid caps. Its live known-case stage was executed within the remaining $9.89; it did not pass and the other 45 cases were not dispatched.

The public client uses an exact HTTPS host/path allowlist, public IPv4 DNS checks, socket-address pinning and TLS hostname verification. Redirects are manual and revalidated, with no credentials/cookies, arbitrary site crawling, or private-network access. Responses are size/time bounded. Public-page packets persist only selected link/credit evidence and a body hash, not Spotify's embedded anonymous sessions or raw tracking payloads.

The allowlist also accepts bounded artist/release paths for Komi, `lnk.to`, Hyperfollow/DistroKid, `paa.ge`, and `bfan.link`, plus Spotify artist/release pages and YouTube video links. Subdomains are allowed only for Komi and `lnk.to`; all hosts, path shapes and IDs are validated before a fetch. Tracking query parameters are stripped from canonical page URLs. A link page is read as text only: direct Spotify artist/album/track links and YouTube video links are gathered from anchors, without running page scripts. The resolver checks every supported source link in order, prioritizes exact catalog artist/channel IDs, and stays within the existing four-page cap. A single credited artist can provide a catalog-bound music identity; multiple-artist credits remain ambiguous. A YouTube video exposes only its declared channel ID, not proof the Instagram account belongs to that musician.

The verifier request now includes deterministic, exact Instagram-bio/catalog cross-link observations and the existing comparison status/reasons as separately labeled evidence. The prompt explicitly treats a link as a connection, not proof of account ownership; missing or unsupported evidence remains uncertainty. The 0.90-plus-`verified` acceptance gate is unchanged.

A separate two-call saved-evidence comparison tested that prompt/input against earlier outcomes, using Aimee Carty and Eliah Sternhardt with The Format and Billylildove as controls. Both earlier positive outcomes were `verified` / 0.78; the new requests returned `likely` / 0.57 and 0.52. Both controls remained mismatches / 0.06. Neither positive passed the unchanged gate. This is a two-case regression signal, not population calibration, and does not isolate wording from model variability. The test reserved four cents and reported $0.000145068 in JEV charges, with no other provider requests or database writes. Exact requests and results are archived in `generated-artifacts/instagram-evidence-update-check-2026-11-06`.

Following that result, the offline prompt was clarified to weigh observed exact links together with account names, bios and contradictory evidence rather than dismiss a strong link because it cannot alone prove ownership. This latest wording has **not** had another live call; the two paid admissions cannot be replayed. Keep the full rerun held and the 0.90-plus-verified gate unchanged until a separately approved evaluation demonstrates recovery without promoting controls.

Serper candidates now retain explicit Instagram handles from post/reel titles, snippets and owner paths with their original source URLs and `ownershipConfirmed: false`. No handles are invented from display names or topic slugs. Candidate ranking can prioritize exact normalized artist-name handles, but it does not increase identity scores. Post-only clues do not suppress the second already-budgeted search, and clues from both searches are retained. Every clue still requires account-bound metadata, music-reference evidence and JEV verification; a fan, venue or label posting about an artist does not become the artist.

Saved-evidence validation now traces Frankelly's OneRPM button through the Spotify album and track to the exact catalog artist ID, and recovers `shenge_wasehlalankosi` from an explicit mention in a saved Serper post title. No paid calls were repeated, previous JEV decisions were not replaced, and no URLs were promoted or imported. The original live pilot remains stopped at its failed regression gate; these fixes do not retroactively turn it into a passing pilot.

The updated live stage reused 12 completed packets and collected new metadata/JEV evidence. It found the exact Frankelly music-account path, but his final verification was initially blocked before admission by an archived-payload size check. After measuring the actual outgoing request under the same limit, only that provably unsent JEV step was completed in a new exclusive journal. No admitted request was replayed. JEV still returned `likely`, not `verified`; Shenge's retrieved account had no music cross-link. Neither was promoted. All model/source disagreement stays explicit rather than becoming account absence or a proven mismatch. Total conservative reservations across both pilots and that one-step completion were $0.39; no claims or catalog writes occurred.

### Offline audit of the verifier disagreement

The saved Frankelly response was HTTP 200 with a complete typed `likely` / 0.42 decision, not an API or credit failure. Reconstructing the historical 4,735-byte input identified three evidence-contract problems:

- The music path always said `ownershipConfirmed:false`, even though the resolver had not assessed ownership.
- Path compression retained page addresses and final artist IDs but dropped the two music-service destination edges connecting OneRPM → album → track.
- The binary question grouped “different identity” and “insufficient ownership evidence” under the same false criterion, so a low score did not distinguish an actual mismatch from missing evidence.

The payload now expresses ownership as `unassessed`, retains source/target links and bound content types/URLs, and explicitly distinguishes uncertainty from evidence of a different identity. The model, its API route, the strict 0.9-plus-verified gate and all saved decisions remain unchanged. Future response packets also preserve the actual decision request plus its SHA-256, without authentication headers, so audits need not reconstruct input from newer code.

Offline checks against the real saved Frankelly evidence confirm both edges reach the outgoing request, which is 5,564 bytes and remains below the same 6,000-byte ceiling. The old result is still unresolved. No paid call or import was performed for this audit. The effect on JEV's score remains unmeasured until a separately approved controlled live validation; do not call the false-negative issue fixed solely because the payload is corrected.

The user subsequently approved a two-call comparison capped at four cents of new reservation. Both arms used the same saved Frankelly metadata, music evidence and two unrelated-account controls; the old serializer was loaded from history and checked against its 4,735-byte reconstruction. Both calls resolved to the same model release. The old input returned `likely` / 0.39, while the corrected input returned `verified` / 0.81. Both controls remained mismatches in both arms. The unchanged 0.9-plus-verified application gate still held the positive case, so neither arm produced an accepted URL.

This single paired case supports further evaluation of the evidence repair, not a population-level accuracy claim or threshold reduction. No other artists, searches, claims or imports ran. The comparison's reported provider charge was $0.000158172; conservative reservations were four cents, bringing the cumulative reserved ceiling to $0.43 of $10. The original decisions remain intact; separate evidence is under `capped-jev-comparison-04c`.

Run the runner/guard checks without network access:

```sh
node --test scripts/src/instagram-pilot-runner.test.mjs
```

Check live adapters and dollar reservations using mocked HTTP only:

```sh
node --test scripts/src/instagram-pilot-live.test.mjs
```

Test music-link resolution, SSRF protections, post clues and end-to-end fixture behavior:

```sh
node --test scripts/src/public-music-links.test.mjs
```

### Saved-input provenance audit and repeatability check

The next authorized diagnostic checked all 18 saved metadata packets against their raw Instagram provider responses. Aimee's exact Spotify artist URL was derived through Linktree → album → track, not directly returned as an Instagram bio link. Eliah's exact Spotify artist URL was directly returned in Instagram `bio_links`. The prior two-call experiment also incorrectly gave each unrelated control its own catalog reference and marked both positive/control comparisons `likely`; that experiment cannot isolate prompt effects.

The transport now preserves raw `directExternalUrls` separately from enriched links. Legacy enriched metadata without raw provenance no longer produces a claimed direct bio link. Music paths remain in the decision evidence. Catalog-to-Instagram links are checked in the correct direction, and reference identity must match the target before exact-link summaries are emitted. Source archives and legacy outcomes remain unchanged.

`scripts/src/instagram-provenance-diagnostic.mjs` reconstructs provenance from raw saved packets, binds both candidates to the same target artist, computes comparison status rather than hardcoding it, and freezes exact outgoing input hashes. Offline mode makes no provider requests. The one-shot approved run uses four JEV-only calls, two identical inputs per artist, with exclusive journals and an eight-cent maximum reservation. No Serper, metadata, public-page, database or claim requests are made.

Results under `generated-artifacts/instagram-provenance-diagnostic-2026-11-06`:

| Target | Repeat 1 | Repeat 2 | Unrelated control |
| --- | --- | --- | --- |
| Aimee Carty | likely / 0.75 | likely / 0.76 | mismatch / 0.04 both |
| Eliah Sternhardt | likely / 0.68 | likely / 0.68 | uncertain / 0.08 and 0.09 |

All four calls resolved to the same reported model release. None passed the unchanged exact-cross-link plus verified 0.90 diagnostic gate. Scores were stable within these repeated inputs, but two provisional positives do not establish population accuracy or independent ground truth. Differences from older runs remain confounded by input/prompt repairs; do not ascribe them to a single change.

Reported JEV charges total $0.000294756; conservative reservations increased from $1.23 to $1.31, leaving $8.69 of the original $10 ceiling. The full rerun and all imports remain held. These results test saved evidence, not fresh discovery recovery.

### Alternative verifier on frozen saved inputs

The user approved comparison with another verifier. The one-shot script `scripts/src/instagram-alternate-verifier.mjs` uses Claude Haiku 4.5, selected from the live OpenRouter catalogue, with the exact saved state and questions from the provenance-corrected JEV packets. Two identical requests per target assess repeatability. It does not replace the production verifier or submit claims. Alternate numeric scores are self-reported estimates, not calibrated equivalents of JEV's Noul output.

Four admitted calls completed without retries under a $0.24 conservative reservation. Both Aimee decisions were likely / 0.82; both Eliah decisions were likely / 0.85. The Format control was mismatch / 0.05; Billylildove was uncertain / 0.15, in both repeats. No candidate passed the diagnostic verified-plus-0.90 threshold, and no production acceptance rules changed.

The explanations reveal a possible circular-evidence problem: despite recognizing exact music links and consistent names, the alternate verifier cites the application's own "ownership unassessed" annotation as a reason verification cannot be completed. This is not independent evidence from Instagram that ownership is unknown. It supports a controlled future test separating observed source facts from prior workflow/comparison labels; it does not prove that JEV has the same reasoning or that the accounts should be automatically accepted.

Results and exact requests are archived under `generated-artifacts/instagram-alternate-verifier-2026-11-06`. Reported charges were $0.011836 total. Cumulative conservative reservations are $1.55, leaving $8.45 of the original $10 ceiling. No searches, metadata calls, database writes, claims or full rerun occurred. Both positives remain provisional catalog benchmark labels, not independent ground truth.

Offline tests:

```sh
node --test scripts/src/instagram-alternate-verifier.test.mjs
```

### Removing internal status labels: controlled alternate-verifier test

The user approved removing internal review labels and repeating the comparison. The `--facts-only` mode removes candidate `identityComparisonStatus` and `identityComparisonReasons`, plus music-path `status` and `ownershipAssessment`. Source names, bio text, URLs, exact-link summaries, music-path destinations, questions, system prompt, model settings and acceptance thresholds are unchanged. Unknown is not replaced with confirmed ownership.

Offline assertions and post-run archive comparisons confirm these are the only request-content changes. Four new calls (two identical repeats per target) completed without retries. Compared with the previous same-verifier requests:

| Target/control | With application labels | Without application labels, both repeats |
| --- | --- | --- |
| Aimee Carty | likely / 0.82 | verified / 0.95 |
| The Format control | mismatch / 0.05 | mismatch / 0.05 |
| Eliah Sternhardt | likely / 0.85 | verified / 0.98 |
| Billylildove control | uncertain / 0.15 | mismatch / 0.02 |

Both provisional positives met the diagnostic threshold in both repeats; neither control did. This supports removing prior workflow judgments from this verifier's evidence input. It does not validate JEV behavior, full discovery recovery, population accuracy, or a production replacement. The model's free-text explanation is not ground truth: Aimee's path is still derived through Linktree and music releases, even where the generated explanation loosely calls it direct.

All requests and responses are archived separately under `generated-artifacts/instagram-facts-only-verifier-2026-11-06`. Provider-reported charges were $0.011786; new conservative reservation was $0.24. Cumulative reservations are $1.79, leaving $8.21 of the original $10 ceiling. No production verifier, saved discovery outcome, database row, claim or import changed. A broader independently supported positive and related-entity negative benchmark is still needed before scaling.

### Broader verification-only diagnostic

#### Music-path follow-through fixes

##### Exact album-credit source investigation

The subsequent read-only investigation found an existing exact-ID source on the `vert` service: `catalog.l_spotify_album_spotify_artist`, with album metadata in `catalog.spotify_album`. Evidence and source queries are archived under `generated-artifacts/instagram-album-source-investigation-2026-11-09/catalog-evidence.json`. Both tables were read with `FINAL`; all relationship rows for each requested album were examined before checking deletion/ambiguity.

| Target | Linked album | Exact album ID | Active related Spotify artist ID |
| --- | --- | --- | --- |
| Billylildove | Succubus | `5mBygSc9qIZ1oTAnazLwmL` | `430ft5iRke01tvX74xVM8Z` |
| The Format | Boycott Heaven | `4yMJnpezQRZr8MIkNUor1M` | `3ZJC8cLts8Q8s8JbNJKsLf` |

Each album has exactly one active relationship, the album is active and not classified as a compilation, and the observed artist URL matches the target's saved catalog reference exactly. These are stored catalog relationships, not a fresh Spotify API response. Relationship timestamps are retained in the archive. They fill the missing music-ID connection, not proof that the Instagram account is owned by the artist.

Spotify's official [Get Album](https://developer.spotify.com/documentation/web-api/reference/get-an-album) documentation also specifies an `artists` array containing exact artist IDs/URLs. That API requires authorization, but a new Spotify integration is unnecessary for these two already-covered catalog records. No paid searches, metadata calls, model calls, claims or database writes were performed.

The user subsequently approved connecting the lookup. `scripts/src/catalog-album-evidence.mjs` now performs bounded read-only exact-ID queries; both explicitly started live pilot/benchmark entrypoints enable it and record its limits in the run manifest. The ordinary resolver remains injectable and zero-network unless a caller supplies a lookup. Direct album links can resolve without a public album fetch; landing-page albums require the preserved source edge. Catalog-only work can run after public-page allowance is exhausted without increasing that allowance.

Each lookup considers all `FINAL` album/artist rows, not just the expected artist. Missing, deleted, inactive, conflicting, multi-artist and compilation results remain unresolved. A query failure is recorded separately and cannot imply account absence; existing independently budgeted public evidence can still be checked. No query automatically retries. Limits are four lookup admissions per eligible artist, a frozen total, serial dispatch and a 15-second deadline maximum. Exact same-profile/album reads reuse the first result; failed/uncertain requests are not reissued. Separate exclusive, fsynced `catalog-album-*.jsonl` evidence journals cannot be confused with completed provider-cache `.json` packets.

Catalog rows, timestamps, the source-linked album URL and its parent edge are included in the verifier input separately from public-page evidence and direct Instagram links. The existing verified-plus-0.90 ownership gate is unchanged. Nothing routes the lookup result directly to live account/profile-link tables.

The offline replay of the saved Billylildove and The Format records now builds exact music-ID evidence for both; the full one-candidate verifier requests are 2,985 and 3,080 bytes respectively, within the existing 6,000-byte cap. The replay made no database, public-page or model calls and did not alter saved decisions. It is archived as `pipeline-offline-check.json` alongside the investigation evidence. Ownership remains unverified until an authorized live verifier check. Tests cover both the resolver and full fixture pilot flow, ambiguity, missing records, wrong artist IDs, compilation/label rejection, caps, journal-before-dispatch, no-retry behavior and unchanged confidence requirements.

The user then authorized a two-call, four-cent-reservation verification test. `scripts/src/instagram-catalog-album-verifier-test.mjs` reconstructs both saved evidence sets with raw Instagram direct-link provenance, uses the archived exact catalog album relationships, and pairs each target with the other artist's account as a control. Both controls are bound to the target reference, not their own reference. No benchmark labels are sent. Model, production questions, internal annotations and the 0.90 gate are unchanged; this is not a facts-only alternate-verifier comparison.

Both JEV calls completed on `typesafe/jev-1.13-20260917`. Billylildove received likely / 0.76; The Format received likely / 0.78. Both cross-artist controls received mismatch / 0.04. Neither target passed the strict ownership gate, despite both having exact music-ID evidence. The exact two-candidate request sizes were 5,950 and 5,944 bytes, within the unchanged cap.

Requests, hashes, responses, admissions and results are archived exclusively under `generated-artifacts/instagram-catalog-album-verifier-test-2026-11-09`. The archive retains catalog update times but does not invent a missing original query-observation timestamp; replay time is not query time. Two admissions and two returns reconciled, with no retries or other request kinds. Provider-reported total cost was $0.000191142. Conservative cumulative reservations are $3.21, leaving $6.79 of the original $10 ceiling. There were no new searches, public reads, metadata calls, database queries, claims, database writes or imports. No full rerun started. Source completeness improved; verifier uncertainty remains and no population-level readiness claim is justified.

### Controlled JEV label comparison

The user approved investigating whether the remaining holds reflect JEV's judgment or restrictive application inputs/rules. `scripts/src/instagram-jev-label-ablation.mjs` performs four exclusively journaled calls: the exact archived baseline request and a source-facts-only variant for each of those two artists. It removes only internal comparison status/reasons, music-path status/ownership assessment, and catalog-link computed status. Raw music relationships, source URLs, declared direct links, page edges, questions, model, target bindings and acceptance rules are preserved. The two tests cover preservation and distinguish identity probability from confidence in a categorical verdict.

| Target | Fresh baseline | Source facts only | Unrelated controls |
|---|---|---|---|
| Billylildove | likely / 0.74 | likely / 0.60 | mismatch / 0.03 and 0.02 |
| The Format | likely / 0.79 | likely / 0.62 | mismatch / 0.04 and 0.04 |

All calls resolved to the same `typesafe/jev-1.13-20260917` release as the archived requests. Baseline repeats showed small numeric variability. Removing labels did not yield acceptance; all four positive assessments remained likely and below the independent 0.90 numeric gate. The choice distribution did shift, so this is not evidence that labels have no effect. Neither lowering the numeric threshold alone nor mistaking verdict-label confidence for identity probability would address the full categorical-plus-numeric gate. The existing code reads the actual Noul identity answer correctly; the separately returned choice confidence describes the selected verdict, not artist ownership.

This does not establish whether JEV is appropriately cautious or overly restrictive in the population. Both targets are provisional positives rather than an independent ownership gold standard, and unrelated-artist controls do not exercise label/festival/fan attribution. A benchmark with independently confirmed positive accounts and hard related-entity negatives is needed before threshold calibration or a full rerun. The alternate verifier's earlier facts-only improvement cannot be assumed to transfer to JEV. Production inputs and thresholds remain unchanged.

Archive: `generated-artifacts/instagram-jev-label-ablation-2026-11-09`. Four admissions and four returns reconciled with no retries, searches, metadata/public/database reads, claims, database writes or imports. Actual reported charge: $0.00036918. Conservative cumulative reservation: $3.29; remaining original budget: $6.71. No full rerun started.

```sh
node --test scripts/src/catalog-album-evidence.test.mjs scripts/src/public-music-links.test.mjs scripts/src/instagram-pilot-live.test.mjs scripts/src/instagram-pilot-runner.test.mjs scripts/src/instagram-verification-benchmark.test.mjs
```

The resolver now tries another directly source-linked path after a public-page failure, counts failed attempts against the same page allowance, and lets a later selected candidate use the artist's remaining shared allowance. Grouped Linktree link records are traversed, while whole-page navigation/promoted-profile anchors are excluded. Previously derived URLs cannot be reused as independent starting evidence.

A bounded public-page diagnostic for Billylildove, JUNHEE and The Format is archived under `generated-artifacts/instagram-music-path-check-2026-11-09`, with album-parser follow-up under the sibling `-album-schema` directory. Seven original page requests, two additional schema-inspection requests and two follow-up album reads occurred (eleven public requests total, zero paid provider calls). The Format landing page was reused from its archived packet for the follow-up rather than fetched again. No fresh search, Instagram metadata, model decision, claim, database write or import occurred; conservative pilot funds remain $6.83.

The public sample uncovered Linktree navigation and promoted profiles in whole-page anchors. The fix now requires declared profile-link records; the corrected filtering is covered offline, not claimed as a fresh JUNHEE live result. Both Spotify album embeds returned the requested album identity and track names, but did not expose usable exact artist credits in the parsed bounded metadata. No new exact music-ID matches or ownership approvals were established. Related-artist URI fields, when present, are retained separately as association and cannot satisfy the exact-link gate. Multi-track album names or a single selected track must not be substituted for authoritative album artist credits.

The source-URL allowlist, DNS pinning, four-page artist cap, separate ownership check and verification threshold remain intact. Offline regressions cover unavailable branches, nested links, unrelated page promotions, provenance, shared candidate allowances, mismatched IDs and multi-artist ambiguity. This improves evidence collection and prevents unrelated navigation from becoming evidence; it does not establish full-rerun readiness.

#### Facts-only alternate-verifier expansion

The approved saved-evidence expansion is archived under `generated-artifacts/instagram-broader-facts-validation-2026-11-06`. Runner: `scripts/src/instagram-broader-facts-validation.mjs`; offline reporter: `scripts/src/instagram-broader-facts-report.mjs`. The exclusive journal admits at most 23 serial requests, with no retries, no new search/metadata calls and no claims or database writes. Prior workflow judgments are excluded; evaluator labels stay outside model inputs. Raw Instagram packets restore direct-link provenance. Historical wrong-person and festival evidence is explicitly typed as saved Serper snippets, not fabricated profile metadata.

All 23 paired requests completed: 18 existing benchmark targets plus five regression comparisons (Frankelly appears twice). Four candidate assessments passed the diagnostic gate, representing three unique artists: Aimee Carty, Eliah Sternhardt and Frankelly Bello. Frankelly's supplied trailing-underscore account passed in both comparisons. `belloo_official` remained uncertain (0.25), the Gula festival was mismatch (0.05), and the associated cymbal brand and venue were mismatches. No rotated distinct-catalog control passed (19 assessments). Rooby's label association was held offline for missing music reference; it was not model-tested or verified.

Five other candidates received a verified / 0.95 model verdict without the required exact catalog-bound link. The deterministic evidence gate held all five. These are not established false positives, but demonstrate why a model's confident verdict alone must not authorize ingestion. Shenge's user-confirmed account remained likely / 0.72 and held; Gin_Beatz was also likely / 0.72. Removing internal labels helps the exact-evidence cases but does not solve missing reference paths or establish full-rerun readiness.

The sample is historical and intentionally selected, not a population-accuracy estimate. Catalog benchmark labels remain provisional. The alternate verifier is not a validated production replacement for JEV. Provider-reported total cost was $0.063476; conservative reservations increased by $1.38 to $3.17, leaving $6.83 of the original $10 ceiling. Exact requests, responses, source hashes, report and `results-NOT-FOR-IMPORT.csv` are retained. Production rules and discovery records are unchanged.

```sh
node --test scripts/src/instagram-broader-facts-validation.test.mjs scripts/src/instagram-alternate-verifier.test.mjs
```

The authorized 20-artist benchmark (four per current audit tier, half provisional catalog links and half saved candidates) is archived under `generated-artifacts/instagram-verification-benchmark-2026-11-06`. It makes no Serper discovery calls and never writes claims or catalog data. Benchmark membership and expected labels are excluded from JEV inputs; rotated cross-artist controls reuse already retrieved metadata.

Eighteen cases completed; two Instagram metadata calls returned HTTP 500 and were not retried. All 18 cross-artist controls received mismatch verdicts. None of the nine evaluated catalog benchmarks or nine saved candidates passed the unchanged exact-cross-link plus verified 0.90 diagnostic gate. Aimee Carty and Eliah Sternhardt each had exact music identity links and a verified verdict at 0.78, which remained held. Other metadata exposed unchecked music landing sites and Spotify release paths, not proof of incorrect ownership or absence.

These are diagnostic controls, not independently adjudicated ground truth or population accuracy measurements. The run reserved $0.76, bringing cumulative original-pilot reservations to $1.19 of $10. It did not start a full rerun or alter legacy results.

Runner, budget, transport and benchmark fixtures:

```sh
node --test scripts/src/instagram-verification-benchmark.test.mjs scripts/src/instagram-pilot-runner.test.mjs scripts/src/instagram-pilot-live.test.mjs
```
