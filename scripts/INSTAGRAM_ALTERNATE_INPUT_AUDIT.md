# Alternate verifier input audit

This audit is offline only. No provider calls, link imports, acceptance changes,
new model results, or accuracy claims are authorized by these fixtures.

## Contracts

| Path | Input contract |
| --- | --- |
| `instagram-alternate-verifier.mjs`: `requestFor`, historical `prepare` branches | Historical formatter. The original baseline retains workflow labels. `factsOnlyDecision` reproduces the old ablation, including its deliberate removal of path status and ownership assessment. Do not silently change these historical comparisons. |
| `instagram-jev-label-ablation.mjs`: `sourceFactsOnly`, `prepareLabelCases` | Historical paired experiment. The baseline is the hash-bound archived request; the old ablation additionally removes album status. Its name does **not** make it the current source-only contract. |
| `instagram-broader-facts-validation.mjs` | Historical alternate-model validation using the original facts-only ablation; retained unchanged for reconstruction. |
| `instagram-alternate-verifier.mjs`: `sourceOnlyRequestFor` | Explicit new-input entry point. Removes candidate workflow comparison status/reasons only; preserves source resolution and unknown ownership. Does not replace the historical CLI branches. |
| `instagram-20-answer-check.mjs`: `answerCheckVariants` | Newly assembled pairs from saved evidence. “baseline” means baseline questions, **not** replayed historical bytes. Both baseline and ownership-rubric inputs exclude workflow comparison labels and retain source uncertainty. Grading labels/proofs stay outside these request bodies. |
| `instagram-frozen-jev.mjs` | Exact transport, not a request builder or sanitizer. Checks the complete body's hash and byte limit before dispatch, then archives that body and hash. Intentionally label-bearing history must remain unchanged. Clean new inputs before hashing. |
| `instagram-official-site-evidence-check.mjs` | Controlled extension of a hash-bound archived baseline with website observations. Not a fresh source-only reconstruction; preserves baseline state/questions while adding source evidence. |

`withoutWorkflowJudgments` is deliberately field-specific. Do not recursively
delete every `status`, `reason`, or occurrence of “likely”/“mismatch”: these can
be source-resolution states, catalog binding facts, or literal source text.
Unknown ownership (`unassessed`) is not a negative identity judgment.

## Offline regression fixtures

Run `pnpm --filter @workspace/scripts test:instagram-source-only`.

`fixtures/instagram-alternate-request-input.json` is synthetic, not an archived
capture or a real ownership adjudication. It includes opposite workflow labels,
source text containing verdict words, reference and candidate path uncertainty,
album binding status, exact catalog links, source rows and provenance.

The tests pin the original formatter and historical ablation outputs with fixed
hashes. New builders must be invariant to changing/removing workflow labels and
must preserve **all** remaining state. A mock-only transport checks estimator,
dispatch bytes, archived bytes and hashes for both labeled history and newly
constructed variants, and rejects changed/oversized requests before any fetch.
These checks cannot establish improved model recall or recover an old decision.
