---
name: OpenAPI URL formats
description: Compatibility constraint between OpenAPI code generation and the installed Zod version.
---

Avoid adding an OpenAPI URI format to string fields unless code generation is verified against the installed Zod API.

**Why:** The current generator emitted a top-level URL validator that the installed Zod version does not provide, causing generated-library typechecking to fail.

**How to apply:** Use bounded string validation for URL-like identity hints, or verify generated output before adopting URI format annotations.