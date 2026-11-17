// Fresh locked non-replay checks; the legacy stage schema/caps stay unchanged.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertVideoStageApproval,assertVideoStageAdmission} from './youtube-video-stage.mjs';
import {videoStageSchema} from './youtube-video-stage-gate.mjs';
import {assertUploaderIdle} from './youtube-sparse-uploader-source.mjs';

export async function assertSparseNonReplay(client,plan){
  const ids=plan.artists.map(a=>a.profileId),cms=plan.artists.map(a=>a.cmArtist);
  const videos=plan.operations.map(o=>o.videoId);
  assert.equal((await client.query(`SELECT count(*)::int n FROM youtube_video_stage_admissions
    WHERE run_id<>$1 AND (profile_id=ANY($2::text[]) OR cm_artist=ANY($3::text[]) OR video_id=ANY($4::text[]))`,
  [plan.id,ids,cms,videos])).rows[0].n,0,'Historical uploader allocation blocks this stage');
  for(const table of ['youtube_bounded_test_admissions','youtube_link_campaign_admissions'])
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${table}
      WHERE kind ILIKE '%video%' OR kind ILIKE '%uploader%'`)).rows[0].n,0,
    'Unreconciled historical uploader format');
}
export function sparseUploaderGate({pool,plan,approval,owner}){
  assertVideoStageApproval(plan,approval);
  const tx=async fn=>{
    const c=await pool.connect();
    try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  };
  const parentLock=async c=>{
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [plan.parentId])).rows[0]?.status,'stopped');
  };
  const lock=async c=>{
    await parentLock(c);
    const run=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
    assert.ok(run&&run.owner===owner&&run.status==='running'&&run.plan_sha256===digest(plan)
      &&run.approval_sha256===digest(approval),'Lost exact stage ownership');
    return run;
  };
  return {
    async start(){
      await pool.query(videoStageSchema);
      return tx(async c=>{
        await parentLock(c);await assertUploaderIdle(c);await assertSparseNonReplay(c,plan);
        await c.query(`INSERT INTO youtube_video_stage_runs(id,owner,plan_sha256,approval_sha256,cap_cents,status)
          VALUES($1,$2,$3,$4,$5,'running')`,[plan.id,owner,digest(plan),digest(approval),plan.maximumSpendCents]);
      });
    },
    async admit(op){
      return tx(async c=>{
        const run=await lock(c);
        await assertSparseNonReplay(c,plan);
        for(const table of ['youtube_discovery_test_runs','youtube_video_identity_runs'])
          assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
        for(const table of ['youtube_bounded_test_admissions','youtube_link_campaign_admissions','youtube_video_identity_admissions'])
          assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
        assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_stage_runs
          WHERE id<>$1 AND status='running'`,[plan.id])).rows[0].n,0);
        assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_stage_admissions
          WHERE run_id<>$1 AND status='admitted'`,[plan.id])).rows[0].n,0);
        const history=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1 ORDER BY created_at,operation_key',[plan.id])).rows;
        assertVideoStageAdmission(plan,approval,run,op,history,owner);
        await c.query(`INSERT INTO youtube_video_stage_admissions
          (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256) VALUES($1,$2,$3,$4,$5,$6)`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_video_stage_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2<=cap_cents`,[plan.id])).rowCount,1);
      });
    },
    async returned(op,receiptSha,rawSha){
      assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
      for(const sha of [receiptSha,rawSha])assert.match(sha,/^[a-f0-9]{64}$/);
      return tx(async c=>{
        await lock(c);
        assert.equal((await c.query(`UPDATE youtube_video_stage_admissions SET status='returned',
          receipt_sha256=$7,raw_sha256=$8,http_status=200 WHERE run_id=$1 AND operation_key=$2
          AND profile_id=$3 AND cm_artist=$4 AND video_id=$5 AND input_sha256=$6 AND status='admitted'`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256,receiptSha,rawSha])).rowCount,1);
      });
    },
    async finish(status){
      assert.ok(['completed','stopped'].includes(status));
      return tx(async c=>{
        await lock(c);
        if(status==='completed'){
          const rows=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1',[plan.id])).rows;
          assert.equal(rows.length,plan.maximumCalls);
          assert.ok(rows.every(r=>r.status==='returned'&&r.http_status===200));
        }
        await c.query('UPDATE youtube_video_stage_runs SET status=$2 WHERE id=$1',[plan.id,status]);
      });
    },
  };
}
