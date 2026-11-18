# DE YouTube submission safety

The sent-submission ledger is
`poc_new_verticals.youtube_link_submissions`. It is append-only; never update,
delete, alter or drop its rows. Creating result rows in
`poc_new_verticals.youtube_link_matches_test` does **not** mean they were sent
to DE.

## Preparing a new batch

1. Give each batch its own run type: `final_submit_batch2`,
   `final_submit_batch3`, and so on. Generate a fresh, never-reused run ID.
   The historical first batch is `final_submit`.
2. Apply the evidence and ownership checks, then call
   `gateFutureSubmission` from `scripts/src/youtube-submission-ledger.mjs`.
   It reads the current ledger and excludes a row if **either** its
   `profile_id` **or** its `channel_id` has already been submitted. It also
   removes repeated profiles/channels within the pending batch.
3. Save excluded rows separately for review. Freeze only the eligible payload.
4. Re-read the ledger immediately before inserting a prepared final result
   batch. If new overlaps appear, fail closed and prepare a new run with the
   overlapping rows excluded; never rewrite an already-frozen payload.
5. Recheck the ledger immediately before sending an export to DE, too.
   Serialize sending and confirmation; multiple pending batches are not proof
   that either has been sent.

## Recording a sent batch

- **Wait for the user's explicit confirmation that this particular batch was
  sent to DE.** A promotion approval, CSV download, result-table insertion, or
  request to prepare a batch is not that confirmation.
- `confirmedSubmissionRows` defaults to rejecting unconfirmed recording.
  Preserve the confirmation note with any append admission.
- Use the original batch/run IDs and confirmed submission timestamp. The
  initial backfill was specifically authorized to use first-batch creation
  time, retaining UTC microseconds.
- Read the current ledger again, exclude prior profiles/channels, persist and
  sync the exact append payload/admission, then append once.
- After a timeout or temporarily empty ClickHouse readback, **reconcile with
  SELECT only**. Never resend an admitted append.
- Batch 2 remains pending and must not be appended until the user confirms it
  was sent.

MergeTree does not enforce a uniqueness constraint. The shared gate and the
serialized send/confirmation process provide the duplicate protection; direct
SQL that bypasses them is not an approved submission path.
