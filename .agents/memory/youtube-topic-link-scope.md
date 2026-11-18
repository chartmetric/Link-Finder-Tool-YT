---
name: YouTube Topic link scope
description: User-approved inclusion of Topic channels as separately labeled artist music-presence links.
---

Include supported YouTube Topic channels in link-sourcing results, clearly marked **Topic — auto-generated**. Keep them distinct from artist-managed channels.

**Why:** After reviewing RADIXNT's Topic exclusion, the user explicitly said, "include topic channels, but mark them as so clearly." Their link-sourcing goal is broader than artist-owned channels alone.

**How to apply:** Use the Topic-inclusive policy when preparing new YouTube work, within a fresh exact scope and spending approval. Require evidence tying a suggested Topic channel to the exact catalog artist; a matching name alone remains a candidate. Preserve shared-channel and music-ID conflicts. Display unresolved Topic leads with their uncertainty, and label the channel type in UI and exports. Do not silently rewrite historical ownership decisions, upgrade old success counts, or modify sealed workers. This approval does not authorize catalog writes or additional paid calls.

Auto-generated-channel help links are not unique evidence of an artist Topic
page or a release collection. Keep ambiguous release-titled captures unresolved,
not automatically rejected as the wrong artist.

**Why:** The offline accuracy review found release-titled captures with empty
descriptions and only search-snippet artist attribution. That supports
uncertainty about channel type, not a definitive collection classification.

**How to apply:** Distinguish URL alias binding, artist identity and channel
type. Do not let search wording or auto-generation badges settle all three.
Keep any proposed correction separate from historical suggestion labels.

For the Topic release-bridge experiment, catalog credit `ordering = 0` means
the primary artist; `1` and higher mean featured or co-credited artists.

**Why:** The user explicitly supplied these catalog semantics. A featured
catalog credit must not establish that another artist's Topic channel is the
featured artist's recording home.

**How to apply:** Require primary-credit agreement in both catalog tracks and
YouTube art-track credits when applying the approved experiment's release
bridge. This does not activate the experimental matcher in sourcing paths.

The Tier 1–3 catalog-ready YouTube campaign must stop after its 200-artist trial
and wait for explicit user approval before a full run, even when projected costs
fit the approved budget.

**Why:** The user requires the trial sample to be checked by hand first and
explicitly removed automatic continuation.

**How to apply:** Deliver the trial report and trial-sample-30.csv, then wait.
Do not interpret the overall spending cap as full-run approval.

Historical experimental Confirmed grades are not exemptions from a newer
catalog-ready acceptance gate.

**Why:** Earlier experiments preserved some confirmations based on channel
biographies rather than multiple qualifying release matches.

**How to apply:** Re-evaluate every catalog-ready candidate under all currently
approved gates; reuse old receipts as evidence, not old grades as ground truth.

For the revised Tier 1–3 trial, title-only evidence needs at least three
distinct qualifying titles for high confidence; two titles qualify only for
medium confidence. Release evidence needs at least two qualifying releases
for high confidence, or exactly one for medium. High still requires all shared
name, primary-credit, non-release-channel and cross-artist duplicate checks.

**Why:** The user replaced the earlier trial prompt and its special two-title
fallback with explicit high/medium confidence rules.

**How to apply:** Do not reactivate the earlier Path 3 two-title high-confidence
gate. Treat declared artist links and YouTube for Artist evidence according to
the revised prompt, with no inherited experimental grades.
