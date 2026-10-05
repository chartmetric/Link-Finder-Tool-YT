# Single-artist social profile investigation — requirements and implementation handoff

**Status:** Documentation of the currently implemented URL-only investigation, with limitations and possible follow-up work explicitly labeled.  
**Product:** Find Social Links / Musician Social Finder  
**Primary interface:** `/` (also at `/single-artist`; the standalone catalog page has been removed)
**Purpose of this document:** Give a product owner or new engineer enough context to understand why this flow exists, how it works today, which judgments are deterministic, where external search and AI introduce uncertainty, and what must remain true when it changes.

## 1. Executive summary

The user starts with **one known Instagram or TikTok profile, YouTube handle/channel, or Spotify artist URL**. The app reads that account to derive its identity, searches for possible accounts on the other supported social platforms, compares candidate profile metadata to the known account, and presents the findings for **human review**. Spotify references search all three social targets; other references search the two remaining platforms. Discovery does not search the existing musician database.

This is an **identity investigation**, not a proof of ownership. Search hits are suggestions; a high *search score* does not mean an account is authentic. The page separates discovery from verification, shows evidence and missing evidence, and does not return the supplied platform as a candidate.

The page currently requests **Serper** search and **Gemini online discovery**. The backend also uses **ScrapeCreators** to resolve the reference account and read candidate metadata, may use a ScrapeCreators cross-platform fallback when Gemini misses a target platform, and automatically requests a **JEV** identity decision for candidates with a readable metadata comparison. Other providers exist in the shared search service, but they are not the standard requested discovery methods on this page.

## 2. Product goal and boundaries

### Goal

Help a researcher answer: *“Given this account that I already know, which accounts on the other social platforms might belong to the same person or entity, and why?”*

The desired outcome is an inspectable shortlist, not an automatic identity assertion or a silent write into the artist catalog.

### User story

> As a researcher with one known artist profile, I want to paste its URL and see possible profiles on the two other platforms, along with search sources, identity evidence, verifier verdicts, and limitations, so I can decide which links are credible.

### In scope today

- Single input: an Instagram or TikTok profile, YouTube handle/channel, or Spotify artist URL.
- Eleven clickable preset links fill that input without automatically starting paid discovery.
- Resolve that account's name and handle from its profile metadata.
- Search the **other** supported platforms for profile pages.
- Preserve source information and show multiple alternatives per platform.
- Compare readable profiles using deterministic identity rules and, where possible, JEV.
- Show provider statuses, evidence, error and empty states, time, and estimated cost.
- Automatically save completed single-URL investigations in shared history and reopen stored evidence without another paid search.
- Show live tier 1–3 musician coverage at the bottom, with existing LLM enrichment and this app's saved investigations counted separately.
- Leave final acceptance to a human who can open the actual profiles.

### Out of scope today

- Searching the supplied platform for more profiles in this URL-only flow.
- Accepting a post, reel, short, video, playlist, or arbitrary webpage as the starting identity.
- Treating a candidate as officially authenticated merely because it was found by an LLM or ranks highly.
- Automatic acceptance or update of official artist catalog records **from this page**. Saving an investigation snapshot is not approval of its discovered links.
- Visual face or avatar matching. Image URLs can be captured, but image pixels are not compared.
- Guaranteed resolution of every returned candidate, especially some YouTube `/channel/<id>` candidates.

The shared `/api/profiles/search` endpoint also supports legacy catalog-oriented inputs. The catalog UI is no longer routed, but the underlying data and API remain intact. Do not mistake optional providers or approval flows for behavior that this single-URL page invokes.

## 3. Core terminology: keep these concepts separate

