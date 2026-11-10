# Saved-batch charging safety tests

Ordinary tests do not start PostgreSQL. The integration suite is skipped unless
the exact opt-in flag is `1`:

```sh
pnpm --filter @workspace/scripts test:instagram-saved-batch-gate

INSTAGRAM_SAVED_BATCH_PG_INTEGRATION=1 \
  pnpm --filter @workspace/scripts test:instagram-saved-batch-gate
```

The opt-in suite requires local `initdb` and `pg_ctl` binaries and a non-root
user. It starts a disposable PostgreSQL server on a private Unix socket with TCP
disabled. It never reads `DATABASE_URL`, connects to an existing server, imports
a paid provider transport, or gives child processes provider credentials.
`pg` resolves within the scripts workspace.

Each invocation creates uniquely named test-only schemas, including a
sacrificial copy of the original pilot ledger with synthetic history. Tests
compare that history before and after saved-batch operations. Only these owned
schemas are dropped; the private server is then stopped and its temporary
directory removed. Tests never seed, truncate, or alter application budgets or
existing claim rows.

Coverage includes two processes blocked on a real row lock, duplicate admission
keys, lost acknowledgements after real claim/reservation commits, changed scope
hashes, and worker death both before dispatch and after a fake charge. The fake
provider checks the admission journal before recording a dispatch. Uncertain
reservations and owners must survive every restart attempt without another
dispatch.

Lost acknowledgements are deterministic client-side fault injection **after**
PostgreSQL successfully commits, not a simulated database or a live network
outage.
