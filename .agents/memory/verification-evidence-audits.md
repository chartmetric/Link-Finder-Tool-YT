---
name: Verification evidence audits
description: Distinguish original verifier inputs from reconstructions and synthetic fixtures.
---

Do not attribute an archived model result to a request reconstructed with a newer serializer. Keep source-path availability, account ownership, model disagreement and application acceptance separate.

**Why:** Historical completion packets can lack outgoing input bytes, while subsequent question changes and provenance repairs change both evidence interpretation and request size. A complete music-ID path does not establish how the historical model received it or prove that a wording repair fixes its score.

**How to apply:** Prefer archived request bodies and hashes when available; explicitly label reconstructions otherwise. Measure the whole serialized request including every candidate and typed question against the existing byte cap. Fixture decisions test the acceptance contract, not model accuracy. A new paid evaluation always needs its own approval and exclusive journal.
