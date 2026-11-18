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

Final DE submission outputs are immutable. Separate Tier 3 artist-declared
high links from the submission; they need at least one same-channel release
match (title plus date or label) to qualify for a later batch. Never amend the
already-submitted run to add coverage-round results.

**Why:** The user explicitly requested a frozen first submission, a separate
hold list, and later coverage work without changing first-submission files or
rows.

**How to apply:** Use independent output directories and new `final_submit` and
`round2` run IDs; verify frozen output hashes before and after later work.
If a frozen sample lacks detail, add a clearly labeled companion for the same
sample rather than rewriting it. The unchanged table has no run-type column;
record type in the run ID and an external manifest, without altering the schema.

The authorized coverage-round continuation stops at $490 cumulative reserved
spend, including earlier sourcing and QA. It is not a new $75 allowance.

**Why:** The user described roughly $75 remaining but explicitly required
stopping additional no-candidate track searches at $490 total.

**How to apply:** Reserve against the shared ledger transactionally; use at most
three additional primary-credit titles beyond the original searches, and retain
all prior failed/uncertain admissions. Strict single-release review exports must
count medium rows only, not low rows with an annotation.

Reconstruct detailed evidence from saved raw candidates and the frozen artist
catalog, not from compact checkpoint candidate summaries.

**Why:** Operational checkpoints deliberately retain only short verdict summaries;
reading absent match fields as empty produced an incorrect zero-count draft and
an incomplete sample.

**How to apply:** Re-evaluate raw captures offline under the sealed matcher for
evidence exports. Treat missing detailed fields as a signal to reconstruct or
fail explicitly, never as evidence that no tracks matched.

The user explicitly authorized a separate `final_submit_batch2` promotion of the
frozen strict single-release medium candidates. This is an exception for that
submission, not permission to change the automatic matcher's medium-only rule.

**Why:** After reviewing the strong-single sample, the user requested promotion
with evidence level `releases_single_exact`, leaving the original submission
unchanged.

**How to apply:** Exclude profiles with an existing valid high result, reject
foreign catalog ownership and cross-artist channel claims, and keep only the
candidate with the most distinct matching song titles per profile. Send the
other candidates to a separate review export. Insert only selected real highs
under a new run ID, with `catalog_ready` status; preserve batch 1 and all frozen
files. Report combined batch-1/batch-2 distinct-profile coverage against the
frozen eligible denominator, not against all provisional or held highs.

DE sent-submission history is append-only and distinct from candidate/result
history. Before every future final batch, exclude any row whose profile_id
**or** channel_id occurs in any confirmed submission, not merely the latest
result run. Use a separate final_submit_batchN run type for every later batch.

**Why:** The user explicitly requested that neither an artist/profile nor a
channel ever be sent to DE twice.

**How to apply:** Gate preparation and recheck before result insertion and DE
sending; a stale prepared payload must fail closed rather than overwrite frozen
files. Record a batch in the submission ledger only after the user explicitly
confirms that particular batch was sent to DE. Promotion, result insertion and
CSV delivery are not send confirmation. The original first-batch backfill was
explicitly authorized with its original creation timestamp. Never automatically
register pending later batches. Read the ledger across all sent batches and
reconcile uncertain append acknowledgments without resending.

For every future batch, count distinct base songs for title and release
thresholds and candidate ranking. Strip version suffixes such as slowed,
sped up, ultra slowed, nightcore, remix, instrumental, extended, radio edit,
live, acoustic and similar variants before counting.

**Why:** The user explicitly requested this rule so multiple versions of one
composition cannot satisfy a multi-song threshold.

**How to apply:** Count date/label-supported release matches separately from
title-only matches, but deduplicate both by base song. Retain the version-level
evidence for review. Preserve the historical final_submit; retrospective counts
are informational only, not authorization to rewrite or downgrade submitted rows.
