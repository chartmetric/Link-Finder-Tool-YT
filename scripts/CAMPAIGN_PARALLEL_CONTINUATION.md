# Approved parallel continuation

This operator-only continuation keeps the original platform scope, denominator,
spending ledger, immutable results and sealed verification policy. It does not
merge another task or adopt a new acceptance rule. The user's explicit approval
is “Speed up; resume YouTube too”, under the existing uncapped authorizations.

Three artists in the same earliest pending tier can run at once per platform.
The subsequently approved Instagram speed-up uses eight rolling slots instead:
`--rolling-approved` is accepted only for Instagram. A finished slot can start
the next queued artist without waiting for its peers; higher tiers remain blocked
until every queued or in-progress lower-tier artist is finished. This approval
does not resume YouTube.
Each artist's requests remain sequential. An admission is permitted alongside
another request only when that exact operation is registered live by this owner;
unknown or abandoned admissions block all new dispatch. A failed lane immediately
closes the dispatch gate, then waits for other in-flight responses to be saved
before stopping. No charged request is automatically retried.

Preparation reconciles all prior receipts and journal entries against the
transactional ledger, binds completed results, rejects uncertain admissions and
already-paid queued artists, and requires an ended worker with no in-progress
artists. It seals a new runtime and writes an execution supplement. Launch checks
that the entire coordinator is unchanged, transfers ownership once, and preserves
the original approval hash so read-only observers continue publishing normally.
It never changes an old approval or resets completed/failed artists.

```
node scripts/src/campaign-parallel-resume.mjs --prepare-approved instagram
node scripts/src/campaign-parallel-resume.mjs --prepare-approved youtube
node <printed-phase>/runtime/campaign-parallel-resume.mjs --run-approved --uncapped-approved <printed-phase>
```

For an explicitly approved Instagram speed handoff, first drain the previous
three-worker phase without cancelling requests or resetting artists:

```
node scripts/src/pause-instagram-for-speed.mjs --handoff-approved <previous-phase>
node scripts/src/campaign-parallel-resume.mjs --prepare-approved --rolling-approved instagram
node <printed-phase>/runtime/campaign-parallel-resume.mjs --run-approved --uncapped-approved <printed-phase>
```

The handoff locks the coordinator and requires both zero pending admissions and
zero in-progress artists before stopping the old owner. The new phase reconciles
the entire ledger and takes ownership exactly once. Never kill an active worker
to increase concurrency. Progress-file writes are serialized across rolling slots.
Rolling selection also excludes every locally prepared artist until its task
settles, including artists whose database claim is still waiting for a connection.
Database queued state alone is not proof that a rolling slot has not selected it.

The further approved Instagram speed-up uses `--buffered-approved` together with
`--rolling-approved`. It prepares at most 64 same-tier catalog contexts per read
group and supplies 16 independently refilled paid slots. Buffered entries have no
claims or paid admissions; a stop discards the in-memory buffer and leaves their
queued rows untouched. Account metadata and ownership decisions remain sequential
within each artist and retain the original sealed policy. Progress-file summaries
are throttled to five seconds; result and billing commits still happen immediately.

```
node scripts/src/campaign-parallel-resume.mjs --prepare-approved --rolling-approved --buffered-approved instagram
```

The user's noon-Pacific deadline escalation adds `--deadline-approved` to that
Instagram preparation command. This sealed profile starts at 32 slots, increases
to 64 after one minute and to 128 after two minutes, with at most 192 prepared
contexts (below the existing metadata policy's 250-artist limit). Each provider
kind has a separate 50 ms admission-start spacing. This is burst protection, not
a promise of provider capacity or deadline completion. All original stop rules,
receipt checks and no-replay rules still apply.

Capacity references checked before escalation:
- https://scrapecreators.com/enterprise recommends below 500 concurrent requests
  and states no account-level concurrency ceiling.
- https://serper.dev/index publishes paid-tier rates starting at 50 queries per
  second; this profile's search admission pacing is more conservative.
- https://openrouter.ai/docs/api/reference/limits notes that upstream model
  providers can impose their own limits. The existing funding/auth/rate-limit
  stop remains authoritative; no automatic retries are added.

Run each approved sealed worker as its own background task with keep-alive.
Do not re-run a launched phase. Another stopped continuation requires a newly
approved handoff and fresh reconciliation; it cannot clear uncertain requests.
YouTube's original pause record remains historical; the new supplement records
the user's subsequent explicit resume approval. Catalog links are not written.

Metadata already saved for untouched artists is reused only after checking the
catalog identity and current per-platform eligibility. Independent read-only
catalog queries run in groups of three. Provider requests still retain their
original finite timeout, response bounds, conservative two-cent reservations,
receipt binding, and funding/authentication/rate-limit stop conditions.

```
node --test scripts/src/campaign-parallel.test.mjs scripts/src/instagram-tier-priority.test.mjs scripts/src/youtube-campaign.test.mjs
```
