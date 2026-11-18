---
name: Saved evidence projections
description: Preserve receipt bytes and historical verdict meanings when projecting saved evidence into coverage.
---

Treat database JSON as a read-only projection, not the original receipt bytes.

**Why:** PostgreSQL JSONB can reorder object keys. Re-serializing its result and
comparing that hash with an original body hash can wrongly discard valid saved
evidence even though its content has not changed.

**How to apply:** Verify receipt bytes at their original archive boundary.
Dashboard projections must preserve receipt references, bind both catalog
identities and the captured canonical channel, and consume the saved assessment.
Do not claim that hashing reserialized JSONB verifies the original receipt.

Preserve the meaning of historical Topic judgments and captured URL aliases.

**Why:** Older Topic support deliberately left artist-management review false
despite supporting the artist's music presence. Also, a requested handle URL can
be correctly captured and assessed under its canonical channel ID.

**How to apply:** Interpret historical judgments by their exact policy meaning;
do not turn a management flag into a universal link-support test. Permit only
aliases bound to that captured channel, never unrelated handles or video URLs.
Keep Topic music presence separate from artist management and live-link approval.

Resolve reused receipt evidence in its original owning archive, not the
continuation's archive or the current working directory.

**Why:** A receipt index is not necessarily a provider payload; its raw-byte
reference can remain relative to the original archive even when reused by a
continuation. Reading the index as a response or rebasing it loses provenance.

**How to apply:** Follow the receipt's original ownership and bounded raw-file
reference, verify the original byte hash and requested resource/artist bindings,
and only then extract evidence. Never substitute a similarly named response.

Keep normalized packet digests distinct from original provider-byte digests.

**Why:** A normalized capture may hash a reconstructed packet containing parsed
data and archive provenance, rather than the original receipt file or provider
response bytes. Those hashes legitimately differ; searching raw files for a
packet digest can incorrectly suggest the evidence is missing.

**How to apply:** Resolve the original receipt by artist, requested resource and
observation time, then verify its own raw-byte reference. Report which boundary
each digest authenticates; do not claim packet-hash equality proves byte identity.
