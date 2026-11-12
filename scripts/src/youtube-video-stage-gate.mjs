import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertVideoStageAdmission,assertVideoStageApproval} from './youtube-video-stage.mjs';
export const videoStageSchema=`
CREATE TABLE IF NOT EXISTS youtube_video_stage_runs(
 id text PRIMARY KEY,owner text NOT NULL,plan_sha256 text NOT NULL,approval_sha256 text NOT NULL,
 cap_cents int NOT NULL CHECK(cap_cents>0 AND cap_cents<=80),
 reserved_cents int NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=cap_cents),
 status text NOT NULL CHECK(status IN ('running','stopped','completed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS youtube_video_stage_admissions(
 run_id text NOT NULL REFERENCES youtube_video_stage_runs(id),operation_key text NOT NULL,
 profile_id text NOT NULL,cm_artist text NOT NULL,video_id text NOT NULL,input_sha256 text NOT NULL,
 status text NOT NULL DEFAULT 'admitted' CHECK(status IN ('admitted','returned')),
 receipt_sha256 text,raw_sha256 text,http_status int,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,operation_key),UNIQUE(profile_id,cm_artist,video_id)
);`;
async function transaction(pool,fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function paused(c,plan){
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
    [plan.parentId])).rows[0]?.status,'stopped','Full campaign must remain paused');
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'")).rows[0].n,0,
    'Another YouTube test is running');
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'")).rows[0].n,0,
    'Existing uncertain bounded request blocks activation');
}
export function videoStageGate({pool,plan,approval,owner}){
  assertVideoStageApproval(plan,approval);
  const lock=async c=>{
    await paused(c,plan);
    const r=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
    assert.ok(r&&r.owner===owner&&r.status==='running'&&r.plan_sha256===digest(plan)
      &&r.approval_sha256===digest(approval),'Lost stage owner or approval fence');
    return r;
  };
  return {
    async start(){
      await pool.query(videoStageSchema);
      return transaction(pool,async c=>{
        await paused(c,plan);
        assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'")).rows[0].n,0,
          'Another video stage is running');
        assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_stage_admissions WHERE status='admitted'")).rows[0].n,0,
          'Uncertain video request blocks activation');
        await c.query(`INSERT INTO youtube_video_stage_runs(id,owner,plan_sha256,approval_sha256,cap_cents,status)
          VALUES($1,$2,$3,$4,$5,'running')`,[plan.id,owner,digest(plan),digest(approval),plan.maximumSpendCents]);
      });
    },
    async admit(op){
      return transaction(pool,async c=>{
        const run=await lock(c);
        const history=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1 ORDER BY created_at,operation_key',[plan.id])).rows;
        assertVideoStageAdmission(plan,approval,run,op,history,owner);
        await c.query(`INSERT INTO youtube_video_stage_admissions
          (run_id,operation_key,profile_id,cm_artist,video_id,input_sha256) VALUES($1,$2,$3,$4,$5,$6)`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256]);
        const r=await c.query('UPDATE youtube_video_stage_runs SET reserved_cents=reserved_cents+2 WHERE id=$1 AND reserved_cents+2<=cap_cents',[plan.id]);
        assert.equal(r.rowCount,1);
      });
    },
    async returned(op,receiptSha,rawSha){
      assert.match(receiptSha,/^[a-f0-9]{64}$/);assert.match(rawSha,/^[a-f0-9]{64}$/);
      assert.deepEqual(plan.operations.find(p=>p.key===op.key),op);
      return transaction(pool,async c=>{
        await lock(c);
        const r=await c.query(`UPDATE youtube_video_stage_admissions SET status='returned',
          receipt_sha256=$7,raw_sha256=$8,http_status=200
          WHERE run_id=$1 AND operation_key=$2 AND profile_id=$3 AND cm_artist=$4 AND video_id=$5
          AND input_sha256=$6 AND status='admitted'`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.videoId,op.inputSha256,receiptSha,rawSha]);
        assert.equal(r.rowCount,1,'Lost exact receipt acknowledgment fence');
      });
    },
    async finish(status){
      assert.ok(['completed','stopped'].includes(status));
      return transaction(pool,async c=>{
        const run=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
        assert.ok(run&&run.owner===owner&&run.status==='running'
          &&run.approval_sha256===digest(approval)&&run.plan_sha256===digest(plan),'Lost stage completion fence');
        if(status==='completed'){
          const rows=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1',[plan.id])).rows;
          assert.equal(rows.length,plan.maximumCalls);
          assert.ok(rows.every(r=>r.status==='returned'&&r.http_status===200));
        }
        await c.query('UPDATE youtube_video_stage_runs SET status=$3 WHERE id=$1 AND owner=$2',[plan.id,owner,status]);
      });
    },
  };
}
