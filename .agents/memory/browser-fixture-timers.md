---
name: Browser fixture timers
description: Why intercepted HTTP success can coexist with a permanently loading UI under a fake browser clock.
---

Do not assume that fulfilled fixture responses have reached the rendered UI when browser timers are frozen.

**Why:** React Query schedules cache notifications through timers. Freezing before initial navigation produced successful intercepted responses but left every section on its loading skeleton, making unrelated browser regressions appear broken.

**How to apply:** Allow scheduled UI notifications to settle before asserting the initial screen. When controlling polling or retry backoff with a fake clock, account for scheduled rendering notifications as well as HTTP completion.
