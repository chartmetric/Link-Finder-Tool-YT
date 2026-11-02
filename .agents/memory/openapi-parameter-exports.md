---
name: OpenAPI parameter export compatibility
description: Avoiding duplicate generated parameter exports when adding paginated routes.
---

Keep path-parameter schemas and generated query-parameter type exports unambiguous.

**Why:** The workspace's current Orval setup re-exports both Zod schemas and generated types. An operation combining a run-ID path parameter with cursor query parameters produced colliding parameter exports and failed the shared-library typecheck.

**How to apply:** Check both generated export sets when choosing parameter names. Verify changes through codegen and the shared-library typecheck rather than suppressing errors or hand-editing generated output.
