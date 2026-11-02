---
name: Provider test observations
description: Avoid false positives when testing provider phases and partial-result handling.
---

Capture request observations in provider mocks, then assert them after the pipeline returns instead of asserting inside a mocked fetch.

**Why:** Provider failures are intentionally caught so completed results survive. An assertion thrown inside fetch can be mistaken for a provider failure and swallowed, giving false confidence in stage ordering.

**How to apply:** Record URL, current stage, signal and request counts in mock calls. Assert those observations outside the provider's error-handling boundary, and include the existing fallback discovery calls in expected request counts.
