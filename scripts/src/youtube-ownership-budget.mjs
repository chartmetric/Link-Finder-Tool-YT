import assert from 'node:assert/strict';
export const youtubeOwnershipSchema=`
CREATE TABLE IF NOT EXISTS youtube_ownership_checks (
 id text PRIMARY KEY,parent_id text NOT NULL UNIQUE REFERENCES youtube_discovery_test_runs(id),
 owner uuid NOT NULL,plan_sha256 text NOT NULL,authorization_sha256 text NOT NULL,
 cap_cents int NOT NULL CHECK(cap_cents BETWEEN 1 AND 136),
 prior_reserved_cents int NOT NULL CHECK(prior_reserved_cents=40),
 reserved_cents int NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=cap_cents),
 status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS youtube_ownership_admissions (
 check_id text NOT NULL REFERENCES youtube_ownership_checks(id),
 operation_key text NOT NULL,kind text NOT NULL CHECK(kind IN ('metadata','model')),
 input_sha256 text NOT NULL,reserved_cents int NOT NULL CHECK(reserved_cents=2),
 status text NOT NULL DEFAULT 'admitted',receipt_sha256 text,http_status int,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(check_id,operation_key)
);`;
export function assertYoutubeBudget(parent,phase,owner){
  assert.ok(parent&&phase);assert.equal(parent.id,phase.parent_id);
  assert.equal(phase.owner,owner);assert.equal(phase.status,'running');
  assert.equal(parent.status,'completed');assert.equal(parent.cap_cents,200);
  assert.equal(phase.cap_cents,136);assert.equal(phase.prior_reserved_cents,40);
  assert.equal(parent.reserved_cents,phase.prior_reserved_cents+phase.reserved_cents);
  assert.ok(phase.reserved_cents+2<=phase.cap_cents,'YouTube ownership allowance reached.');
  assert.ok(parent.reserved_cents+2<=176,'Combined YouTube reservation reached.');
}
export async function createYoutubeBudget({pool,id,parentId,owner,planHash,authorizationHash}){
  await pool.query(youtubeOwnershipSchema);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const {rows}=await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[parentId]);
    assert.equal(rows.length,1);const p=rows[0];
    assert.equal(p.status,'completed');assert.equal(p.cap_cents,200);assert.equal(p.reserved_cents,40);
    const counts=await c.query(`SELECT count(*)::int count FROM youtube_discovery_test_results WHERE run_id=$1
      AND status IN ('candidates_found','no_match')`,[parentId]);
    assert.equal(counts.rows[0].count,20);
    await c.query(`INSERT INTO youtube_ownership_checks
      (id,parent_id,owner,plan_sha256,authorization_sha256,cap_cents,prior_reserved_cents,status)
      VALUES($1,$2,$3,$4,$5,136,40,'running')`,[id,parentId,owner,planHash,authorizationHash]);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