| Term | Meaning | Important caveat |
| --- | --- | --- |
| **Reference / known profile** | The user-supplied profile URL and its resolved metadata. | It is an identity clue, not a candidate result. |
| **Target platform** | One of the other two platforms. | There is a separate site-restricted query for each target in Serper. |
| **Candidate** | A discovered profile-page URL on a target platform. | Its existence does not establish ownership. |
| **Search score (`confidence`)** | A 0–100 discovery/ranking heuristic influenced by result text, provider evidence, and the comparison status. | **Not** a calibrated probability of identity. UI labels it “Search score.” |
| **Identity comparison (`identityComparison`)** | Deterministic comparison of reference and candidate metadata with a 0–100 rule-based score and reasons. | `likely`, `uncertain`, and `mismatch` are heuristic classes. |
| **JEV decision (`jevVerification`)** | External model decision over the comparison and evidence, with a verdict and probability/confidence fields. | Model output is not independent proof or guaranteed ground truth. |
| **Provider status** | `used`, `failed`, or `unavailable` for a provider or verifier. | A search can return some candidates when another provider fails. |

## 4. End-to-end flow

```text
User pastes known profile URL
  ↓
Client and server validate that it is a supported profile page
  ↓
ScrapeCreators reads the reference profile
  → obtain handle, display name (or fallback to @handle), bio, image URL,
    follower count, verified flag when available
  ↓
Exclude the reference platform; select the other two as targets
  ↓
Run Serper's two target-specific searches and Gemini online discovery
  concurrently (plus any explicitly enabled/automatic fallback work)
  ↓
Filter to actual profile-page URLs on target domains
  → rank organic hits → combine Gemini candidates → fallback for missing
    target platforms → deduplicate overlapping URLs
  ↓
ScrapeCreators reads candidate metadata in parallel
  → rule-based identity comparison + evidence or a per-candidate failure note
  ↓
For candidates with a comparison, send comparison + discovery evidence
  to JEV for per-candidate identity decisions
  ↓
Save the investigation snapshot to shared ClickHouse history
  → if storage fails, retain search results with an explicit warning
  ↓
Return candidates, provider report, sources, timestamps, and cost estimate
  ↓
UI groups by target platform, ranks identity evidence above search score,
  and lets a human open profiles and expand the evidence
```

**Not a sequential “find TikTok, then use it to find Instagram” chain.** Serper's Instagram and TikTok searches are distinct requests run concurrently; Gemini receives one discovery request for both target platforms. The results are later combined and compared against the same known reference. A caveat: the two Serper requests share a provider-level `Promise.all`, so an error in one can cause Serper's batch to be marked failed rather than returning its successful sibling's result.

## 5. Input, URL rules, and reference resolution

### User-facing input

- A single URL of a **profile page** on `instagram.com`, `tiktok.com`, `youtube.com`, or an artist page on `open.spotify.com`.
- Instagram: one username path segment, such as `https://www.instagram.com/artistname/`.
- TikTok and YouTube: one `@handle` path segment, such as `https://www.tiktok.com/@artistname` or `https://www.youtube.com/@artistname`.
- `http`/`https` are accepted by the current parser; input is capped at 500 characters.
- YouTube `/channel/UC…` IDs and Spotify `/artist/<id>` links are accepted. Missing URL schemes are normalized to HTTPS; known non-profile paths remain rejected.
- Channel lookup preserves the case-sensitive ID and verifies the returned channel ID before using its canonical handle. Spotify resolves the artist's name through its public oEmbed endpoint; artist IDs are never treated as social handles.
- The client validates for immediate feedback; the server validates again and is authoritative.

### API request from this page

```json
{
  "knownProfileUrl": "https://www.youtube.com/@exampleartist",
  "methods": ["serper", "gemini"]
}
```

The page sends **neither name nor handle**. The server identifies this as the URL-only case when `subject` and `handle` are blank.

### Where “Artist Name” comes from

1. Parse platform and handle from the input URL.
2. Fetch the known account via the appropriate ScrapeCreators profile endpoint:
   - `/v1/instagram/profile?handle=...`
   - `/v1/tiktok/profile?handle=...`
   - `/v1/youtube/channel?handle=...`
3. Confirm the returned handle matches the parsed input handle (case-insensitively). If a profile cannot be read or does not match, do not silently invent an artist identity.
4. Use the returned **display name** as `subject`. If absent, use `@<parsed handle>`.
5. Retain reference metadata so the comparison can reuse it rather than fetching it a second time.

