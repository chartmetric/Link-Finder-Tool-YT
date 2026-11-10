import assert from 'node:assert/strict';
// Retire unused authorization, never refund reservations or reopen admissions.
// Missing responses are allowed only when explicitly fenced out of all future
// work. Their reservations are retained; this never authorizes replay.
export async function retireStoppedMetadataBudget(pool,{scope,scopeSha256,receipts,skipUncertainKeys=[]}){
  const cap=scope.authorization.maxSpendCents,id=scope.authorization.budgetId;
  assert.equal(scope.candidateMetadataFetchesApproved,true);
  const uncertain=new Set(skipUncertainKeys);assert.equal(uncertain.size,skipUncertainKeys.length);
  assert.ok(receipts.length>0&&receipts.every(r=>uncertain.has(r.key)
    ?r.httpStatus==null&&r.outcome==='interrupted_never_retry'
    :Number.isInteger(r.httpStatus)&&r.httpStatus>=100&&r.httpStatus<=599));
  const expected=new Set(receipts.map(r=>r.key));assert.equal(expected.size,receipts.length);
  assert.ok([...uncertain].every(key=>expected.has(key)));
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
    const {rows}=await c.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1 FOR UPDATE',[id]);
    const b=rows[0];assert.ok(b);assert.equal(b.scope_sha256,scopeSha256);
    assert.equal(b.cap_cents,cap);assert.equal(b.reserved_cents,receipts.length*2);
    const admissions=await c.query('SELECT admission_key FROM instagram_saved_batch_admissions WHERE budget_id=$1',[id]);
    assert.deepEqual(new Set(admissions.rows.map(r=>r.admission_key)),expected);
    // Old request scope still requires its original ceiling and therefore can
    // no longer pass the gate. The already-reserved charge remains unchanged.
    await c.query('UPDATE instagram_saved_batch_budgets SET cap_cents=reserved_cents WHERE id=$1',[id]);
    await c.query('COMMIT');
    return {budgetId:id,oldCeilingCents:cap,retiredCeilingCents:b.reserved_cents,
      preservedReservedCents:b.reserved_cents,remainingMetadataCents:cap-b.reserved_cents,
      oldAdmissionsNeverReplay:true,uncertainKeysPermanentlySkipped:[...uncertain]};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