// Explicit recovery of a fully drained phase. Never creates a replacement
// allocation, changes its cap, clears admissions or resets prior reservations.
export async function continueYoutubeBudget({pool,id,parentId,owner,planHash,
  priorAuthorizationHash,authorizationHash,receipts}){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const parent=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[parentId])).rows[0];
    const phase=(await c.query('SELECT * FROM youtube_ownership_checks WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(phase.status,'stopped');assert.equal(phase.authorization_sha256,priorAuthorizationHash);
    assert.equal(phase.plan_sha256,planHash);assert.equal(phase.parent_id,parentId);
    assert.equal(parent.status,'completed');assert.equal(parent.cap_cents,200);
    assert.equal(phase.cap_cents,136);assert.equal(phase.prior_reserved_cents,40);
    const admissions=(await c.query('SELECT * FROM youtube_ownership_admissions WHERE check_id=$1',[id])).rows;
    reconcileYoutubeReceipts({parent,phase,admissions,receipts});
    const r=await c.query(`UPDATE youtube_ownership_checks SET owner=$2,authorization_sha256=$3,status='running'
      WHERE id=$1 AND status='stopped' AND owner=$4`,[id,owner,authorizationHash,phase.owner]);
    assert.equal(r.rowCount,1);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export function reconcileYoutubeReceipts({parent,phase,admissions,receipts}){
  assert.equal(admissions.length,receipts.size);
  assert.equal(phase.reserved_cents,admissions.length*2);
  assert.equal(parent.reserved_cents,40+phase.reserved_cents);
  for(const admission of admissions){
    assert.equal(admission.status,'returned','An uncertain admission cannot be replayed or cleared.');
    const receipt=receipts.get(admission.operation_key);
    assert.ok(receipt);assert.equal(admission.kind,receipt.kind);
    assert.equal(admission.input_sha256,receipt.inputSha256);
    assert.equal(admission.receipt_sha256,receipt.receiptSha256);
    assert.equal(admission.http_status,receipt.status);
    assert.equal(admission.reserved_cents,2);
  }
}
export function youtubeBudgetGate({pool,id,parentId,owner,planHash,authorizationHash,allowed}){
  return {
    async admit(operation){
      const expected=allowed.get(operation.key);
      assert.ok(expected,'Operation not included in approved scope.');
      assert.equal(operation.kind,expected.kind);
      assert.match(expected.inputSha256??'',/^[a-f0-9]{64}$/,'Freeze this exact request before admission.');
      assert.equal(operation.inputSha256,expected.inputSha256);
      assert.match(operation.inputSha256,/^[a-f0-9]{64}$/);
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        const parent=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[parentId])).rows[0];
        const phase=(await c.query('SELECT * FROM youtube_ownership_checks WHERE id=$1 FOR UPDATE',[id])).rows[0];
        assertYoutubeBudget(parent,phase,owner);
        assert.equal(phase.plan_sha256,planHash);assert.equal(phase.authorization_sha256,authorizationHash);
        const pending=await c.query(`SELECT count(*)::int count FROM youtube_ownership_admissions
          WHERE check_id=$1 AND status='admitted'`,[id]);
        assert.equal(pending.rows[0].count,0,'Uncertain previous request blocks further spending.');
        // The unique key is never cleared or reused, including failed attempts.
        await c.query(`INSERT INTO youtube_ownership_admissions(check_id,operation_key,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,2)`,[id,operation.key,operation.kind,operation.inputSha256]);
        await c.query('UPDATE youtube_ownership_checks SET reserved_cents=reserved_cents+2 WHERE id=$1',[id]);
        await c.query('UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2 WHERE id=$1',[parentId]);
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    },
    async returned(operation,receiptHash,httpStatus){
      const result=await pool.query(`UPDATE youtube_ownership_admissions a SET status='returned',receipt_sha256=$4,http_status=$5
        FROM youtube_ownership_checks c WHERE a.check_id=$1 AND a.operation_key=$2 AND a.status='admitted'
        AND c.id=a.check_id AND c.owner=$3 AND c.status='running'`,[id,operation.key,owner,receiptHash,httpStatus]);
      assert.equal(result.rowCount,1,'Receipt write lost its owner fence.');
    },
    async close(status){
      assert.ok(['completed','stopped'].includes(status));
      const r=await pool.query('UPDATE youtube_ownership_checks SET status=$3 WHERE id=$1 AND owner=$2 AND status=$4',
        [id,owner,status,'running']);assert.equal(r.rowCount,1);
    },
    async stats(){
      return (await pool.query(`SELECT c.status,c.reserved_cents additional_reserved_cents,
        p.reserved_cents combined_reserved_cents,p.cap_cents total_cap_cents,
        (SELECT count(*)::int FROM youtube_ownership_admissions a WHERE a.check_id=c.id) admitted_calls,
        (SELECT count(*)::int FROM youtube_ownership_admissions a WHERE a.check_id=c.id AND a.status='admitted') uncertain_calls
        FROM youtube_ownership_checks c JOIN youtube_discovery_test_runs p ON p.id=c.parent_id WHERE c.id=$1`,[id])).rows[0];
    },
  };
}
