import assert from 'node:assert/strict';
export const boundedYoutubeSchema=`
CREATE TABLE IF NOT EXISTS youtube_bounded_test_admissions (
 run_id text NOT NULL REFERENCES youtube_discovery_test_runs(id),
 operation_key text NOT NULL,profile_id text NOT NULL,kind text NOT NULL,
 input_sha256 text NOT NULL,reserved_cents int NOT NULL CHECK(reserved_cents=2),
 status text NOT NULL DEFAULT 'admitted',receipt_sha256 text,http_status int,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(run_id,operation_key)
);`;
export function assertBoundedYoutubeAdmission(run,scope,operation,pending,owner){
  assert.equal(run.owner,owner);assert.equal(run.status,'running');
  assert.equal(run.scope_sha256,scope.scopeSha256);
  assert.equal(run.cap_cents,scope.operationalCapCents);
  const ceiling=scope.artists.length===100&&scope.maxCalls===500
    &&scope.explicitApproval===true&&scope.approvalStatus==='approved'
    &&scope.proposedCapCents===1000?1000:200;
  assert.ok(run.cap_cents<=scope.userCapCents&&run.cap_cents<=ceiling);
  assert.ok(Number(run.reserved_cents)+2<=run.cap_cents,'Test spending allowance reached');
  assert.equal(Number(pending),0,'Uncertain prior request blocks spending');
  assert.ok(scope.artists.some(a=>a.profile_id===operation.profileId),'Artist is outside approved test');
  assert.ok(['search','metadata','model'].includes(operation.kind));
  assert.match(operation.inputSha256,/^[a-f0-9]{64}$/);
  assert.ok(operation.key.startsWith(operation.kind+'-'+operation.profileId+'-'));
}
export function boundedYoutubeGate({pool,id,owner,scope,parentId}){
  return {
    async admit(op){
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const parent=(await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[parentId])).rows[0];
        assert.equal(parent?.status,'stopped','Full YouTube campaign must remain paused');
        const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
        const pending=(await c.query("SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE run_id=$1 AND status='admitted'",[id])).rows[0].n;
        assertBoundedYoutubeAdmission(run,scope,op,pending,owner);
        await c.query(`INSERT INTO youtube_bounded_test_admissions
          (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
        [id,op.key,op.profileId,op.kind,op.inputSha256]);
        const r=await c.query('UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2 WHERE id=$1 AND reserved_cents+2<=cap_cents',[id]);
        assert.equal(r.rowCount,1);await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    },
    async returned(op,receiptSha,status){
      const r=await pool.query(`UPDATE youtube_bounded_test_admissions a SET status='returned',receipt_sha256=$6,http_status=$7
        FROM youtube_discovery_test_runs r WHERE a.run_id=$1 AND a.operation_key=$2 AND a.profile_id=$3
        AND a.input_sha256=$4 AND a.status='admitted' AND r.id=a.run_id AND r.owner=$5 AND r.status='running'`,
      [id,op.key,op.profileId,op.inputSha256,owner,receiptSha,status]);
      assert.equal(r.rowCount,1,'Lost test receipt owner fence');
    },
  };
}
