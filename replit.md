# Profile Finder

Searches Google through Serper.dev and returns the strongest official Instagram, TikTok, and YouTube URLs for people, creators, teams, and brands.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/musician-social-finder run test:e2e` — fixture-only desktop/mobile run-progress browser regressions; requires only the frontend workflow, never a running API or paid credentials
- `pnpm --filter @workspace/musician-social-finder run typecheck:e2e` — typecheck browser tests and Playwright configuration
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `SERPERDEV_API_KEY` — Serper.dev API key
- Optional verification secret: `OPENROUTER_API_KEY` — enables Gemini online cross-checking

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/musician-social-finder` — React frontend
- `artifacts/api-server/src/routes/musicians.ts` — search endpoint
- `artifacts/api-server/src/lib/musician-search.ts` — Serper query, URL classification, and confidence scoring
- `lib/api-spec/openapi.yaml` — API contract

## Architecture decisions

- Serper is called only from the API server so the API key never reaches browsers.
- Results are ranked from name matches, official wording, recognized domains, and Google position, then cross-checked by Gemini in online mode when OpenRouter is configured.
- Users can choose Serper, Tavily, ScrapeCreators, or all discovery methods. Every choice receives separate Gemini and DeepSeek V4 Flash online verification passes; results show provenance and rough per-run cost.
- Searches accept a subject name, a known handle plus its source platform, or both. Known handles use ScrapeCreators `/v1/find-social-profiles` with a 7-day cache preference (0 cached or 10 live credits).
- SocialCrawl is available as a discovery method using its Instagram profile search, TikTok user search, and YouTube search endpoints (normally 3 credits total), followed by both AI verification passes.
- Missing Serper configuration returns an explicit 503 setup state rather than mocked search results.

## Product

YouTube investigations retain metadata-confirmed handle and channel-ID URLs under one account. Channel-ID equivalence is separate from artist ownership; the grouped account receives one artist assessment. Both candidate aliases and starting-profile aliases are persisted in the existing history JSON; older snapshots are not automatically re-resolved. Run API regression checks with `pnpm --filter @workspace/api-server test`.

Search by any public name with optional location and country hints, inspect the best Instagram, TikTok, and YouTube matches, copy URLs, and export results.

## User preferences

## Bulk profiles

- `/bulk` defaults to Brands; `/bulk/brands`, `/bulk/creators`, and `/bulk/artists` browse all current profiles of that type, including multi-type membership, unranked profiles, and zero/multiple active linked accounts. Artists map to `musician`. Tiers are optional enrichment, not the catalog inclusion rule.
- Discovery requires a usable existing public profile link; zero-link profiles are visible but not selectable. Multiple-account profiles retain all active accounts and use a deterministic valid reference, preferring supported social metadata over a generic web page. Manual starts revalidate eligibility; auto-selection skips non-runnable profiles. No name-only paid discovery.
- Selection uses latest profile, account and relationship versions; nullable disconnect/delete values are retained inside `argMax` tuples. The profile page is queried once, then only those bounded IDs are enriched with accounts and optional tiers, avoiding repeated full-catalog ClickHouse CTE expansion.
- Catalog access is read-only. Snapshots append to `poc_new_verticals.profile_bulk_events`, and successful results also go to ordinary history. PostgreSQL supplements ClickHouse with atomic ownership, generation-scoped controls, durable admissions and fenced checkpoints; legacy archive stop events remain readable.
- Paid requests require explicit Start. Manual selections contain at most 25 profiles. Automatic one-shot and continuous launchers accept chunks of up to 1,000 profiles combined across types; the chunk size is not a total spending cap. An optional total distinct-profile cap is frozen at start; failed profiles count, while explicit retries can incur additional charges.
- Users choose 1–20 parallel workers per selected profile type (default 1, maximum 60 concurrent profile lookups across all three types). The run freezes this setting at Start and preserves it through chunks, archives and Resume; legacy runs default to 1. Stop drains every in-flight worker and starts nothing further, including after a persistence error. Resume explicitly retries queued and acknowledged failed profiles, never completed ones or unacknowledged paid requests (`retryBlocked`). Review provider activity before intentionally creating a new run for an uncertain profile. A server restart pauses paid work until explicit resume after lease expiry. Opening a page never launches paid jobs.
- Continuous jobs persist source-ID upper bounds, per-type keyset cursors, archived counters/costs, and only the current chunk. Finished chunks receive deterministic archive IDs before the root clears them; replay after a crash must not overwrite an existing archive. All archives are accessible through paginated saved-chunk links, not just recent runs. Default recent history hides archives.
- Automatic selection conservatively skips previously started/completed/failed bulk profiles across saved history, including interrupted paid attempts; queued-but-unstarted items are not excluded. Catalog/history read failures stop before new payments rather than falling back to repeated work. Single-shot automatic launches use the same remaining-profile selection.
- Snapshot writes across lanes and heartbeat updates are serialized. Duplicate catalog profile IDs across requested types are selected only once. Source catalog records are never reclassified or edited.
- Existing `/api/bulk/brands/*` paths and generated hook names are retained for compatibility. Candidate queries take `profileType`; launch accepts either `profileIds` plus one `profileTypes` entry, or `scopes` with per-type limits. Legacy saved candidates without a type are brands.
- A stale worker lease becomes interrupted after 150 seconds and requires manual resume. Heartbeats renew every 15 seconds using the shared PostgreSQL clock. Stop and Resume require the observed `resumeVersion`; stale controls cannot affect a newer generation.
- Platform outcomes distinguish likely/verified matches, reviewable candidates, completed searches with no supported account, provider failures, and explicit first-party no-account statements. Missing results or search snippets alone cannot confirm account absence.
- Multiple upgraded API processes may share one PostgreSQL primary and ClickHouse archive; only one bulk queue is globally active, with its frozen per-type parallel lanes. Drain old API processes before upgrading. See [worker topology and recovery](docs/bulk-worker-topology.md).

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Live results require `SERPERDEV_API_KEY`; Gemini verification uses `OPENROUTER_API_KEY`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
