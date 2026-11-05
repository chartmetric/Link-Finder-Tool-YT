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

Live requests reserve conservative whole cents before dispatch: Serper 1 cent, ScrapeCreators 2 cents (allowing up to ten credits), and JEV 2 cents. Reservations are never refunded automatically, including timeouts and calls blocked after admission. Those reservations are upper valuations, not reported invoice charges. Provider-returned ScrapeCreators credits and JEV usage/cost are retained separately; missing or excessive billing evidence stops admissions. JEV checks the whole serialized request (including questions) against a conservative 6,000-byte input bound. Its typed output has a bounded question/choice structure rather than a generated-text token stream.

Price sources checked 2026-11-05: Serper Starter $1/1k at https://serper.dev; ScrapeCreators $47/25k credits at https://scrapecreators.com, profile/channel endpoints list one credit in https://docs.scrapecreators.com/v1/instagram/profile and https://docs.scrapecreators.com/v1/youtube/channel; pinned `typesafe/jev-1.13` is $0.042/M input and $0 output at https://openrouter.ai/typesafe/jev-1.13. The JEV reservation exceeds the price of its full 262,144-token context at those rates. Recheck pricing before separately approving another run.

One candidate-sourced `linktr.ee` page can be read per artist, with fixed HTTPS domain/path checks, no redirects or credentials, and a bounded response. Arbitrary official-site crawling and other music landing-page hosts are not enabled. The first authorized live regression stage did not pass: Frankelly's correct URL was independently found but had no exact Spotify cross-link in accessible metadata; Shenge's results contained posts/topic pages but no direct profile. Remaining cases were not dispatched. This is not a successful full-sample verification or a corrected production dataset.

Run the runner/guard checks without network access:

```sh
node --test scripts/src/instagram-pilot-runner.test.mjs
```

Check live adapters and dollar reservations using mocked HTTP only:

```sh
node --test scripts/src/instagram-pilot-live.test.mjs
```
