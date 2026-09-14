---
name: Partial enrichment results
description: Reliability rule for multi-provider profile discovery and verification.
---

Multi-provider enrichment must return completed discovery results even when another provider or verifier times out or fails.

**Why:** Providers have materially different and variable response times. A single route-level deadline previously converted useful completed work into a blank 504 response.

**How to apply:** Give external calls bounded per-provider or per-stage deadlines, run independent verifiers concurrently, record each method's status, and keep the overall route deadline only as a final safety net.