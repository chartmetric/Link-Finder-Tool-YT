import {randomUUID} from 'node:crypto';

export const ORIGINAL_PILOT_BUDGET_ID = 'musician-instagram-pilot-2026-11-05';

// Same PostgreSQL coordinator and bounded transactions as bulk-ownership-store,
// but separate tables: never touch bulk queue/claims or ClickHouse.
// Schema/seed installation is deliberately NOT performed by live admission.
export const pilotBudgetSchemaSql = `
CREATE TABLE instagram_pilot_ceilings (
  id text PRIMARY KEY,
  cap_cents integer NOT NULL CHECK (cap_cents = 1000),
  reserved_cents integer NOT NULL CHECK (reserved_cents BETWEEN 0 AND cap_cents)
);
CREATE TABLE instagram_pilot_runs (
  budget_id text NOT NULL REFERENCES instagram_pilot_ceilings(id),
  run_id text NOT NULL,
  owner uuid NOT NULL,
  cap_cents integer NOT NULL CHECK (cap_cents BETWEEN 1 AND 1000),
  reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents BETWEEN 0 AND cap_cents),
  PRIMARY KEY (budget_id, run_id)
);
CREATE TABLE instagram_pilot_reservations (
  budget_id text NOT NULL,
  run_id text NOT NULL,
  admission_key text NOT NULL,
  cents integer NOT NULL CHECK (cents >= 0),
  profile_id text NOT NULL,
  kind text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (budget_id, run_id, admission_key),
  FOREIGN KEY (budget_id, run_id) REFERENCES instagram_pilot_runs(budget_id, run_id)
);`;

export function createPostgresPilotCoordinator(pool) {
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const {rows} = await client.query(
        'SELECT * FROM instagram_pilot_ceilings WHERE id = $1 FOR UPDATE', [ORIGINAL_PILOT_BUDGET_ID]);
      const ceiling = rows[0];
      if (!ceiling || ceiling.cap_cents !== 1000) throw Error('Shared pilot checkpoint is missing or invalid; no dispatch.');
      const result = await work(client, ceiling);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error; // Unknown COMMIT outcomes are never retried.
    } finally { client.release(); }
  }
  const snapshot = c => ({budgetId: c.id, maxSpendCents: c.cap_cents,
    reservedSpendCents: c.reserved_cents, observedAt: new Date().toISOString()});
  return {
    async claim({runId, priorReservedCents, maxSpendCents}) {
      if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(runId)
        || !Number.isInteger(priorReservedCents) || priorReservedCents < 0
        || !Number.isInteger(maxSpendCents) || maxSpendCents < 1 || maxSpendCents > 1000) {
        throw Error('Explicit run identity and shared reservation checkpoint required; no dispatch.');
      }
      const owner = randomUUID();
      const shared = await transaction(async (client, ceiling) => {
        if (ceiling.reserved_cents !== priorReservedCents) throw Error('Stale shared pilot checkpoint; no dispatch.');
        await client.query(`INSERT INTO instagram_pilot_runs (budget_id, run_id, owner, cap_cents)
          VALUES ($1, $2, $3, $4)`, [ceiling.id, runId, owner, maxSpendCents]);
        return snapshot(ceiling);
      });
      return {runId, owner, shared};
    },
    async reserve({runId, owner, key, cents, profileId, kind}) {
      if (!Number.isInteger(cents) || cents < 0) throw Error('Invalid shared reservation.');
      return transaction(async (client, ceiling) => {
        const {rows} = await client.query(`SELECT * FROM instagram_pilot_runs
          WHERE budget_id = $1 AND run_id = $2 FOR UPDATE`, [ceiling.id, runId]);
        const run = rows[0];
        if (!run || run.owner !== owner) throw Error('Exclusive pilot run identity lost; no dispatch.');
        if (ceiling.reserved_cents + cents > ceiling.cap_cents
          || run.reserved_cents + cents > run.cap_cents) throw Error('Shared approved dollar ceiling reached; no dispatch.');
        await client.query(`INSERT INTO instagram_pilot_reservations
          (budget_id, run_id, admission_key, cents, profile_id, kind) VALUES ($1,$2,$3,$4,$5,$6)`,
        [ceiling.id, runId, key, cents, profileId, kind]);
        await client.query(`UPDATE instagram_pilot_runs SET reserved_cents = reserved_cents + $3
          WHERE budget_id = $1 AND run_id = $2`, [ceiling.id, runId, cents]);
        await client.query('UPDATE instagram_pilot_ceilings SET reserved_cents = reserved_cents + $2 WHERE id = $1',
          [ceiling.id, cents]);
        ceiling.reserved_cents += cents;
        return snapshot(ceiling);
      });
    },
    snapshot: () => transaction(async (_client, ceiling) => snapshot(ceiling)),
  };
}

export async function connectPilotCoordinator() {
  if (!process.env.DATABASE_URL) throw Error('Shared pilot coordination requires DATABASE_URL; no dispatch.');
  const {default: pg} = await import('pg');
  const pool = new pg.Pool({connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000, max: 2});
  return {...createPostgresPilotCoordinator(pool), close: () => pool.end()};
}

// Historical fixed-model comparisons use different conservative prices than
// JEV. Keep those prices/providers unchanged while sharing the original cap.
export async function claimFixedPilotRun(authorization) {
  const coordinator = await connectPilotCoordinator();
  try {
    const claim = await coordinator.claim(authorization);
    return {
      reserve: admission => coordinator.reserve({...claim,...admission}),
      snapshot: coordinator.snapshot,
      close: coordinator.close,
    };
  } catch (error) { await coordinator.close(); throw error; }
}
