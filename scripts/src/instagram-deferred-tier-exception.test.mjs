import test from 'node:test';
import assert from 'node:assert/strict';
import {exceptionEligibilitySql,patchExceptionRuntime} from './instagram-deferred-tier-exception.mjs';
const scope = Array.from({length:9404},(_,i)=>({profile_id:String(i+1)}));
test('only exact approved cohort IDs can pass to the catalog query',()=>{
  const sql=exceptionEligibilitySql(['1','9404'],scope);
  assert.match(sql,/profile IN \(1,9404\)/);
  assert.match(sql,/grain='global' AND profile_type='musician'/);
  assert.match(sql,/GROUP BY profile HAVING tier BETWEEN 1 AND 5/);
  assert.match(sql,/p.deleted_at IS NULL/);
  assert.match(sql,/lower\(a.platform\)='instagram'/);
  assert.match(sql,/l.disconnected_at IS NULL/);
  assert.doesNotMatch(sql,/computed_at\s*[=<>]|latest_snapshot/);
  for(const ids of [[],['9405'],['1 OR 1=1'],[1]])
    assert.throws(()=>exceptionEligibilitySql(ids,scope));
  assert.throws(()=>exceptionEligibilitySql(['1'],scope.slice(1)));
});
test('exception patch is platform-isolated and refuses unexpected runtime text',()=>{
  const adapter='export function eligibilitySql(platform,ids){\n return oldQuery;\n}';
  const core="assert.equal(run.status,'stopped','Only an ended worker can be handed off.');";
  const result=patchExceptionRuntime(adapter,core,scope);
  assert.match(result.adapter,/This exception cannot run YouTube/);
  assert.match(result.adapter,/originalEligibilitySqlUnused/);
  assert.match(result.core,/\['stopped','completed'\]/);
  assert.throws(()=>patchExceptionRuntime('',core,scope));
  assert.throws(()=>patchExceptionRuntime(adapter,'',scope));
});
