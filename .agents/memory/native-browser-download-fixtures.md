---
name: Native browser download fixtures
description: Why context routing alone is insufficient for safe fixture-only native CSV download tests.
---

Do not rely solely on Playwright context routing to intercept native `<a download>` traffic in Chromium.

**Why:** Native download clicks bypassed the installed context routes in this environment, despite ordinary API reads being intercepted. The browser obtained a generic response rather than the fixture CSV. A browser route guard alone therefore cannot guarantee that download requests stay away from the real backend.

**How to apply:** For fixture-only tests exercising actual download links, navigate through a loopback HTTP fixture gateway. Serve exact fixture downloads there, reject all other API requests and writes, and proxy only explicitly permitted frontend assets. Keep browser routing as a second guard. Verify the real downloaded bytes, not only the anchor's href.
