---
name: OpenAPI parameter export compatibility
description: Avoiding duplicate generated parameter exports when adding paginated routes.
---

Keep path-parameter schemas and generated query-parameter type exports unambiguous.

**Why:** The workspace's current Orval setup re-exports both Zod schemas and generated types. An operation combining a run-ID path parameter with cursor query parameters produced colliding parameter exports and failed the shared-library typecheck.

**How to apply:** For new saved-batch pagination, keep the cursor in the path rather than suppressing the type error or hand-editing generated files. If changing parameter conventions, verify both generated exports through the normal codegen/typecheck flow.
