---
name: Model alias resolution
description: OpenRouter Decisions can return a dated release for a requested model alias; avoid replaying an already charged response.
---

OpenRouter Decisions may report a concrete dated model release even when the
request used a stable alias. A different response string is not necessarily a
different model family.

**Why:** A valid, billed response to the requested JEV alias was initially held
because its response named the dated release. The answer and billing receipt
were already saved; repeating that request would have charged unnecessarily.

**How to apply:** Preserve both requested and resolved names. Bind the answer
to the exact request and evidence, and explicitly allow only verified alias
resolutions, not arbitrary prefixes or unrelated models. Inspect a surprising
resolution using its existing archived receipt. Before continuing untouched
work, reconcile all admitted requests, retain reservations, fence the ended
worker, and reuse the already returned response without dispatching it again.
