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

Search by any public name with optional location and country hints, inspect the best Instagram, TikTok, and YouTube matches, copy URLs, and export results.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Live results require `SERPERDEV_API_KEY`; Gemini verification uses `OPENROUTER_API_KEY`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
