import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
// Retire unused authorization, never refund reservations or reopen admissions.
// Missing responses are allowed only when explicitly fenced out of all future
// work. Their reservations are retained; this never authorizes replay.
export async function retireStoppedMetadataBudget(pool,{scope,scopeSha256,receipts,skipUncertainKeys=[],approvedReconciliation=null}){
  const cap=scope.authorization.maxSpendCents,id=scope.authorization.budgetId;
  assert.equal(scope.candidateMetadataFetchesApproved,true);
  const uncertain=new Set(skipUncertainKeys);assert.equal(uncertain.size,skipUncertainKeys.length);
  assert.ok(receipts.length>0&&receipts.every(r=>uncertain.has(r.key)
    ?r.httpStatus==null&&r.outcome==='interrupted_never_retry'
    :Number.isInteger(r.httpStatus)&&r.httpStatus>=100&&r.httpStatus<=599));
  const expected=new Set(receipts.map(r=>r.key));assert.equal(expected.size,receipts.length);
  assert.ok([...uncertain].every(key=>expected.has(key)));
  if(approvedReconciliation){
    assert.equal(approvedReconciliation.approved,true);
    assert.equal(createHash('sha256').update(JSON.stringify(scope)).digest('hex'),scopeSha256);
    const {historicalAdmissions,missingKeys,expectedReservedCents}=approvedReconciliation;
    assert.equal(new Set(missingKeys).size,missingKeys.length);assert.ok(missingKeys.length>0);
    assert.equal(historicalAdmissions.length,expected.size);
    assert.deepEqual(new Set(historicalAdmissions.map(a=>a.key)),expected);
    assert.equal(expectedReservedCents+missingKeys.length*2,receipts.length*2);
    for(const a of historicalAdmissions){
      const r=scope.requests.find(r=>r.key===a.key);
      assert.ok(r);assert.equal(String(r.profileId),String(a.profileId));
      assert.equal(a.phase,'admitted');assert.equal(a.reservedCents,2);
      assert.ok(Number.isFinite(Date.parse(a.at)));
      assert.equal(r.kind,'scrapecreators_candidate');
      assert.equal(createHash('sha256').update(JSON.stringify(r.body)).digest('hex'),r.sha256);
    }
    assert.ok(missingKeys.every(key=>expected.has(key)));
  }
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
    const {rows}=await c.query('SELECT * FROM instagram_saved_batch_budgets WHERE id=$1 FOR UPDATE',[id]);
    const b=rows[0];assert.ok(b);assert.equal(b.scope_sha256,scopeSha256);
    assert.equal(b.cap_cents,cap);
    let reconciledKeys=[];
    if(approvedReconciliation){
      const {historicalAdmissions,missingKeys,expectedReservedCents}=approvedReconciliation;
      assert.equal(b.reserved_cents,expectedReservedCents);
      const existing=await c.query('SELECT admission_key,profile_id,cents FROM instagram_saved_batch_admissions WHERE budget_id=$1',[id]);
      assert.equal(existing.rows.length*2,expectedReservedCents);
      const existingKeys=new Set(existing.rows.map(a=>a.admission_key));
      assert.deepEqual(new Set([...expected].filter(key=>!existingKeys.has(key))),new Set(missingKeys));
      for(const a of existing.rows){
        const saved=historicalAdmissions.find(r=>r.key===a.admission_key);
        assert.ok(saved);assert.equal(String(a.profile_id),String(saved.profileId));assert.equal(a.cents,2);
      }
      for(const key of missingKeys){
        const a=historicalAdmissions.find(a=>a.key===key);
        await c.query('INSERT INTO instagram_saved_batch_admissions (budget_id,admission_key,profile_id,cents,admitted_at) VALUES ($1,$2,$3,$4,$5)',
          [id,key,String(a.profileId),2,a.at]);
      }
      // Backfill history and retire the old ceiling in the same transaction.
      // A missing receipt is still charged and never becomes replayable.
      await c.query('UPDATE instagram_saved_batch_budgets SET reserved_cents=$2 WHERE id=$1',[id,receipts.length*2]);
      b.reserved_cents=receipts.length*2;reconciledKeys=[...missingKeys];
    }
    assert.equal(b.reserved_cents,receipts.length*2);
    const admissions=await c.query('SELECT admission_key FROM instagram_saved_batch_admissions WHERE budget_id=$1',[id]);
    assert.deepEqual(new Set(admissions.rows.map(r=>r.admission_key)),expected);
    // Old request scope still requires its original ceiling and therefore can
    // no longer pass the gate. The already-reserved charge remains unchanged.
    await c.query('UPDATE instagram_saved_batch_budgets SET cap_cents=reserved_cents WHERE id=$1',[id]);
    await c.query('COMMIT');
    return {budgetId:id,oldCeilingCents:cap,retiredCeilingCents:b.reserved_cents,
      preservedReservedCents:b.reserved_cents,remainingMetadataCents:cap-b.reserved_cents,
      oldAdmissionsNeverReplay:true,uncertainKeysPermanentlySkipped:[...uncertain],reconciledHistoricalKeys:reconciledKeys};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
