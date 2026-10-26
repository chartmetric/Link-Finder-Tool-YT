---
name: Partial enrichment results
description: Reliability rule for multi-provider profile discovery and verification.
---

Multi-provider enrichment must return completed discovery results even when another provider or verifier times out or fails.

**Why:** Providers have materially different and variable response times. A single route-level deadline previously converted useful completed work into a blank 504 response.

**How to apply:** Give external calls bounded per-provider or per-stage deadlines, run independent verifiers concurrently, record each method's status, and keep the overall route deadline only as a final safety net.

Starting-profile metadata is a prerequisite, not three separate platform searches. Retry a deadline failure at that stage only, never the whole paid investigation.

**Why:** A short seed-profile deadline caused failures before discovery began, while repeating the same error across all target platforms made it look as though every platform independently failed. Retrying the whole pipeline would also risk duplicate provider charges.

**How to apply:** Keep the starting lookup's longer deadline and single timeout-only retry separate from downstream candidate-verification budgets. Identify the starting platform in errors and explicitly say other platforms were not searched. Invalid profiles and authentication failures must not trigger automatic retries.