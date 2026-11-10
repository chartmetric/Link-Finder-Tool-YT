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

`provider-credit-stop.spec.ts` also covers paid-runtime credit stops (not catalog
preparation): running → stopping with an in-flight lookup → stopped with untouched
queued work, including mixed-type continuous runs. The sanitized provider/billing
reason must appear in compact progress, RunDetail inside the monitor modal, and
the expanded launch widget, during draining and after reload. Cold saved stops
must not say the user requested them. Closing/reopening the monitor (including
its saved-state refresh) must send no writes: start, stop, and resume are all
counted, and unexpected endpoints remain blocked.

Run only the credit-stop cases with:

```sh
pnpm --filter @workspace/musician-social-finder exec playwright test e2e/provider-credit-stop.spec.ts
```

`run-preparation.spec.ts` covers the detailed run-monitor modal with zero
selected profiles: initial preparation, stage changes and successive catalog
page checks, a stopped/incomplete preparation, and a completed empty selection.
All three profile-type rows are checked. Closing with Close or Escape, restoring
focus, continued polling while closed, and reopening must not issue any API
mutation (including Start, Stop, Resume or paid investigation calls). These cases
enable the fixture harness's read-only guard, which records and aborts all writes.
Run just this coverage with:

```sh
pnpm --filter @workspace/musician-social-finder exec playwright test e2e/run-preparation.spec.ts
```

Screenshots, traces and the HTML report are written under the ignored
`generated-artifacts/run-progress` directory at the workspace root.

`artist-observations.spec.ts` exercises the real saved artist results page with
a checkpoint and a final archive sharing a scope, parent budget, and date, but
different rows, counts, spending, and CSV bytes. It follows the final shortcut,
switches back, and releases held responses in both directions to catch stale
evidence replacing the selected observation. Exact row request paths, archive
IDs, summary amounts, download URLs, filenames and downloaded CSV contents are
asserted. Both projects run in light and dark themes, with bounds checks and
screenshots of the restored checkpoint and final. The read-only fixture guard
aborts all mutations and unknown API/provider calls; no backend is needed.
Because Chromium's native `<a download>` traffic can bypass browser routing,
this suite navigates through a loopback fixture gateway. It serves only the two
known CSV fixtures and forwards allowlisted frontend asset reads to the managed
Vite workflow. Every other API request at the gateway is rejected, never
forwarded. Thus native downloads remain fixture-only too.

```sh
pnpm --filter @workspace/musician-social-finder exec playwright test e2e/artist-observations.spec.ts
```