For example, if `https://www.youtube.com/@exampleartist` resolves to display name “Example Artist,” the ordinary Serper queries are shaped like:

```text
Example Artist @exampleartist official site:instagram.com
Example Artist @exampleartist official site:tiktok.com/@
```

The **entire URL is not pasted into these two site-restricted queries**. Gemini's prompt does receive the original known URL and handle as identity clues. The shared search service has a different query format for non-URL-only callers; the examples above specifically describe this page.

### Target restriction

- Instagram reference → search TikTok and YouTube.
- TikTok reference → search Instagram and YouTube.
- YouTube reference → search Instagram and TikTok.
- The server filters candidates and exposed search sources to the target platforms; the UI also excludes the reference platform as a defense-in-depth display rule.

## 6. Discovery providers and their roles

### Serper — deterministic query construction, external search results

- One site-restricted query per target platform, made concurrently to `https://google.serper.dev/search`.
- Uses search location country `us` unless the shared API caller specifies another country; requests up to 10 results per query and disables autocorrect.
- The exact query string is deterministically built from the resolved display name, handle, and target domain.
- Which results Google/Serper returns, their snippets, ranking, and completeness are **external, variable inputs**.
- Calls have a 15-second per-request timeout.

### Gemini — LLM-assisted online discovery

- Called through OpenRouter chat completions with `google/gemini-3.5-flash-lite` and an `openrouter:web_search` tool configured for Exa.
- One prompt asks for official profile URLs on **both** target platforms, supplies the resolved name, known URL, and handle, and asks for structured JSON with URL, title, snippet/evidence, and a model-provided confidence number.
- Requests no invented URLs and no source-platform or post/video URLs; backend URL filtering is still required because prompt compliance is not a security or correctness boundary.
- Its candidate suggestions and confidence are **non-deterministic and unverified until checked**. Gemini discovery is not the JEV identity decision.
- The request has a 20-second timeout.

### ScrapeCreators — metadata resolution and optional fallback

- **Required to start a URL-only search:** resolves the known profile and reads candidate metadata via platform-specific endpoints. A missing `SCRAPECREATORS_API_KEY` makes URL-only resolution unavailable.
- Candidate reads happen concurrently and are individually caught, so a failed read leaves the discovered candidate visible with a note.
- When Gemini has no candidate on one or more target platforms, the backend can call `/v1/find-social-profiles` using the known platform and handle, even though the UI requested only `serper` and `gemini`. This is a **fallback for a missing platform**, not proof of identity.
- The provider report may therefore include ScrapeCreators on a URL-only search.
- ScrapeCreators discovery has a 25-second timeout; each metadata lookup has a 12-second timeout.

### JEV — later identity-decision stage, not a search engine

- Runs via OpenRouter `POST /api/alpha/decisions`, model `typesafe/jev-1.13`.
- Receives the subject, known profile URL, and, for each eligible candidate: URL, discovery methods, the **full deterministic comparison** (including reference and candidate metadata and reasons), and accumulated search signals.
- It answers two questions per candidate: a same-identity probability and a categorical verdict (`verified`, `likely`, `uncertain`, `mismatch`) with verdict confidence/probabilities if returned.
- It receives metadata fields such as image **URLs** and follower counts, not image pixels. Do not claim it performs face recognition.
- A candidate is eligible only when readable metadata produced an `identityComparison`. JEV cannot make a claimed verdict for a candidate whose metadata read failed.
- JEV has a 15-second timeout; on error, the search candidates remain visible, and its provider status is `failed`.
- In the URL-only flow, show JEV as `unavailable` with a reason when not configured or when no candidate has a readable comparison; do not silently omit it.

### Other code paths, not default discovery on this page

The shared backend can also call **Tavily** (search), **SocialCrawl** (platform search), and has another online model-verification path used in other workflows. The `/single-artist` UI requests only `serper` and `gemini` for discovery. Do not describe Tavily, SocialCrawl, or DeepSeek as automatically used by this page. ScrapeCreators reference resolution, its conditional fallback, and JEV verification are separate from the `methods` discovery selection.

