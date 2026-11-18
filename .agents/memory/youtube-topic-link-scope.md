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

For the current Tier 1–3 v3 campaign, finish and deliver the 200-artist trial,
then automatically continue the full eligible list under a new run_id and the
same $500 ceiling. The earlier requirement to wait after the trial was revoked.

**Why:** The user explicitly replaced the manual approval gate with an
unattended trial-to-full-run instruction.

**How to apply:** Send the trial report and trial-sample-30.csv as soon as ready,
without delaying the already-authorized full continuation. This authorization
is specific to this campaign, not permission for unrelated future campaigns.

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

If fewer than 100 trial artists have YouTube for Artist URLs, include all that
do and fill the 200-artist sample randomly from the others, maintaining
proportional tier allocation. Reduce the manual sample's minimum five
`youtube_for_artist` links to the number actually available.

**Why:** The user explicitly authorized this adjustment rather than blocking
the trial when the artist-page stratum is undersized.

**How to apply:** Use the newly reconciled freeze, preserve earlier freezes,
report the actual stratum sizes, and do not invent URLs or sample rows.

Casper's supplied catalog channel URLs are a separate `catalog_channel`
evidence source, joined by cm_artist. They qualify as high only after all
shared name, first Topic credit, non-release-channel and duplicate checks pass.
Do not spend a song or name search on an artist with a supplied catalog channel.

**Why:** The user explicitly approved these supplied channels as a high-capable
source, without exempting them from rules a–d.

**How to apply:** Use the latest full Casper track and links files for untouched
artists. Preserve earlier paid work, keep failed or ambiguous catalog channels
in review, and never infer acceptance or ownership from the URL alone.

An HTTP 200 response from a YouTube Charts artist URL is not proof that artist
data or a channel was returned. The initial document can be only the client-side
application shell, with no artist channel URLs or channel IDs.

**Why:** Saved lookups returned the generic Charts application HTML; the plain
HTTP reader did not execute the JavaScript that populates artist data. Counting
successful fetches as channel resolutions made this method's progress misleading.

**How to apply:** Count HTTP fetches, extracted channel leads, verified channel
bindings and high results separately. A cached result or inherited high link
from another method is not a new artist-page success.

Executing the Charts page JavaScript in a real headless browser can still
lead to a Google reCAPTCHA challenge rather than artist data.

**Why:** The browser pilot's inspected rendered example showed an image
challenge, despite successful navigation and JavaScript execution. Empty
main-frame text was not evidence that the artist or channel did not exist.

**How to apply:** Inspect rendered evidence and frames, not only HTTP status or
main-document text. The user subsequently **permanently disabled YouTube for
Artist for this campaign**: no CAPTCHA solving, browser retries, or other
workarounds. This supersedes the earlier conditional browser-resumption approval.
Continue the other approved sourcing methods, not artist-page recovery.

A `strong_single_release` flag is a review annotation, not permission for a new
catalog-ready grade. It needs exactly one release supported jointly by matching
title, date within one day, label/℗, exact channel name and first artist credit.

**Why:** The user requested a stricter annotation for existing and future evidence,
with no extra sourcing requests, and explicitly held these candidates at medium.

**How to apply:** Cap flagged candidates at medium/review; never upgrade a
hard-rule failure from low. Preserve raw receipts and historical runs. Do not
collect more evidence solely because an annotation lowered an old high grade.
