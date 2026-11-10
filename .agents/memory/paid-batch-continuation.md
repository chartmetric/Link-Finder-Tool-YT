---
name: Paid batch continuation
description: Distinguish acknowledged provider failures from uncertain requests and preserve a single approved spending ceiling across continuations.
---

A completed, archived HTTP server-error response may be recorded as an
unsuccessful paid attempt and skipped while other artists continue. Do not retry
that artist's request. Funding, authentication, rate-limit failures, missing
receipts, and uncertain network outcomes remain stop conditions.

**Why:** One provider server error should not discard successful evidence or
prevent untouched artists from being processed. But retrying an admitted request
can charge twice, and a failed response does not establish that no account exists.

**How to apply:** Preserve the failed receipt and its conservative charge.
Classify it as incomplete evidence, not an identity mismatch or confirmed absence.
Keep estimated charges separate from provider-reported usage.

When continuing an ended attempt under the same approval, permanently retire its
unused spending allocation before granting replacement child allocations.
Preserve all historical reservations and bound the combined old and replacement
ceilings by the original approval. Never replenish an earlier pilot or batch.

**Why:** A fresh full ceiling after every interrupted attempt silently increases
the user's approved maximum, even if each individual executor stays under its cap.

**How to apply:** Reconcile every prior admission under a transactional fence,
retain its reserved charges, and prevent the retired request scope from admitting
anything else. A missing response can only be explicitly abandoned and permanently
excluded from replay, with its charge still reserved; it cannot be treated as
untouched work. Continue only untouched requests, reuse exact-account captures,
and stop if budget or admission reconciliation is uncertain.

In a continuation, check usable archived profiles before collecting more metadata.

**Why:** Collecting the entire cohort first left usable evidence unscored whenever
an unrelated provider error stopped the metadata stage.

**How to apply:** Freeze the cached-profile checks first, then collect untouched
profiles and check those separately. Partition the original verification
allocation between these groups; never grant each group a fresh full allowance.

Saved admission journals and provider receipts can be ahead of the shared spending
ledger after a workspace interruption. Missing ledger rows are not proof that
the corresponding requests were never sent.

**Why:** Recovery found completed, archived provider calls absent from the
transactional admission records. Trusting only the database would have understated
past reservations and allowed duplicate or excess spending.

**How to apply:** Compare exact admission keys and conservative charges across
both stores before continuing. Fail closed on disagreement, preserve the mismatch
evidence, and obtain operator approval before backfilling the ledger. Never lower
reservations, clear uncertainty, or grant a fresh full ceiling to make counts agree.
