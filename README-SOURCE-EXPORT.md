# Profile Handles Online — source-code export

This ZIP contains the current frontend, API server, shared libraries, scripts, tests, documentation, package manifests, and lockfiles. The component-preview workspace is included because it is part of this pnpm workspace.

## Setup
1. Install Node.js and pnpm.
2. From this directory, run `pnpm install --frozen-lockfile`.
3. Configure your own database, provider credentials, and storage access as required by the features you use. Credentials and saved database/campaign data are NOT included.
4. Start the API: `PORT=3001 pnpm --filter @workspace/api-server run dev`.
5. In another terminal, start the frontend: `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/musician-social-finder run dev`.

These are the existing package entrypoints, not a promise of a standalone deployment: API routing/proxying and Replit-managed storage or connector services may need configuration outside the original workspace. See replit.md and the source configuration for project details.

The root build command is `pnpm run build`. Tests are included in the relevant packages. Python utilities have their dependency metadata in pyproject.toml and uv.lock.

## Excluded
Secrets/environment files, installed dependencies, Git history, internal agent memory, uploaded attachments, exported research data, raw campaign receipts, generated outputs, and active Replit workflow configuration. Replit artifact metadata is retained as source context. No searches or paid jobs were launched to create this ZIP.

CAUTION: research and campaign scripts can call paid providers and write data when explicitly invoked. Merely unzipping this archive does not run them. Configure and review those scripts before use.
