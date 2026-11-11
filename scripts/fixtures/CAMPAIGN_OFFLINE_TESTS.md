# Offline uncapped campaign recovery fixtures

Run from the workspace root with Node 24:

```sh
node --test scripts/src/instagram-campaign-uncapped.integration.test.mjs \
  scripts/src/instagram-campaign-recovery.test.mjs \
  scripts/src/instagram-campaign-budget.test.mjs \
  scripts/src/instagram-stopped-batch-recovery.test.mjs \
  scripts/src/instagram-saved-batch-gate.test.mjs
```

The integration fixture runs the actual uncapped authorization CLI in a temporary
working directory. Its import hook replaces only the database connection module
with a strict synthetic ledger. The subprocess inherits no credentials or database
configuration, rejects `pg` imports, and blocks HTTP/fetch/socket operations.
No production module, generated paid runner, or live archive is modified.

The fixture keeps the CLI's relative archive paths inside that disposable working
directory. Tests are sequential because those paths are part of the recovery
binding and the tests temporarily change working directory.

Coverage includes:

- Retired capped children, an explicitly abandoned charged timeout, scattered
  deferrals, untouched placeholders, and incomplete preparation directories.
- Supplemental null-cap approval, stale plans and owners, historical child replay
  rejection, a single stubbed paid admission, and a subsequent recovery.
- Preserved original approval, receipts, reservations and admission keys; unchanged
  whole-queue denominator; unique untouched work in frozen relative order.
- Malformed authorization and supplemental evidence rejected before mutations;
  exact opt-in and exclusive approval-file creation.
- Unlimited parent allocation with bounded children, frozen request validation,
  cap exhaustion, stopped-gate fencing, and no duplicate stub dispatch.

The ledger double recognizes only statements used by these operations, records
attempted SQL, snapshots transactions, enforces duplicate keys, and rolls back on
failure. It is not PostgreSQL and does not establish cross-process row-lock
behavior or filesystem/database crash atomicity.
