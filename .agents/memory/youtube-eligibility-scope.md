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
profile/Chartmetric identity bindings. Distinguish standard channel IDs and
handle URLs from malformed channel paths. If a prompt requires an existing
freeze unchanged, report conflicts and get permission before rebuilding it.
