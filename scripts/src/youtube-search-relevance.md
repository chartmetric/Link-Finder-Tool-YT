# Music-specific YouTube discovery preparation

This changes mutable source for **future, separately approved** execution only.
It does not authorize another pilot, a retry, resealing an old runtime, or resuming
the stopped full campaign. Do not edit the pilot archive or any frozen runtime.
Legacy approvals do not contain the new discovery policy version and are rejected
by the updated entry points. Existing sealed executors and their approvals remain
unchanged.

The incoming preparation-only workflow is retained: a fresh bounded test ID
creates an unapproved plan, then requires separate explicit approval of that
exact plan and its $2 cap before frozen-runtime execution. Search planning does
not bypass this approval step. Catalog Instagram references and per-artist
channel-ID deduplication remain enabled.

## Wording and context

With only the catalog name available, the proposed request is:

```text
"ODF" (music OR musician OR songs OR band) YouTube channel site:youtube.com
```

There is still exactly one search request with `num: 10`. No spelling fallback,
translation lookup, query expansion request, or automatic retry was added.
At most two **sourced** alternate names can be included in the same request.
Canonical spelling and non-Latin scripts are preserved.

Each alternate name records both catalog identities, its source, and its kind.
Chartmetric names must bind to the exact `cm_artist`; explicit aliases also need
both identities and a source record reference. A linked Last.fm handle is marked
as an account handle, **not a confirmed identity alias**. Search suggestions and
translations are never silently promoted into aliases.
Incoming bound Spotify display names retain their account IDs and source-record
hashes; punctuation/spacing-only channel-name variants remain ranking clues.

Bound label and release context breaks ranking ties, rather than becoming a
mandatory query restriction. This avoids hiding sparse artists or channels whose
descriptions omit their country or label. Spotify releases must bind to an exact
linked artist URL; catalog tracks must bind to the exact `cm_artist`. Country
context is retained but does not boost a two-letter substring match.

## Ranking, not verification

Whole-term canonical matches precede sourced alternate-name matches. Music
signals and matching bound releases/labels improve relevance; provider order
breaks remaining ties. Unmatched names remain ambiguous, including possible
translations such as the saved `島民` → `islandman` result.

Clear visual-art results with no matching name or music signal are retained in
`offTargetCandidates`, not sent for paid channel capture. Topic-looking results
are retained separately in `topicCandidates` and never substituted for ordinary
artist-controlled channels. These are search-level labels, not new captured
channel facts. Existing ownership verification remains authoritative.

The bounded pilot still selects at most two ordinary candidates, **after**
ranking. The campaign and discovery-only runner remain bounded by ten results.
The existing admission, reservation, model, and no-retry safeguards are unchanged.
The complete parsed channel pool and ranking explanations remain in saved artist
records, even when a candidate is outside the capture limit.

Empty organic results, generic pages, off-target-only results, and Topic-only
results are distinct outcomes. None proves channel absence or a wrong identity.
Missing/malformed provider results still fail instead of becoming a no-match.

## Offline evidence and checks

`fixtures/youtube-search-pilot.json` contains small recorded receipt projections
with original query echoes and source receipt references. The islandman case
records only its observed title/URL; its omitted snippet is not reconstructed.
Synthetic ranking/alias/context cases in the test file are explicitly separate.

Run without invoking any campaign:

```sh
node --test scripts/src/youtube-search-plan.test.mjs \
  scripts/src/youtube-discovery-test.test.mjs \
  scripts/src/youtube-campaign.test.mjs \
  scripts/src/youtube-bounded-test-gate.test.mjs \
  scripts/src/youtube-ownership-policy.test.mjs
```

The saved ODF/Pencing/Cytrena echoes equal the submitted generic queries.
That supports a relevance diagnosis, not proven request substitution. Offline
re-ranking confirms that the unrelated drawing channels are excluded from paid
capture selection; it **cannot demonstrate retrieval gains for the new query**.
Those gains remain unmeasured unless a separate bounded search is authorized.