## 7. URL filtering, merging, and candidate selection

1. Classify results only when their hosts match supported social domains.
2. In URL-only mode, require profile-shaped paths on one of the **target** platforms. Reject posts, reels, shorts, videos, watch pages, search pages, etc.
3. Rank search-provider organic hits by the discovery heuristic, initially retaining at most 15 organic profiles and at most 5 per platform before Gemini suggestions and fallback candidates are added.
4. Append Gemini suggestions and, when applicable, ScrapeCreators fallback suggestions.
5. Merge duplicate results by platform plus a normalized lowercase URL pathname. A duplicate accumulates methods/signals and gets a small search-score bump.
6. Attempt metadata comparison on **all eligible target candidates in URL-only mode**, including Gemini-only candidates. Previously skipping platforms discovered by Gemini could leave JEV with no eligible input; do not reintroduce that skip.

This deduplication is path-based, not a universal canonical-identity resolver. Different URLs for the same account (for example a YouTube `@handle` and `/channel/<id>`) can remain separate candidates.

## 8. Deterministic discovery ranking

Organic result ranking starts at **48** for a recognized social-domain hit and then applies these rules:

| Search signal | Adjustment |
| --- | ---: |
| All words in the resolved subject appear in title, snippet, or URL path | +28 |
| Some subject words appear | +14 instead |
| The title/snippet/path says “official” | +13 |
| Top-five search-result position | +7 |
| An excluded/non-profile-style path | −24 where applicable |

The result is clamped to **20–99** at this stage. Results from other providers can enter with provider-supplied or inferred scores. Merging the same path across methods adds **5**, capped at 99. A later identity comparison adjusts the final displayed search score: `likely` **+5**, `mismatch` **−12**, `uncertain` **0**, then clamps to **5–99**.

This is a practical ordering mechanism. The UI must keep labeling it **Search score**, not “probability this is the same artist.” A result that says “official” in a snippet is a signal, not proof.

## 9. Deterministic identity comparison

When both profiles have readable metadata, the backend compares the known reference to each candidate. Its score starts at **0** and applies the following rules:

| Identity signal | Adjustment | Qualification / caveat |
| --- | ---: | --- |
| Discovery evidence contains the phrase `link in bio` | +60 | A signal from provider evidence; not itself a cryptographically checked reciprocal link. |
| Display names closely match after lowercasing/removing non-alphanumerics | +35 | Current rule checks whether either normalized name contains the other. |
| Handles match exactly after the same normalization | +35 | Checked before prefix match. |
| Otherwise, handles share a prefix of at least five characters | +20 | Weaker than an exact match. |
| At least two shared bio words of four or more characters | +20 | A missing bio is noted as unavailable, not counted as a mismatch. |
| Candidate profile is verified | +10 | A platform badge is only one signal. |
| Both follower counts present; larger count at least 10,000 and ratio at least 100:1 | **−25** | A major mismatch, but not an automatic veto. |
| Both counts present; larger at least 10,000 and ratio at least 10:1 but below 100:1 | **−10** | A moderate caution signal. |
| Both image URLs present | 0 | Notes availability **for human visual review**, not visual comparison. |

For follower count, the ratio divides the larger count by `max(1, smaller count)` and only uses finite non-negative values. If **either count is absent**, no follower penalty applies; absence is not treated as zero. Reasons show the two counts and note that audiences can differ across platforms. A direct official cross-link or several strong matching signals should be able to outweigh a follower disparity.

The final score is clamped to **0–100** and classified:

- **`likely`** at 55 or above.
- **`uncertain`** at 25–54.
- **`mismatch`** below 25.

Example: two accounts both called “Andrew” can get +35 for matching display names, but 200,000 versus 200 followers yields −25; without other strong corroboration, this is a **mismatch** (10/100). A direct link and exact handle could outweigh the follower-count warning. These are heuristics, not measured error rates.

The response retains the actual reference and candidate metadata, score, status, and human-readable reasons so the researcher can inspect how the rule was applied.

