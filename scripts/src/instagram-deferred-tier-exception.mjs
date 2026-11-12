import assert from 'node:assert/strict';

export function exceptionEligibilitySql(ids, scope) {
  assert.ok(Array.isArray(ids) && ids.length > 0);
  assert.equal(scope.length, 9404);
  const allowed = new Set(scope.map(a => a.profile_id));
  assert.equal(allowed.size, scope.length);
  assert.ok(ids.every(id => typeof id === 'string' && /^[1-9]\d*$/.test(id) && allowed.has(id)));
  return `SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,
 p.name artist,t.tier tier
 FROM new_vertical.profile p FINAL INNER JOIN (
 SELECT profile,argMax(tier,tuple(computed_at,updated_at)) tier
 FROM new_vertical.l_profile_tier FINAL
 WHERE grain='global' AND profile_type='musician'
 AND profile IN (${ids.join(',')})
 GROUP BY profile HAVING tier BETWEEN 1 AND 5
 ) t ON t.profile=p.id
 WHERE p.id IN (${ids.join(',')}) AND p.cm_source='cm_artist' AND p.deleted_at IS NULL
 AND p.id NOT IN (
 SELECT DISTINCT l.profile_id FROM new_vertical.l_profile_account l FINAL
 INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
 WHERE l.disconnected_at IS NULL AND lower(a.platform)='instagram'
 AND notEmpty(trim(ifNull(a.account_url,'')))
 )`;
}

export function patchExceptionRuntime(adapter, core, scope) {
  // Exact replacements fail closed if the previously sealed runtime differs.
  const before = `export function eligibilitySql(platform,ids){`;
  assert.equal(adapter.split(before).length, 2);
  const after = `${exceptionEligibilitySql.toString()}
const deferredTierExceptionScope=${JSON.stringify(scope.map(a => ({profile_id:a.profile_id})))};
export function eligibilitySql(platform,ids){
  assert.equal(platform,'instagram','This exception cannot run YouTube.');
  return exceptionEligibilitySql(ids,deferredTierExceptionScope);
}
function originalEligibilitySqlUnused(platform,ids){`;
  const ended = "assert.equal(run.status,'stopped','Only an ended worker can be handed off.');";
  assert.equal(core.split(ended).length, 2);
  return {adapter:adapter.replace(before,after), core:core.replace(ended,
    "assert.ok(['stopped','completed'].includes(run.status),'Only an ended worker can be handed off.');")};
}
