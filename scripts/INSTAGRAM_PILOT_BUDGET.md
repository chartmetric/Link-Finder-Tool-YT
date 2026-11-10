# Shared original Instagram pilot ceiling

The original ceiling is **1,000 conservative reserved cents** across the pilot,
reference research, and verification experiments. This is reservation enforcement,
not reconciliation against provider charges. Existing per-run limits still apply.
No providers, prices, model decisions, catalog records, or verified-link claims are
changed by the coordinator.

The separately approved research batches allowlisted by `createPilotBudget`
retain their existing independent spending caps and admission journals. They
neither consume nor expand the original pilot ledger. An unrecognized batch
identity or missing batch safeguards cannot opt out of the original-pilot gate.

## Admission and recovery

- Live `createPilotBudget` calls require the same PostgreSQL `DATABASE_URL` used
  for existing transactional bulk coordination. Tables are separate from bulk
  queue/claims and ClickHouse. There is no local-lock or journal-only fallback.
- Admission locks the original ceiling row, atomically records the reservation
  and increments both run and shared totals, then commits **before** the local
  fsynced journal and provider dispatch. Lock/connection/storage failures stop
  new work. Transactions are never automatically retried.
- `authorization.priorReservedCents` must equal the shared total when claiming
  a run. A stale summary cannot initialize, reset, or decrease that total. Two
  runs may claim the same current checkpoint before either spends; their later
  reservations still serialize against the one shared ceiling.
- `authorization.runId` is an exclusive, permanent logical experiment identity.
  Legacy frozen manifests without it use a deterministic full-manifest SHA-256,
  not the journal filename. The two named audit/check scripts set explicit IDs.
  Claims have random owner credentials, but no leases, takeover, resume, or TTL.
  Changing output directories cannot replay a claimed named experiment.
- Reservation keys are unique within each run. Returned packets, failures,
  timeouts, process death, uncertain commit acknowledgement, and failed local
  journal writes **never refund** a reservation. Even pre-dispatch failures stay
  reserved conservatively. A duplicate run cannot start again, even at a fresh
  checkpoint. No recovery path automatically replays paid work.
- `sharedBudget` in snapshots is the shared total at `observedAt`, not a final
  provider invoice. The two audit/check summaries use that observation, not a
  hardcoded prior total plus local spending. `databaseWrites:0` still refers to
  business/catalog data; `coordinationWrites:true` explicitly identifies ledger
  writes.

## Deliberate cutover (not performed by this change)

Live runs fail closed until an operator installs and reviews the shared
checkpoint. Do not run old/journal-only code alongside upgraded processes.

1. Stop and drain every old experiment process. Review **all** original-pilot
   admission journals, including crashes and uncertain dispatches, without
   issuing provider calls. Count conservative reservations, not reported costs.
   Do not use a single historical script summary as proof of the latest total.
2. Review that count and identify all historical logical run IDs (or frozen
   manifest hashes). Preserve those identities as already claimed so a new
   directory cannot replay an old experiment.
3. With explicit operator approval, install the tables described by
   `pilotBudgetSchemaSql` in `src/instagram-pilot-shared-budget.mjs` (also tracked
   in `lib/db/src/schema/pilot-budget.ts`). Seed exactly one ceiling row with ID
   `musician-instagram-pilot-2026-11-05`, cap `1000`, and the reviewed total.
   Seed historical run rows with their old reservations and original per-run
   caps, and retain historical admissions. All historical run owners must be
   inert fresh UUIDs, not credentials handed to workers. Do not sum these rows
   back into the ceiling: the seed total already includes them.
4. If totals or identities cannot be reconciled, or the reviewed total exceeds
   the ceiling, **do not seed or launch**. Resolve evidence and authorization
   separately. Never default to zero, pick a stale checkpoint, reset a row,
   delete claims, or increase the original ceiling.
5. Future approved manifests must carry that observed checkpoint. A stale
   rejection requires deliberate review of the updated ledger and scope, not
   an automatic refresh-and-retry. A new ID is a genuinely new approved
   experiment, never a recovery mechanism for an uncertain old request.

The code intentionally has no automatic seed, backfill, migration, or paid-run
command here. Merely applying the schema does not authorize spending.

## Offline verification

`node --test scripts/src/instagram-pilot-shared-budget.test.mjs` starts a
disposable local PostgreSQL instance on a private Unix socket (requires
`initdb`/`pg_ctl`). It never uses `DATABASE_URL`, application tables, or paid
providers. Forked workers receive no provider credentials. Tests exercise real
concurrent transactions and process death, not just in-process Promise locks.
