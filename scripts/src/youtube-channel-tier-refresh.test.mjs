import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshTierSelections,tierRefreshScope} from './youtube-channel-tier-refresh.mjs';
const now=Date.parse('2026-11-17T02:00:00Z');
const selections=[{profileId:'1',cmArtist:'11',artist:'Artist',tier:4,context:{unchanged:true}}];
const rows=[{profile_id:'1',cm_artist:'11',artist:'Artist',tier:5,snapshot_at:'2026-11-17T01:00:00Z'}];
test('tier refresh changes only tier and leaves source selections immutable',()=>{
  const before=structuredClone(selections),updated=refreshTierSelections(selections,rows,now);
  assert.deepEqual(updated,[{...selections[0],tier:5}]);assert.deepEqual(selections,before);
});
test('missing, duplicate, changed identities and out-of-scope or stale tiers block',()=>{
  for(const values of [[],[rows[0],rows[0]],[{...rows[0],cm_artist:'12'}],
    [{...rows[0],artist:'Other'}],[{...rows[0],profile_id:'2'}],
    [{...rows[0],tier:0}],[{...rows[0],tier:6}],[{...rows[0],tier:2.5}],
    [{...rows[0],snapshot_at:'2026-11-01T01:00:00Z'}],
    [{...rows[0],snapshot_at:'2026-11-18T01:00:00Z'}]]){
    assert.throws(()=>refreshTierSelections(selections,values,now));
  }
});
test('missing current eligibility only subtracts untouched scope and never substitutes or changes requests',()=>{
  const original=[...selections,{...selections[0],profileId:'2',cmArtist:'12',artist:'Deferred'}];
  const ops=original.map(s=>({profileId:s.profileId,cmArtist:s.cmArtist,request:{url:'exact-'+s.profileId}}));
  const before=structuredClone({original,ops});
  const result=tierRefreshScope(original,ops,rows,now);
  assert.deepEqual(result.pending,[ops[0]]);assert.deepEqual(result.deferred,[original[1]]);
  assert.deepEqual({original,ops},before);
  assert.throws(()=>tierRefreshScope(original,ops,[{...rows[0],profile_id:'3'}],now));
  assert.throws(()=>tierRefreshScope(original,[ops[0],ops[0]],rows,now));
  assert.throws(()=>tierRefreshScope(original,[{...ops[0],cmArtist:'99'}],rows,now));
  assert.throws(()=>tierRefreshScope(original,ops,[],now));
});
