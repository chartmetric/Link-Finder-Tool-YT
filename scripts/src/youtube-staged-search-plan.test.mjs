import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {stagedSearchPlan,approveStagedSearch,assertStagedSearchApproval,validateStagedSearchPlan}
  from './youtube-staged-search-plan.mjs';
import {searchReadiness,stagedCatalogRoot} from './run-youtube-staged-search.mjs';

test('new cohorts use explicit catalog preparations without changing historical sources',()=>{
  assert.equal(stagedCatalogRoot('youtube-test-20-review-catalog-2026-11-13'),
    'generated-artifacts/youtube-test-20-review-catalog-2026-11-13');
  assert.equal(stagedCatalogRoot(),'generated-artifacts/youtube-test-20-staged-catalog-2026-11-13');
  for(const invalid of ['../old','/tmp/catalog','youtube-test-../../escape','not-a-test'])
    assert.throws(()=>stagedCatalogRoot(invalid));
});

function fixture(){
  const artists=Array.from({length:20},(_,i)=>({
    profile_id:String(i+1),cm_artist:String(i+101),artist:'Fixture Artist '+i,tier:2,
    ordinal:i,snapshot_at:'2026-11-13 01:30:18',
  }));
  const packets=artists.map(a=>({
    profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,
    catalogProfile:{profile_id:a.profile_id,cm_artist:a.cm_artist},
    linkedAccounts:[],releases:[],catalogTracks:[],
  }));
  return stagedSearchPlan({id:'youtube-test-staged-fixture',preparedAt:'2026-11-13T19:00:00Z',
    artists,packets,evidenceFiles:{'evidence/catalog.json':'a'.repeat(64)},
    runtimeFiles:{'runtime/run.mjs':'b'.repeat(64)}});
}
test('fresh twenty-artist plan freezes twenty searches and no downstream authority',()=>{
  const p=fixture();validateStagedSearchPlan(p);
  assert.equal(p.operations.length,20);assert.equal(p.operationalCapCents,40);
  assert.equal(p.operations.reduce((n,o)=>n+o.reservationCents,0),40);
  assert.deepEqual(p.allowedKinds,['search']);assert.equal(p.explicitApproval,false);
  assert.equal(p.unknownDownstreamRequestsApproved,false);
  assert.equal(p.laterStageCeilings.separateExactApprovalRequired,true);
  assert.ok(p.operations.every(o=>o.kind==='search'&&o.inputSha256===digest(o.request)));
  assert.equal(p.retainVideoFallbacks,true);assert.equal(p.includeTopicChannels,true);
});
test('approval binds the exact search requests, scope, code and forty-cent cap',()=>{
  const p=fixture(),opts={expectedPlanSha256:digest(p),capCents:40,approvedAt:'2026-11-13T19:01:00Z'};
  const approved=approveStagedSearch(p,opts);assertStagedSearchApproval(p,approved);
  assert.equal(p.explicitApproval,false);assert.equal(approved.approvedScope,'exact_twenty_searches_only');
  assert.throws(()=>approveStagedSearch(p,{...opts,capCents:200}));
  assert.throws(()=>approveStagedSearch(p,{...opts,expectedPlanSha256:'0'.repeat(64)}));
  for(const mutate of [
    p=>p.operations[0].request.body.q='changed artist',
    p=>p.operations[0].kind='metadata',p=>p.operations[0].profileId='999',
    p=>p.allowedKinds.push('video_uploader'),p=>p.operationalCapCents=200,
    p=>p.runtimeFiles['runtime/run.mjs']='c'.repeat(64),
    p=>p.explicitApproval=true,p=>p.unknownDownstreamRequestsApproved=true,
  ]){
    const changed=structuredClone(p);mutate(changed);
    assert.throws(()=>assertStagedSearchApproval(changed,approved));
  }
});
test('cohort substitutions, missing catalog bindings and unsafe archives fail closed',()=>{
  const p=fixture();
  for(const patch of [
    {artists:p.artists.slice(1)},{packets:p.packets.slice(1)},
    {artists:p.artists.map(()=>p.artists[0])},
    {artists:p.artists.map((a,i)=>i===0?{...a,tier:0}:a)},
    {packets:p.packets.map((a,i)=>i===0?{...a,cmArtist:'999'}:a)},
    {evidenceFiles:{'../escape.json':'a'.repeat(64)}},
  ])assert.throws(()=>stagedSearchPlan({...p,...patch}));
});
test('readiness excludes all previous admissions and any other active/uncertain YouTube work',async()=>{
  const artists=fixture().artists,parentId='paused-parent';
  const base={async query(sql,params){
    if(sql.includes('to_regclass'))return {rows:[{runs:null,admissions:null}]};
    if(sql.includes('SELECT status')){assert.deepEqual(params,[parentId]);return {rows:[{status:'stopped'}]};}
    if(sql.includes('ANY'))assert.deepEqual(params,[artists.map(a=>sql.includes('cm_artist')?a.cm_artist:a.profile_id)]);
    return {rows:[{n:0}]};
  }};
  await searchReadiness(base,artists,parentId);
  for(const target of [
    'youtube_discovery_test_runs','youtube_video_stage_runs','youtube_link_campaign_admissions',
    'youtube_bounded_test_admissions','youtube_video_stage_admissions','youtube_discovery_test_results',
  ]){
    await assert.rejects(()=>searchReadiness({async query(sql,params){
      if(sql.includes(target))return {rows:[{n:1}]};
      return base.query(sql,params);
    }},artists,parentId));
  }
  await assert.rejects(()=>searchReadiness({async query(){return {rows:[{status:'running'}]};}},artists,parentId));
});
test('readiness also fences active identity runs and previously checked identities',async()=>{
  const artists=fixture().artists,parentId='paused-parent';
  const client={async query(sql){
    if(sql.includes('to_regclass'))return {rows:[{runs:'runs',admissions:'admissions'}]};
    if(sql.includes('SELECT status'))return {rows:[{status:'stopped'}]};
    return {rows:[{n:0}]};
  }};
  await searchReadiness(client,artists,parentId);
  for(const target of ['youtube_video_identity_runs WHERE','youtube_video_identity_admissions WHERE',
    'WHERE cm_artist=ANY','WHERE a.cm_artist=ANY']){
    await assert.rejects(()=>searchReadiness({async query(sql,params){
      if(sql.includes(target))return {rows:[{n:1}]};
      return client.query(sql,params);
    }},artists,parentId));
  }
});
