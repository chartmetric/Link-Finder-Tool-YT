import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Campaign authorization is separate from every historical pilot/batch.
// Child ceilings, not estimated invoices, count against its shared ceiling.
export const campaignSchemaSql=`
CREATE TABLE IF NOT EXISTS instagram_campaign_budgets (
 id text PRIMARY KEY, scope_sha256 text NOT NULL,
 cap_cents integer NOT NULL CHECK(cap_cents BETWEEN 1 AND 10000),
 owner uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS instagram_campaign_children (
 campaign_id text NOT NULL REFERENCES instagram_campaign_budgets(id),
 budget_id text NOT NULL UNIQUE REFERENCES instagram_saved_batch_budgets(id),
 PRIMARY KEY(campaign_id,budget_id)
);`;

export function nextCampaignAllocation(cap,children){
  assert.ok(Number.isInteger(cap)&&cap>0&&cap<=10000);
  const ids=new Set();
  let allocated=0,reserved=0;
  for(const b of children){
    assert.ok(b.id&&!ids.has(b.id));ids.add(b.id);
    assert.ok(Number.isInteger(b.cap_cents)&&b.cap_cents>0&&b.cap_cents<=2000);
    assert.ok(Number.isInteger(b.reserved_cents)&&b.reserved_cents>=0&&b.reserved_cents<=b.cap_cents);
    allocated+=b.cap_cents;reserved+=b.reserved_cents;
  }
  assert.ok(allocated<=cap,'Campaign allocations exceed authorization.');
  return {allocatedCents:allocated,reservedCents:reserved,
    nextCapCents:Math.min(2000,cap-allocated)};
}

export async function claimCampaign(pool,{id,scopeSha256,capCents}){
  nextCampaignAllocation(capCents,[]);
  const owner=randomUUID();
  // No upsert, takeover, lease expiry, automatic reconciliation or replay.
  await pool.query(`INSERT INTO instagram_campaign_budgets (id,scope_sha256,cap_cents,owner)
    VALUES ($1,$2,$3,$4)`,[id,scopeSha256,capCents,owner]);
  return {id,scopeSha256,capCents,owner};
}

export async function campaignTransaction(pool,claim,work){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='15s'");
    const {rows}=await c.query('SELECT * FROM instagram_campaign_budgets WHERE id=$1 FOR UPDATE',[claim.id]);
    const b=rows[0];assert.ok(b);
    assert.equal(b.owner,claim.owner);assert.equal(b.scope_sha256,claim.scopeSha256);
    assert.equal(b.cap_cents,claim.capCents);
    const children=await c.query(`SELECT b.* FROM instagram_campaign_children a
      INNER JOIN instagram_saved_batch_budgets b ON b.id=a.budget_id
      WHERE a.campaign_id=$1 ORDER BY b.id`,[claim.id]);
    const state=nextCampaignAllocation(b.cap_cents,children.rows);
    const result=await work(c,state,children.rows);
    await c.query('COMMIT');return result;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
}

export async function allocateCampaignChild(pool,claim,{id,scopeSha256,capCents}){
  assert.ok(Number.isInteger(capCents)&&capCents>0&&capCents<=2000);
  assert.ok(id.startsWith(claim.id+'-chunk-'));
  return campaignTransaction(pool,claim,async(c,state)=>{
    assert.ok(capCents<=state.nextCapCents,'No unallocated campaign funds remain.');
    await c.query('INSERT INTO instagram_saved_batch_budgets (id,scope_sha256,cap_cents) VALUES ($1,$2,$3)',
      [id,scopeSha256,capCents]);
    await c.query('INSERT INTO instagram_campaign_children (campaign_id,budget_id) VALUES ($1,$2)',
      [claim.id,id]);
    return {...state,allocatedCents:state.allocatedCents+capCents};
  });
}