## 10. JEV judgment: what is and is not deterministic

**Deterministic:** building the request structure, choosing eligible candidates, assembling the profile URLs/metadata/reasons/evidence, validating that a returned choice is one of the four allowed verdicts, and showing a missing-verdict or failure state.

**Non-deterministic/external:** the model's assessment, same-identity probability, verdict confidence, and probability breakdown. Even with identical inputs, the service or its interpretation may change. Its probability fields are the **model's output**, not a locally calibrated accuracy guarantee.

JEV's `verified` verdict requires the decision model to select the criterion “a direct official cross-link or uniquely conclusive evidence.” It is **not equivalent to a platform-verified badge**, nor does it replace human confirmation. Do not translate `likely` into “confirmed.”

The page shows JEV results separately from the rule-based identity score. A candidate without readable metadata can still be shown as a discovered profile, but it has **no** JEV verdict.

## 11. API and response contract

### Application endpoint

`POST /api/profiles/search`

The OpenAPI source of truth is `lib/api-spec/openapi.yaml`; generated Zod schemas and client types live in the generated API libraries. Backend entry point: `artifacts/api-server/src/routes/musicians.ts`. The UI uses the generated `searchProfiles` client.

**URL-only request:** `knownProfileUrl` plus `methods: ["serper", "gemini"]` from the page. The shared endpoint also accepts subject/handle/location/country for other callers; those inputs are not exposed by this page.

**Key response fields:**

```text
subject                   resolved name or @handle
query                     generated queries joined for reporting
searchedAt                ISO timestamp
profiles[]                target-platform candidate objects
  platform, url, title, displayUrl, snippet
  confidence              search score, NOT identity probability
  signals[], methods[]     evidence labels and discovery provenance
  identityComparison?      status, 0–100 score, reasons, reference, candidate
  identityVerificationNote? metadata lookup issue, if any
  jevVerification?         verdict, sameIdentityProbability,
                           verdictConfidence, probabilities
sources[]                 returned search-source links
totalFound                backend candidate count
highConfidenceCount       backend count with search score >= 80
methodsUsed[]             method, label, status, durationMs, results,
                           estimatedCostUsd, costNote
estimatedCostUsd          sum of used method estimates
```

`methodsUsed` is the provider audit trail. For this flow expect requested Serper and Gemini plus JEV status; ScrapeCreators can appear if its fallback was invoked. Some metadata calls are not represented as separate discovery-method rows. Cost labels distinguish estimates from JEV's returned OpenRouter usage cost; **the displayed total is not an audited bill for every metadata lookup or external call**.

### Error boundaries

- Malformed request or unsupported profile URL → 400.
- URL-only reference lookup not configured → 503.
- A valid-looking URL whose account cannot be read or whose handle does not match → 422 when the resolver yields no account.
- Unexpected discovery failure → 502.
- Backend search deadline → 504.
- The UI has its own 65-second request abort and shows a retry action.

The backend permits up to **50 seconds of URL-only search work after reference resolution**, further bounded by a **55-second budget from request start**, leaving up to five seconds for initial history setup and insertion within the client's 65-second limit. Storage failure returns discovery results with an explicit warning instead of turning successful discovery into an error. `Promise.race` supplies a response deadline but does not necessarily cancel work already in progress.

## 12. UI requirements and review workflow

The `/single-artist` page:

1. Accepts exactly one supported profile URL and displays which other platforms will be searched.
2. Shows an in-progress screen; its stage animation is **visual timing only, not a live provider-event stream**.
3. Shows the resolved reference, other-platform candidate count, number of high **search-score** candidates, and estimated cost after the response.
4. Groups candidates by target platform. Shows the leading candidate and collapses other possible profiles per platform; shows an explicit no-result message for a missing target.
5. Ranks within the result view primarily by **identity evidence**: JEV `verified`, JEV `likely`, rule-based `likely`, `uncertain`, no comparison, then `mismatch`; search score breaks ties. Thus a high-ranked search result with unreadable metadata does not outrank a reasonably verified candidate solely on the discovery score.
6. Displays platform-colored Instagram/TikTok/YouTube icons, profile links, snippets, evidence chips, methods, identity summaries, JEV summaries, expandable detailed reasons and probabilities, and a copy-URL control.
7. Provides a provider report with used/failed/unavailable status, duration, returned-result count, and cost note, plus source links.
8. On error, retains the entered URL and offers retry. On zero candidates, explains that no other-platform profile was found and offers retry.
9. Labels confidence and verification separately and asks the human to inspect the actual profile before accepting it.

