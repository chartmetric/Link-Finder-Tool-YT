# Shared, read-only campaign progress

The API reads the compact snapshot from the existing App Storage bucket, under
`artist-batch-exports/v1/campaign-progress/full-tiers-1-5-no-ig-usd100.json`.
It never reads the workspace campaign directory, starts workers, imports paid
executors, changes budget coordination or retries paid requests. Deployments
must use the same existing bucket as the workspace (not a development-only
database). No evidence records, account metadata or credentials are copied.
Frozen Tier 1–5 counters are mirrored alongside the headline and validated to
sum to it. Older snapshots without tier counters, or unverifiable optional tier
bindings, keep the headline and explicitly mark tier details unavailable.

## Safe introduction boundary

Do **not** edit `generated-artifacts/run-full-tiers-campaign.mjs`, its child
runner, or any file in its frozen fingerprint while the campaign is active.
The writer is a separate observer process, outside that fingerprint. Its only
campaign access is reading the approved queue, approval, claim, progress and
checkpoint files. Introducing it is an observer-only boundary: it does not
restart, pause, resume or signal the campaign. It can be launched alongside an
existing campaign without changing the worker's code or spending authorization.

Explicitly bind the observer to the current approval before launching it:

```sh
pnpm --filter @workspace/api-server run campaign:publish-progress --publish \
  --campaign-id=full-tiers-1-5-no-ig-usd100 \
  --queue-sha256=9d7abb7e11a718f465725115d46b678afeb50a114cba1efc61c921aab0364928
```

For continuous mirroring, add `--watch` to that same command, in a separate
workspace observer process. The `Artist campaign progress observer` workflow
uses this explicit, approval-bound command. It saves counters every 15 seconds. Never attach
the observer to the published API's startup or a paid worker's frozen scripts.
The default one-shot command is also the safe initial seed at this boundary.
It validates the queue hash, whole-queue count, approval hash in the existing
claim, campaign identity, and original $100 cap before writing. Partial or
unreadable files stop the observer without replacing the last shared snapshot.
Restarting this **observer** is safe; it is not a campaign resume or paid retry.
Concurrent writers and older/regressing counters fail closed, without retry.

Stop the observer with SIGTERM/SIGINT independently of the campaign. Do not
fabricate a new worker timestamp when stopping it.

## Freshness and recovery

`capturedAt` records the observer save time. `updatedAt` is the last actual
campaign/checkpoint file modification, not a heartbeat from the website.
After two minutes without new worker evidence, a last-recorded active state is
explicitly stale, even if the observer continues uploading or the API restarts.
Recent checkpoint activity is not proof of a live worker connection. The worker
is always identified as external to the website, in the workspace.

A missing shared object returns no recorded campaign; storage authorization,
read failures and corrupt snapshots return an error rather than invented zeros.
The UI retains already loaded numbers on a refresh failure with a warning.
API caches are short-lived and freshness is recomputed on every read.

The observer has no authority to start/recover paid work. If the workspace
worker is gone, the published page continues showing the same campaign,
whole-queue denominator, counters and likely-match rate as a stale snapshot.
Restoring work requires the existing campaign's separately authorized recovery
procedure, not this progress feature.
