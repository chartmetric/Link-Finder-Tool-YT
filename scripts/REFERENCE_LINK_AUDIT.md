# First-party reference-link regression check

From the workspace root:

```sh
pnpm --filter @workspace/scripts run check:reference-links
pnpm --filter @workspace/scripts run test:reference-links
```

Both commands are offline, bounded and repeatable. They need no secrets, network,
database or generated artifacts. The first prints a deterministic JSON report and
exits nonzero on a regression. The second also exercises negative and boundary
cases. No production fetch allowlist, identity threshold, importer or model is
changed. The script's historical paid audit mode is separate; these commands do
not enable it.

To additionally verify the original saved local records (when available), from
the workspace root:

```sh
node scripts/src/instagram-reference-label-audit.mjs --check-reference-links --verify-reference-archives
```

This checks the archived JSON bytes against committed hashes, timestamps, source
URLs, profile IDs and observed hrefs. Missing or altered archives fail explicitly;
there is no network fallback.

## Evidence limits

The small fixtures reproduce exact observed hrefs for Aimee Carty, ERNEST and The
Format from the 2026-11-09 audit. The archived readable extraction omitted both
account links for each. **Original HTML bytes were not retained.** The icon markup
and duplicate tracking aliases are reconstructed test scaffolding, not captured
HTML or proof of the historical DOM layout. The report keeps the reconstructed
HTML hash separate from each original body hash and archive-file hash, and retains
both original observation times. It does not validate a source's present-day state.

The negative Linktree fixture reconstructs global tools navigation and “Explore
other Linktrees” promotions from the saved readable record. Synthetic exact-target
anchors test that even matching IDs on an unapproved host cannot establish
first-party reference evidence. This check does not attempt link-aggregator
support or follow promoted links.

## Extraction contract

Only reviewed first-party page URLs may supply reference evidence. A bounded tag
scanner reads direct anchor hrefs, including SVG/icon-only anchors, while ignoring
comments, scripts, templates, raw text and redirect wrappers. It accepts only
safe HTTPS Instagram account and Spotify artist URLs, compares complete IDs, and
deduplicates tracking/fragment/host aliases while preserving observed hrefs.
It does not execute JavaScript or discover more pages. Limits: 1 MB input,
20,000 tags, 1,000 anchors, 4,096 bytes per href.

Both exact IDs must be present for `expected_links_found`. Rejected sources,
failed/truncated captures, empty HTML or missing IDs never establish absence.
`needs_source_review` is unresolved evidence, not “no official account.”
Empty readable text is explicitly non-authoritative. Matching a reference pair
does not establish account ownership, calibrate model accuracy or approve an
import. New reference targets require separate source review, not a page-title
match or a link-aggregator recommendation.
