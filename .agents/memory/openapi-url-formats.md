---
name: OpenAPI URL formats
description: Compatibility constraints between OpenAPI code generation and the installed Zod version.
---

Avoid adding an OpenAPI URI format to string fields unless code generation is verified against the installed Zod API.

**Why:** The current generator emitted a top-level URL validator that the installed Zod version does not provide, causing generated-library typechecking to fail.

**How to apply:** Use bounded string validation for URL-like identity hints, or verify generated output before adopting URI format annotations.

Integer schemas, including bounded input and response fields, can also generate unsupported top-level Zod validators.

**Why:** The generator emitted `zod.int()` while this workspace uses Zod 3. This is a generator/runtime compatibility issue, not an application integer-validation failure.

**How to apply:** Inspect and typecheck generated output whenever adding numeric types or formats. Use the existing number schema convention when needed, and enforce integers explicitly with server validation for pagination and worker counts rather than assuming generation preserves integer checks. Min/max bounds do not prevent this incompatibility.