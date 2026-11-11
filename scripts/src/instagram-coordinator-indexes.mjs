// Explicit operational indexes only. No artist, admission or billing-row writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
const id='full-tiers-1-5-no-ig-usd100';
export const INSTAGRAM_COORDINATOR_INDEXES=[
  {name:'instagram_priority_pending_admissions_fast',table:'instagram_priority_admissions',
    sql:`CREATE INDEX CONCURRENTLY IF NOT EXISTS instagram_priority_pending_admissions_fast
      ON public.instagram_priority_admissions (campaign_id) INCLUDE (operation_key,profile_id)
      WHERE status='admitted'`},
  {name:'instagram_priority_pending_tiers_fast',table:'instagram_priority_artists',
    sql:`CREATE INDEX CONCURRENTLY IF NOT EXISTS instagram_priority_pending_tiers_fast
      ON public.instagram_priority_artists (campaign_id,tier,ordinal)
      WHERE status IN ('queued','in_progress')`},
  {name:'instagram_saved_batch_profile_lookup_fast',table:'instagram_saved_batch_admissions',
    sql:`CREATE INDEX CONCURRENTLY IF NOT EXISTS instagram_saved_batch_profile_lookup_fast
      ON public.instagram_saved_batch_admissions (profile_id)`},
];
async function snapshot(c){
  const run=(await c.query('SELECT status,reserved_cents FROM instagram_priority_runs WHERE id=$1',[id])).rows[0];
  assert.equal(run.status,'stopped','Only optimize this coordinator while its worker is stopped');
  const admissions=(await c.query(`SELECT count(*)::int n,sum(reserved_cents)::bigint cents,
    count(*) FILTER(WHERE status='admitted')::int pending FROM instagram_priority_admissions WHERE campaign_id=$1`,[id])).rows[0];
  assert.equal(admissions.pending,0);
  return {run,admissions};
}
export async function applyInstagramCoordinatorIndexes(pool){
  const c=await pool.connect();
  try{
    const before=await snapshot(c);
    await c.query("SET lock_timeout='5s'");await c.query("SET statement_timeout='120s'");
    const indexes=[];
    for(const index of INSTAGRAM_COORDINATOR_INDEXES){
      await c.query(index.sql);
      const row=(await c.query(`SELECT i.indisvalid, t.relname table_name FROM pg_index i
        JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_namespace n ON n.oid=x.relnamespace
        JOIN pg_class t ON t.oid=i.indrelid WHERE n.nspname='public' AND x.relname=$1`,[index.name])).rows[0];
      assert.equal(row?.indisvalid,true);assert.equal(row.table_name,index.table);
      indexes.push(index.name);
    }
    assert.deepEqual(await snapshot(c),before,'Safety/spending rows changed during index setup');
    const probes=[
      ['pending_admissions',`SELECT operation_key,profile_id FROM instagram_priority_admissions WHERE campaign_id=$1 AND status='admitted'`,[id]],
      ['earlier_pending_tiers',`SELECT count(*) FROM instagram_priority_artists WHERE campaign_id=$1 AND tier<5 AND status IN ('queued','in_progress')`,[id]],
      ['legacy_attempt_lookup',`SELECT 1 FROM instagram_saved_batch_admissions WHERE profile_id=$1 LIMIT 1`,['0']],
    ];
    const measurements=[];
    for(const [name,sql,params] of probes){
      const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
      const names=[];const visit=p=>{if(p['Index Name'])names.push(p['Index Name']);for(const child of p.Plans??[])visit(child);};
      visit(plan.Plan);assert.ok(names.length,'Safety query still scans without an index');
      measurements.push({name,executionMs:plan['Execution Time'],indexes:names});
    }
    return {at:new Date().toISOString(),indexes,measurements,dataRowsUnchanged:true,
      providerCalls:0,admissions:before.admissions.n,reservedCents:before.run.reserved_cents};
  }finally{
    await c.query('RESET lock_timeout').catch(()=>{});await c.query('RESET statement_timeout').catch(()=>{});c.release();
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--apply-approved']);
  const pool=await connectSavedBatchPool();
  try{
    const result=await applyInstagramCoordinatorIndexes(pool);
    await fs.writeFile('generated-artifacts/instagram-stop-review-2026-11-11/index-improvements.json',
      JSON.stringify(result,null,2),{flag:'wx'});
    console.log(JSON.stringify(result));
  }finally{await pool.end();}
}
