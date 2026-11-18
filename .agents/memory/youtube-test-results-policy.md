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
