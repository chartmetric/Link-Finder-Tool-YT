// Explicit execution handoff. Never interrupt an artist or a paid request.
import assert from 'node:assert/strict';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {CAMPAIGNS,readJson,saveJson} from './campaign-parallel-core.mjs';

assert.ok(process.argv.includes('--handoff-approved'));
const phase=process.argv.at(-1),cfg=CAMPAIGNS.instagram;
const manifest=await readJson(phase+'/approval.json'),launch=await readJson(phase+'/launched.json');
assert.equal(manifest.platform,'instagram');assert.equal(manifest.campaignId,cfg.id);
const waitMs=process.argv.includes('--wait-until-drained')?86400000:600000;
const pool=await connectSavedBatchPool(),deadline=Date.now()+waitMs;
try{
  while(Date.now()<deadline){
    const c=await pool.connect();let proof;
    try{
      await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
      const run=(await c.query(`SELECT * FROM ${cfg.runs} WHERE id=$1 FOR UPDATE`,[cfg.id])).rows[0];
      assert.equal(run.owner,launch.owner);
      assert.ok(['running','completed'].includes(run.status));
      assert.equal(run.scope_sha256,manifest.scopeSha256);assert.equal(run.approval_sha256,manifest.approvalSha256);
      const pending=(await c.query(`SELECT count(*)::int n FROM ${cfg.admissions}
        WHERE campaign_id=$1 AND status='admitted'`,[cfg.id])).rows[0].n;
      const active=(await c.query(`SELECT count(*)::int n FROM ${cfg.artists}
        WHERE campaign_id=$1 AND status='in_progress'`,[cfg.id])).rows[0].n;
      if(run.status==='completed'){
        const queued=(await c.query(`SELECT 1 FROM ${cfg.artists} WHERE campaign_id=$1 AND status='queued' LIMIT 1`,[cfg.id])).rowCount;
        assert.equal(queued,1,'The campaign really finished; no continuation needed.');
      }
      if(!pending&&!active){
        await c.query(`UPDATE ${cfg.runs} SET status='stopped',stop_reason='approved_speed_handoff',
          updated_at=now() WHERE id=$1`,[cfg.id]);
        proof={at:new Date().toISOString(),owner:launch.owner,campaignId:cfg.id,
          pendingAdmissions:0,inProgressArtists:0,reservedCents:Number(run.reserved_cents),
          noRequestCancelled:true,approvedRollingContinuation:true};
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    if(proof){await saveJson(phase+'/speed-handoff.json',proof);console.log(JSON.stringify(proof));break;}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(Date.now()<deadline,'No safe handoff boundary found; existing run was not interrupted.');
}finally{await pool.end();}
