// Operator-only pause for the launched worker, without changing its sealed code.
// Fence only between paid requests: no pending admission may be interrupted.
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {CAMPAIGNS,readJson,saveJson} from './campaign-parallel-core.mjs';
export async function pauseYoutube(phase){
  const cfg=CAMPAIGNS.youtube,manifest=await readJson(phase+'/approval.json'),launch=await readJson(phase+'/launched.json');
  assert.equal(manifest.platform,'youtube');assert.equal(manifest.campaignId,cfg.id);
  const pool=await connectSavedBatchPool(),deadline=Date.now()+120000;
  try{
    while(Date.now()<deadline){
      const c=await pool.connect();let proof;
      try{
        await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
        const run=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[cfg.id])).rows[0];
        assert.equal(run.owner,launch.owner);assert.equal(run.scope_sha256,manifest.scopeSha256);
        assert.equal(run.approval_sha256,manifest.approvalSha256);
        const pending=(await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions
          WHERE campaign_id=$1 AND status='admitted'`,[cfg.id])).rows[0].n;
        if(pending===0){
          assert.ok(['running','stopped'].includes(run.status));
          await c.query(`UPDATE youtube_link_campaigns SET status='stopped',stop_reason='user_requested_quality_pause',
            updated_at=now() WHERE id=$1 AND owner=$2`,[cfg.id,launch.owner]);
          proof={at:new Date().toISOString(),campaignId:cfg.id,owner:launch.owner,
            pauseRequested:true,pendingAdmissions:0,reservedCents:Number(run.reserved_cents),
            resumeRequiresNewUserApproval:true,noRequestCancelled:true};
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
      if(proof){
        await saveJson(phase+'/user-pause.json',proof);console.log(JSON.stringify(proof));return proof;
      }
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw Error('Could not find a drained request boundary; no in-flight requests were cancelled.');
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.ok(process.argv.includes('--pause-approved'));await pauseYoutube(process.argv.at(-1));
}
