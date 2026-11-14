import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {stagedSearchPlan,approveStagedSearch} from './youtube-staged-search-plan.mjs';
import {freshHundredArtists,hundredSearchPlan,approveHundredSearch} from './youtube-hundred-search-plan.mjs';
const now=Date.parse('2026-11-13T23:00:00Z');
function rows(tiers=[2,3,4,5]){
  return tiers.flatMap(t=>Array.from({length:35},(_,i)=>({
    profile_id:String(t*100+i),cm_artist:String(t*1000+i),artist:'Artist '+t+' '+i,
    tier:t,tier_rank:i,snapshot_at:'2026-11-13 01:30:18'})));
}
function fixture(){
  const selected=freshHundredArtists(rows(),[],now);
  const children=Array.from({length:5},(_,i)=>{
    const artists=selected.slice(i*20,(i+1)*20);
    const id='youtube-test-hundred-fixture-part-'+i;
    const packets=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
      catalogProfile:{profile_id:a.profile_id,cm_artist:a.cm_artist},linkedAccounts:[],releases:[],catalogTracks:[]}));
    return {id,plan:stagedSearchPlan({id,artists,packets,preparedAt:'2026-11-13T22:00:00Z',
      evidenceFiles:{'evidence/catalog.json':digest('evidence')},runtimeFiles:{'runtime/test.mjs':digest('runtime')}})};
  });
  return hundredSearchPlan({id:'youtube-batch-100-fixture',preparedAt:'2026-11-13T22:01:00Z',children,
    runtimeFiles:{'runtime/run.mjs':digest('wrapper')}});
}
test('selection fairly distributes fresh artists without repeating profile or Chartmetric identities',()=>{
  const all=rows(),history=[{profile_id:all[0].profile_id,cm_artist:all[1].cm_artist}];
  const selected=freshHundredArtists(all,history,now);
  assert.equal(selected.length,100);
  assert.ok(selected.every(a=>a.profile_id!==history[0].profile_id&&a.cm_artist!==history[0].cm_artist));
  assert.deepEqual([1,2,3,4,5].map(t=>selected.filter(a=>a.tier===t).length),[0,25,25,25,25]);
  assert.equal(new Set(selected.map(a=>a.profile_id)).size,100);
  assert.equal(new Set(selected.map(a=>a.cm_artist)).size,100);
});
test('all five tiers are included when fresh records exist; stale or insufficient pools stop',()=>{
  const selected=freshHundredArtists(rows([1,2,3,4,5]),[],now);
  assert.deepEqual([1,2,3,4,5].map(t=>selected.filter(a=>a.tier===t).length),[20,20,20,20,20]);
  assert.throws(()=>freshHundredArtists(rows().slice(0,99),[],now));
  assert.throws(()=>freshHundredArtists(rows(),[],now+48*3600000));
});
test('100-search wrapper preserves five strict legacy plans with a two-dollar aggregate ceiling',()=>{
  const p=fixture();
  assert.equal(p.maximumCalls,100);assert.equal(p.maximumSpendCents,200);
  assert.ok(p.children.every(c=>c.plan.maxCalls===20&&c.capCents===40&&c.plan.explicitApproval===false));
  assert.deepEqual(p.allowedKinds,['search']);assert.equal(p.unknownDownstreamRequestsApproved,false);
  const a=approveHundredSearch(p,{planSha256:digest(p),capCents:200,approvedAt:'2026-11-13T23:00:00Z'});
  assert.equal(a.explicitApproval,true);assert.equal(p.explicitApproval,false);
  assert.throws(()=>approveHundredSearch(p,{...a,capCents:1000}));
  assert.throws(()=>approveHundredSearch(p,{...a,planSha256:digest('different')}));
  assert.throws(()=>approveStagedSearch(p.children[0].plan,{expectedPlanSha256:digest(p.children[0].plan),
    capCents:200,approvedAt:a.approvedAt}));
});
test('substitution, duplicate child identities, changed code and extra paid operation kinds cannot inherit approval',()=>{
  const p=fixture(),a=approveHundredSearch(p,{planSha256:digest(p),capCents:200,approvedAt:'2026-11-13T23:00:00Z'});
  for(const mutate of [
    x=>x.children[1]=structuredClone(x.children[0]),
    x=>x.children[0].plan.operations[0].kind='metadata',
    x=>x.children[0].plan.operations[0].request.body.q='other artist',
    x=>x.children[0].capCents=200,
    x=>x.runtimeFiles['runtime/run.mjs']=digest('different runtime'),
    x=>x.maximumSpendCents=1000,x=>x.allowedKinds.push('model'),
  ]){
    const changed=structuredClone(p);mutate(changed);
    assert.throws(()=>approveHundredSearch(changed,a));
  }
});
