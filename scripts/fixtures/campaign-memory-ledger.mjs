// Deliberately narrow SQL double: unknown statements fail, never reach a DB.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export function campaignMemoryLedger(initial) {
  let state = structuredClone(initial), snapshot;
  const calls = [];
  async function query(text, args = []) {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({sql, args: structuredClone(args)});
    const rows = value => ({rows: structuredClone(value)});
    if (sql === 'BEGIN') {
      assert.equal(snapshot, undefined, 'Fixture transactions must be sequential.');
      snapshot = structuredClone(state);
    } else if (sql === 'COMMIT') snapshot = undefined;
    else if (sql === 'ROLLBACK') {
      if (snapshot) state = snapshot;
      snapshot = undefined;
    } else if (sql.startsWith('SET LOCAL ')) {
      // Transaction-local limits have no side effects in this double.
    } else if (sql.startsWith('SELECT id,scope_sha256,cap_cents,owner FROM instagram_campaign_budgets')
      || sql.startsWith('SELECT * FROM instagram_campaign_budgets')) {
      return rows(state.parent.id === args[0] ? [state.parent] : []);
    } else if (sql.startsWith('SELECT b.id') || sql.startsWith('SELECT b.*')) {
      assert.equal(args[0], state.parent.id);
      const children = [...state.children].sort((a, b) => a.id.localeCompare(b.id));
      return rows(sql.startsWith('SELECT b.id')
        ? children.map(({id, scope_sha256, cap_cents, reserved_cents}) =>
          ({id, scope_sha256, cap_cents, reserved_cents})) : children);
    } else if (sql.startsWith('SELECT a.budget_id')) {
      assert.equal(args[0], state.parent.id);
      return rows([...state.admissions].sort((a, b) =>
        a.budget_id.localeCompare(b.budget_id) || a.admission_key.localeCompare(b.admission_key)));
    } else if (sql.startsWith('SELECT * FROM instagram_saved_batch_budgets')) {
      return rows(state.children.filter(b => b.id === args[0]));
    } else if (sql === 'ALTER TABLE instagram_campaign_budgets ALTER COLUMN cap_cents DROP NOT NULL') {
      state.nullable = true;
    } else if (sql.startsWith('UPDATE instagram_campaign_budgets SET cap_cents=NULL')) {
      assert.equal(args[0], state.parent.id);
      assert.equal(state.nullable, true);
      state.parent.cap_cents = null;
      state.parent.scope_sha256 = args[1];
    } else if (sql.startsWith('UPDATE instagram_campaign_budgets SET owner=$2')) {
      assert.equal(args[0], state.parent.id);
      state.parent.owner = args[1];
    } else if (sql.startsWith('INSERT INTO instagram_saved_batch_budgets')) {
      assert.ok(!state.children.some(b => b.id === args[0]), 'Duplicate child budget.');
      assert.ok(Number.isInteger(args[2]) && args[2] > 0 && args[2] <= 2000);
      state.children.push({id: args[0], scope_sha256: args[1], cap_cents: args[2],
        reserved_cents: 0, owner: null});
    } else if (sql.startsWith('INSERT INTO instagram_campaign_children')) {
      assert.equal(args[0], state.parent.id);
      assert.ok(state.children.some(b => b.id === args[1]));
    } else if (sql.startsWith('UPDATE instagram_saved_batch_budgets SET owner=$2')) {
      const child = state.children.find(b => b.id === args[0]);
      assert.ok(child);
      child.owner = args[1];
    } else if (sql.startsWith('INSERT INTO instagram_saved_batch_admissions')) {
      assert.ok(!state.admissions.some(a => a.budget_id === args[0] && a.admission_key === args[1]),
        'Duplicate admission key.');
      assert.equal(args[3], 2);
      state.admissions.push({budget_id: args[0], admission_key: args[1], profile_id: args[2], cents: args[3]});
    } else if (sql.startsWith('UPDATE instagram_saved_batch_budgets SET reserved_cents=reserved_cents+2')) {
      const child = state.children.find(b => b.id === args[0]);
      assert.ok(child && child.reserved_cents + 2 <= child.cap_cents);
      child.reserved_cents += 2;
    } else throw Error('Unexpected fixture SQL: ' + sql);
    return rows([]);
  }
  const pool = {query, connect: async () => ({query, release() {}}), end: async () => {}};
  return {pool, calls, get state() { return structuredClone(state); }};
}

// Used only by the subprocess loader, never by an operations runner.
export async function connectFixturePool() {
  const file = process.env.TEST_CAMPAIGN_LEDGER;
  assert.ok(file, 'Missing isolated ledger path.');
  const fixture = campaignMemoryLedger(JSON.parse(await fs.readFile(file, 'utf8')));
  fixture.pool.end = async () => {
    await fs.writeFile(file, JSON.stringify(fixture.state));
    await fs.writeFile(file + '.calls.json', JSON.stringify(fixture.calls));
  };
  return fixture.pool;
}
