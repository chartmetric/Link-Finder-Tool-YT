---
name: Instagram capture uncertainty
description: Why provider empty fields must not be treated as Instagram link absence.
---

The user supplied screenshots showing a visible Instagram website absent from
the provider response. Even an explicitly empty provider link list does not
establish that the visible Instagram profile has no link.

**Why:** The user prioritized this generic false-negative correction alongside
artist-owned post evidence, ahead of further bulk-run work.

**How to apply:** Separate provider capture completeness from ownership
verification and link-path resolution. Preserve historical uncertainty rather
than retroactively claiming that a normalized empty array proves source
absence. New capture fallback work requires separately approved spending and
source binding, not an automatic paid retry.