The page automatically saves completed URL-only investigations in `poc_new_verticals.profile_search_history` in the existing ClickHouse database. The table below the input uses `GET /api/profiles/investigations?page=1&limit=20`, refreshes on mount, polls every 30 seconds, and supports pagination and manual refresh. Review restores the stored reference and full response without another search. Each run is a separate shared snapshot. Earlier searches were not saved and cannot be reconstructed. The search response includes `historyId` on successful persistence or `historySaveError` on failure. History does not approve candidates or update official artist catalog records.

`GET /api/profiles/musician-coverage` supplies footer statistics for non-deleted musicians using their latest global tier assignment. Existing LLM coverage means a profile has nonempty platform links in the LLM enrichment source. App coverage means a saved investigation with discovered candidates matches an existing musician through its trusted reference URL. Each musician counts once per source, even after repeated runs. Figures refresh every 60 seconds and are cached briefly server-side; a successful new save invalidates both the server cache and the client coverage query. The two sources are never added together or presented as approval counts.

## 13. Reliability, safety, and privacy constraints

- **Never drop successfully discovered candidates just because a later verifier fails.** Per-candidate metadata errors should attach notes; JEV failure should retain the discovery output.
- External calls have bounded per-call deadlines. Keep provider work concurrent where safe, and do not turn an optional verification step into a blank overall timeout.
- Do not trust LLM instructions or snippets to enforce domain/path restrictions; backend profile-URL validation and target-platform filtering must remain in place.
- Do not accept a source-platform result as a new candidate in the URL-only flow.
- Do not silently present a missing metadata comparison or JEV verdict as an affirmative verification.
- Search titles, snippets, bios, model-generated evidence, and even platform badges can be misleading. A displayed source is provenance to inspect, not an endorsement.
- The known profile URL and scraped public profile data are sent to third-party search, metadata, and model providers as described above. Keep provider credentials server-side; never expose them in the frontend or in this document.
- Treat `verified` as a decision category, not an authorization to act for an artist. Human review remains the final gate.

## 14. Learnings from building this flow

1. **A URL can supply the name.** Resolving the reference's public profile metadata gives the display name and handle; if the name is missing, a handle fallback is explicit rather than guessed.
2. **Search discovery and identity verification must be separate.** A convincing result title or top Google placement is not an ownership claim.
3. **Independent target searches are useful.** Separate site-restricted queries find candidates on each missing platform without using one speculative match as the seed for the other.
4. **LLM discoveries must not bypass checks.** Gemini-only candidates must also be eligible for metadata comparison and JEV. A previous skip for platforms found by Gemini caused JEV to be absent on otherwise successful searches.
5. **Report unavailable verification explicitly.** If the model lacks a key, no candidate metadata can be read, or JEV fails, the researcher needs a visible reason, not a missing provider row or invented verdict.
6. **Prefer verified evidence over an attractive search score in the UI.** Otherwise an unreadable candidate with high discovery rank can hide a more assessable match.
7. **Follower counts are a caution signal, not a proof.** A 200,000-to-200 gap helps reject a name-only false positive, but platform audiences genuinely vary and direct identity evidence should carry more weight.
8. **Partial success matters.** A 404 on one YouTube candidate, a provider timeout, or an absent bio should not discard successful work from other candidates/providers.
9. **Actual image comparison has not been built.** The existence of two profile-image URLs is not evidence that the images match.

## 15. Known limitations and improvement opportunities — not implemented

