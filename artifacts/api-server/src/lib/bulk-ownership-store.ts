import { BulkOwnership, type OwnershipStore, type QueueState, type RunRecord, type Transaction } from "./bulk-ownership";

// Lazy import: a missing coordinator fails bulk operations closed, not ordinary searches.
async function connect() {
  if (!process.env.DATABASE_URL) throw new Error("Bulk coordination requires DATABASE_URL. No paid queue was started.");
  return (await import("@workspace/db")).pool;
}
export function createPostgresOwnershipStore(getPool = connect, prefix = "profile_bulk"): OwnershipStore {
// Identifiers are code-owned; a configurable prefix isolates real-DB regression tests.
if (!/^[a-z_][a-z0-9_]{0,45}$/.test(prefix)) throw new Error("Invalid bulk coordination table prefix.");
const queueTable = `${prefix}_queue`;
const claimsTable = `${prefix}_claims`;
const attemptsTable = `${prefix}_attempts`;
let initializing: Promise<void> | undefined;
async function ensureStore() {
  if (!initializing) initializing = (async () => {
    const client = await (await getPool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      // Serialize first-use DDL across replicas too; IF NOT EXISTS alone races in PostgreSQL.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${prefix}_schema`]);
      await client.query(`
      CREATE TABLE IF NOT EXISTS ${queueTable} (
        id integer PRIMARY KEY CHECK (id = 1), state jsonb NOT NULL
      );
      INSERT INTO ${queueTable} VALUES (1, '{"fence":0}') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS ${claimsTable} (
        id uuid PRIMARY KEY, record jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${attemptsTable} (profile_id bigint PRIMARY KEY);
    `);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  })().catch(error => { initializing = undefined; throw error; });
  await initializing;
}
return {
  async transact<T>(id: string, work: (tx: Transaction) => T): Promise<T> {
    await ensureStore();
    const client = await (await getPool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const locked = await client.query<{ state: QueueState }>(`SELECT state FROM ${queueTable} WHERE id = 1 FOR UPDATE`);
      // Read the database clock AFTER obtaining the lock, never the worker's clock.
      const clock = await client.query<{ now: string }>("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now");
      const rows = await client.query<{ record: RunRecord }>(`SELECT record FROM ${claimsTable} WHERE id = $1`, [id]);
      const tx: Transaction = { queue: locked.rows[0].state, record: rows.rows[0]?.record, now: Number(clock.rows[0].now) };
      const result = work(tx);
      if (tx.attempts?.length) await client.query(`INSERT INTO ${attemptsTable} (profile_id)
        SELECT unnest($1::bigint[]) ON CONFLICT DO NOTHING`, [tx.attempts]);
      await client.query(`UPDATE ${queueTable} SET state = $1 WHERE id = 1`, [JSON.stringify(tx.queue)]);
      if (tx.record) await client.query(`INSERT INTO ${claimsTable} (id, record) VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE SET record = excluded.record, updated_at = clock_timestamp()`, [id, JSON.stringify(tx.record)]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  },
  async read(id?: string | string[]) {
    await ensureStore();
    // One statement gives a consistent MVCC snapshot of owner and runs.
    const result = await (await getPool()).query<{ state: QueueState; records: RunRecord[]; now: string }>(`
      SELECT state, (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now,
        COALESCE((SELECT jsonb_agg(record) FROM (
          SELECT record FROM ${claimsTable} WHERE ($1::uuid[] IS NULL OR id = ANY($1))
          ORDER BY updated_at DESC LIMIT 30
        ) recent), '[]'::jsonb) AS records
      FROM ${queueTable} WHERE id = 1`, [id === undefined ? null : Array.isArray(id) ? id : [id]]);
    const row = result.rows[0];
    return { queue: row.state, records: row.records, now: Number(row.now) };
  },
  async attempted(ids: number[]) {
    await ensureStore();
    const rows = await (await getPool()).query<{ profile_id: string }>(`SELECT profile_id FROM ${attemptsTable}
      WHERE profile_id = ANY($1::bigint[])`, [ids]);
    return rows.rows.map(row => Number(row.profile_id));
  },
};
}
export const postgresOwnershipStore = createPostgresOwnershipStore();
export const bulkOwnership = new BulkOwnership(postgresOwnershipStore);
