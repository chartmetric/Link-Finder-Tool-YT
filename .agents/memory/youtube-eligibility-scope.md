---
name: YouTube sourcing eligibility
description: User-defined artist selection and the distinction between channels and YouTube for Artist pages.
---

For the YouTube artist list, use musician/global tier records and each profile's
own most recent record by `argMax` over `(computed_at, updated_at)`, whenever it
was computed. Keep latest tiers 1–3. Require an existing, undeleted profile with
`cm_source = 'cm_artist'`.

Exclude a profile only for an active linked YouTube channel URL:
`youtube.com/channel/...`, `youtube.com/@...`, `youtube.com/c/...`, or
`youtube.com/user/...`. A `charts.youtube.com/artist/...` YouTube for Artist page
is not a channel; keep the profile and record that page URL.

**Why:** The user explicitly replaced the single-latest-global-timestamp
selection and required channel pages to be distinguished from artist-chart
pages. Missing songs or earlier attempts are not eligibility exclusions.

**How to apply:** Freeze exact profile/Chartmetric identities and the UTC date
of the selected tier computation. Export unique Chartmetric IDs separately.
Report profile rows and unique artist IDs separately, including the number of
profiles sharing an ID with another profile. Do not infer eligibility from a
generic nonempty YouTube-platform URL.

Do not infer channel absence from only the account/link representation when
another catalog link representation is also in scope.

**Why:** An audit found active standard channel URLs in `profile_links` for
profiles kept by a freeze built from account links alone. Other legacy rows
used noncanonical `/channel/<handle>` URLs and need separate treatment.

**How to apply:** Reconcile current authorized link sources and preserve
profile/Chartmetric identity bindings. For eligibility, the user explicitly
requires treating `/channel/<handle>` paths as channel links too: exclude their
profiles and list those noncanonical URLs separately for later cleanup.
Do not silently repair them into canonical IDs or rewrite source links.
If a prompt requires an existing freeze unchanged, report conflicts and get
permission before rebuilding it; a corrected freeze is a separate version.

Do not require the earlier Kid Reverie / “Haunt Me” control check for the v3
campaign. Source validation was accepted from the full Casper coverage counts.

**Why:** The user explicitly removed that check because the control artist is
outside eligible-artists-v3 and therefore correctly absent from the supplied files.

**How to apply:** Do not delay this campaign for another source control. Log
source anomalies and keep affected links in review while continuing eligible work;
retain all budget, no-retry and stop safeguards.