These are explicitly **not** promises about current behavior:

- **YouTube channel-ID candidates:** `/channel/<id>` can be a legitimate returned candidate, but the current metadata fetch passes the final path segment as a `handle` to ScrapeCreators and may receive 404. That candidate remains visible but cannot receive a rule-based comparison or JEV verdict. Resolve IDs to a canonical handle or support the provider's correct ID lookup before claiming full coverage. Starting `/channel/<id>` URLs are currently rejected.
- **Partial Serper batch failure:** The platform-specific queries are separate and parallel, but a rejection in their `Promise.all` marks the entire Serper method failed and can discard a successful sibling result. Per-target settled results and statuses would give stronger partial-result guarantees.
- **No canonical cross-URL deduplication:** YouTube `@handle` and `/channel/<id>` URLs for the same entity may appear twice.
- **No image-content verification:** If desired, adding real image matching requires a separately specified method, permission/privacy review, false-match analysis, and clear reporting; comparing URL strings or noting image presence is insufficient.
- **Rule-based score is hand-tuned:** Weights, thresholds, and JEV output are not calibrated against a labeled validation dataset. A production identity-quality program would collect reviewed examples and measure false positives, false negatives, and provider coverage by platform.
- **Cost is indicative:** The page's estimated total is not a complete charge reconciliation for every reference/candidate metadata lookup.
- **No reviewer feedback loop on this page:** It does not record accept/reject decisions or feed confirmed matches back into quality evaluation.

## 16. Acceptance criteria for a future change

When modifying or recreating this feature, verify these concrete behaviors:

1. A known Instagram, TikTok, or YouTube `@handle` URL resolves to the actual reference account and uses its display name (or explicit handle fallback).
2. Only the **other two** supported platforms are queried and returned; starting platform and non-profile links never appear as candidates.
3. Serper uses a separate site-restricted query for each target. Gemini receives the known URL as an identity clue and its suggestions are filtered before display.
4. Gemini-only candidates get the same metadata-comparison/JEV opportunity as Serper candidates.
5. Search score, deterministic identity score/status, and JEV verdict/probabilities are distinguishable in API and UI.
6. Both available follower counts are compared; a 200,000-versus-200 disparity lowers a name-only match and the reason is visible. Missing follower data causes no penalty. Strong direct identity evidence can outweigh audience disparity.
7. Metadata failure for one candidate leaves it visible with an explanation; other candidates can still receive JEV verdicts.
8. JEV unavailable or failed is reported explicitly, with discovered candidates preserved.
9. Candidates with credible verification appear before unverified high-search-score candidates within their platform.
10. Error, empty, progress, alternate-candidate, and human-review states are understandable without claiming model certainty.
11. Successful URL-only investigations appear in shared history below the input and survive reloads/new sessions. Review opens the stored result without a new search. Storage failure remains visibly distinct from successful persistence.

## 17. Implementation map

| Concern | Current location |
| --- | --- |
| User input, loading/results UI, evidence and provider report | `artifacts/musician-social-finder/src/pages/SingleArtist.tsx` |
| Shared history table and stored-result review | `artifacts/musician-social-finder/src/components/investigation-history.tsx` |
| Shared investigation snapshot storage | `artifacts/api-server/src/lib/profile-investigations.ts` |
| API routing, reference resolution, credentials, deadline and errors | `artifacts/api-server/src/routes/musicians.ts` |
| Platform definitions, URL rules, search/provider orchestration, identity comparison and JEV | `artifacts/api-server/src/lib/musician-search.ts` |
| Shared request/response schema (edit this before changing the API contract) | `lib/api-spec/openapi.yaml` |
| Generated schemas/client/types | `lib/api-zod/src/generated/`, `lib/api-client-react/src/generated/` |
| Frontend route | `artifacts/musician-social-finder/src/App.tsx` |

**Handoff principle:** Preserve the sequence **known account → independent discovery of missing platforms → deterministic comparison → optional JEV judgment → transparent human review**. Do not let a high search rank, a model suggestion, or a missing provider quietly become an identity claim.