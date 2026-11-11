// One-time explicit approval in the existing development operations ledger.
// Never invoked by the web app, a deploy hook, or a paid provider transport.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {digest} from './instagram-next-saved-batch.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {readCampaignLedger,loadCampaignRecovery} from './instagram-campaign-recovery.mjs';

assert.deepEqual(process.argv.slice(2), ['--approve-uncapped-remaining']);
const root='generated-artifacts/next-saved-full-tiers-1-5-usd100';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const original=await read(root+'/approval.json');
const destination=root+'/uncapped-approval.json';
await assert.rejects(fs.access(destination),e=>e.code==='ENOENT');
const pool=await connectSavedBatchPool();
try{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    const ledger=await readCampaignLedger(c,original.id,true);
    const state=await loadCampaignRecovery(root,ledger);
    assert.equal(ledger.parent.cap_cents,10000);
    assert.equal(ledger.parent.scope_sha256,digest(original));
    assert.ok(ledger.children.every(b=>b.cap_cents===b.reserved_cents));
    const approval={...original,maximumSpendCents:null,uncappedExplicitlyApproved:true,
      originalApprovalSha256:digest(original),approvedAt:new Date().toISOString(),
      preservedReservedCents:state.funds.reservedCents,
      source:'User explicitly approved uncapped continuation for remaining Tier 1–5 artists without Instagram links; no historical replay, ownership safeguards unchanged.'};
    // Null means no total spending limit. Per-child transactional ceilings stay
    // intact. The existing numeric CHECK still constrains capped campaigns.
    await c.query('ALTER TABLE instagram_campaign_budgets ALTER COLUMN cap_cents DROP NOT NULL');
    await c.query('UPDATE instagram_campaign_budgets SET cap_cents=NULL,scope_sha256=$2 WHERE id=$1',
      [original.id,digest(approval)]);
    await fs.writeFile(destination,JSON.stringify(approval,null,2),{flag:'wx'});
    await c.query('COMMIT');
    console.log(JSON.stringify({status:'uncapped_remaining_approved',maximumSpendCents:null,
      preservedReservedCents:state.funds.reservedCents,paidCalls:0,restarted:false}));
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}
  finally{c.release();}
}finally{await pool.end();}
