---
name: Offline operations isolation
description: Safety boundaries for exercising one-time campaign operations without changing frozen dependencies.
---

Test one-time campaign operations through an external fixture harness rather than
adding test-only hooks to dependencies frozen by an active paid run.

**Why:** The authorization command imports shared modules that transitively import
network helpers even when no network operation is requested. Rejecting those
harmless imports prevents exercising the operation at all; merely mocking fetch
does not block other network transports.

**How to apply:** Replace the database connector at the test process boundary,
strip inherited credentials, and fence actual network operations. Preserve archive
path spellings as well as contents when copying fixtures: relative path bindings
must resolve inside the disposable working directory.
