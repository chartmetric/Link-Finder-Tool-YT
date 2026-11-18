---
name: YouTube sandbox result run policy
description: User-required run isolation and real-results-only rules for the YouTube test table.
---

For `poc_new_verticals.youtube_link_matches_test`, every insert must carry a
`run_id`. Use a new `run_id` for every run or re-run, and never reuse one.
Anything reading results from the table must use the latest `run_id`.
Never insert rows that are not real results, including setup or dummy rows.

**Why:** The user said rows cannot be deleted and explicitly required these
rules when authorizing creation without a test insert.

**How to apply:** Preserve run isolation in future writers and result readers.
Do not combine historical runs or treat a prior run ID as reusable. The exact
requested schema has no constraints enforcing this policy; do not imply that
the policy is database-enforced or alter the schema without authorization.

The Tier 1–3 trial and any later full run share one $500 paid-request ceiling.
A new output `run_id` does not reset that ceiling.

**Why:** The user approved a hard cap for the whole task, not a separate
allowance for each run.

**How to apply:** Carry trial reservations and charges into any separately
approved full-run continuation. Preserve uncertain charges and never infer
full-run authorization from unused funds.

For the authorized v3 campaign, run unattended with safe defaults and no
clarification questions. Record ambiguous links as review, record and skip
failed requests, and report artists done, high links and spend every 1,000
artists. On an explicit `STOP`, stop new dispatch, finish already-sent requests,
save a checkpoint, and stop without automatically restarting.

**Why:** The user explicitly requested unattended execution, automatic
checkpoint recovery without paying twice, and this stop behavior.

**How to apply:** Keep the job alive independently of the chat/browser, preserve
the request-key index and shared budget, and never replay uncertain admissions
or reset charges on restart. Explain progress and stop controls in run-status.md.

Automated QA must not pause or restart the full sourcing worker. Run compatible
audits alongside it; defer paid steps if the existing coordinator cannot safely
share admissions. QA charges also belong to the same $500 ceiling.

**Why:** The user explicitly prioritized uninterrupted overnight completion while
requesting known-answer and fresh-capture checks.

**How to apply:** Keep known-answer channels hidden from discovery inputs and
QA runs separate from newly sourced missing-channel results. Report source/cohort
differences, separate same-channel from supported different-type Topic matches,
and do not report an accuracy interval until results exist.

For this campaign, acknowledged rate-limit errors trigger a concurrency step-down
and cooldown, not a replay of the failed paid request.

**Why:** The user explicitly authorized adaptive backoff during the overnight run.

**How to apply:** Continue untouched work safely after cooldown. Preserve failed
and uncertain reservations and the overall cap; this does not authorize retries.

Fresh QA captures need an explicitly authorized capture-purpose identity in both
the logical resource key and the local request hash. A new resource key alone is
not sufficient when the spending ledger also uniquely indexes transport hashes.

**Why:** A fresh check collided with earlier transport hashes before admission,
even though it used its own resource namespace.

**How to apply:** Keep the provider URL unchanged and put the fresh-purpose
identity in local admission metadata only. Preserve prior inputs and receipts,
reuse successful post-sourcing QA captures, and never replay failed or uncertain
paid captures. Prove a blocked request was never admitted before continuing it.
Do not weaken ordinary discovery deduplication to repair QA.

Known-answer precision cannot be extrapolated to evidence branches missing from
the benchmark, even when the benchmark uses the exact same pipeline.

**Why:** Already-linked musicians predominantly yielded artist-declared matches,
whereas missing-channel sourcing predominantly relied on release evidence.

**How to apply:** Report evidence mix, source coverage and tier-specific results
alongside the confidence interval. Fresh consistency checks test whether
captured metadata remains present, not independent artist-identity accuracy.
