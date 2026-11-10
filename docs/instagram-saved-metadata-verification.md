# Verify archived candidates with saved catalog details

This research-only command never discovers candidates, refreshes Instagram metadata,
queries the catalog, imports links, or changes application acceptance. It adds
source-dated context to a **copy of an actual archived model request**. Profiles
without an original verifier packet are not silently reconstructed or searched.
Candidates, reference accounts, model, and answer criteria stay frozen. The only
question change is an explicit warning that supplemental text is untrusted context,
not instructions or independent ownership proof.

## Prepare without spending

```sh
node scripts/src/instagram-saved-metadata-verification.mjs --prepare \
  generated-artifacts/instagram-bulk-shadow-approved-250-usd20 \
  generated-artifacts/new-saved-metadata-plan.json
```

Preparation reads the batch's approved manifest, supplemental overlay and saved JEV
requests. It checks their hashes and exact profile/account bindings. The default
scope is at most 25 artists and 25 requests, one per artist, with a conservative
reservation of two cents per call. The reusable preparation function accepts smaller
or larger explicit bounds up to 250, never an unbounded cohort.

The plan records source-file hashes, historical request dates, original and augmented
request hashes, exact candidate URLs, complete augmented inputs and held cases.
No evidence is removed to fit: a request exceeding 6,000 bytes is held, as is missing
usable context. Existing source dates and profile/platform ambiguity warnings remain
attached to context; saved metadata does not establish ownership.

## Execute only after separate spending approval

The old batch approval does **not** authorize these new calls. Obtain explicit user
approval for the exact plan, number of calls and ceiling. Record that approval in
a new JSON file with:

- `approved: true`, `approvedBy: "user"`, and `source`: the actual approval reference
- `planSha256`: the hash emitted by preparation
- `runId`: a new lowercase alphanumeric/hyphen approval identifier, 8–80 characters
- `maxSpendCents`: an integer covering the plan's reservation, at most 1,000
- `verificationOnly: true`, `noImports: true`

Never manufacture approval from metadata availability, a plan file or an earlier
research batch's budget. Each run ID represents a distinct user authorization;
changing it to retry an uncertain request requires another explicit approval.

```sh
node scripts/src/instagram-saved-metadata-verification.mjs --run-approved \
  generated-artifacts/new-saved-metadata-plan.json \
  generated-artifacts/explicit-saved-metadata-approval.json
```

Execution re-prepares and compares the entire plan before creating a transport.
It needs only the configured OpenRouter credential. It creates an exclusive directory
under `generated-artifacts/instagram-saved-metadata-verification/<runId>` and the
existing exclusive, fsynced admission journal. No automatic retries or resumes are
allowed. All calls are sequential, bounded by a 20-second timeout, 15-minute wall
time, the input ceiling and approved spending reservation. A failed or uncertain
call stops the run and retains its reservation. Do not delete the output directory
or journal to bypass replay protection.

Outputs are supplemental research results only: a saved scope/plan, actual outgoing
request packets, per-artist responses and a summary. Original evidence and original
decisions remain untouched. Even a favorable new model answer is **not** an approved
link, ground truth, import authorization, or activation of experimental acceptance.
Reservations are conservative bounds, not provider-reported charges.

Regression checks (fixture-only, no paid calls):

```sh
node --test scripts/src/instagram-saved-metadata-verification.test.mjs
```
