# Run progress browser regressions

Start the existing `artifacts/musician-social-finder: web` workflow, then run:

```sh
pnpm --filter @workspace/musician-social-finder run typecheck:e2e
pnpm --filter @workspace/musician-social-finder run test:e2e
```

The default URL is the workspace preview domain, falling back to
`http://localhost:80`. Override with `E2E_BASE_URL` for another frontend host.
The suite uses Chromium; on Replit it uses
`REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Elsewhere, install the matching
browser with `pnpm --filter @workspace/musician-social-finder exec playwright install chromium`.
An API server, database, provider credentials and paid credits are **not needed**.

## Safety and determinism

- Every browser context blocks service workers and intercepts all HTTP traffic
  before the first navigation. Known API routes return in-memory fixtures;
  unknown API calls are aborted and fail the test. No API route can fall through
  to the real server. External requests are also aborted.
- Start clicks exercise the real mutation and rendering code, but their POST
  responses come exclusively from fixtures. Opening/reloading saved fixtures
  asserts that no Start POST occurs.
- Each test has an isolated context/storage. Run counters and errors change
  explicitly in the fixture, not according to the speed of a provider.
- The browser clock advances polling and retry backoff deterministically.
  Request counters prove polling continues for active roots and stops for
  terminal runs/archives, without relying on wall-clock sleeps.

Both desktop (1440×1000) and mobile (390×844) projects exercise all scenarios.
Tests cover all three Start sources, focus/scroll behavior, compact responsive
layout, successful and failed profile counts, cumulative continuous progress,
archives, scope navigation/reload, stale/initial errors and Retry, terminal
polling, uncapped/scanning progress and reduced motion.

Screenshots, traces and the HTML report are written under the ignored
`generated-artifacts/run-progress` directory at the workspace root.
