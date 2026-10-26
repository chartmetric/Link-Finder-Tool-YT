# Profile Finder

Searches Google through Serper.dev and returns the strongest official Instagram, TikTok, and YouTube URLs for people, creators, teams, and brands.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
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
- Catalog access is read-only. Run snapshots and separate stop events are appended to `poc_new_verticals.profile_bulk_events`; successful results also go to ordinary investigation history.
- Paid requests require explicit Start, at most 25 profiles combined. Manual selections use one type; the floating launcher auto-picks bounded per-type batches. One profile per type runs concurrently (at most three), with sequential processing within each type. Stop finishes all current in-flight profiles; Resume explicitly retries unfinished/failed profiles, never completed profiles. Opening a page or restarting the API never launches paid jobs.
- Snapshot writes across lanes and heartbeat updates are serialized. Duplicate catalog profile IDs across requested types are selected only once. Source catalog records are never reclassified or edited.
- Existing `/api/bulk/brands/*` paths and generated hook names are retained for compatibility. Candidate queries take `profileType`; launch accepts either `profileIds` plus one `profileTypes` entry, or `scopes` with per-type limits. Legacy saved candidates without a type are brands.
- A stale worker heartbeat becomes interrupted after 150 seconds and requires manual resume. A new resume generation must never inherit a stop flag from an older snapshot.
- Platform outcomes distinguish likely/verified matches, reviewable candidates, completed searches with no supported account, provider failures, and explicit first-party no-account statements. Missing results or search snippets alone cannot confirm account absence.
- Operate the bulk runner with a single active API worker. Cross-process active-run checks are advisory, not an atomic distributed lease; add durable distributed claims before scaling workers.

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Live results require `SERPERDEV_API_KEY`; Gemini verification uses `OPENROUTER_API_KEY`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
