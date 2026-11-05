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
