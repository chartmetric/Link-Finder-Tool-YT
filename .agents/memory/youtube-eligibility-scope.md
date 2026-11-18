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
