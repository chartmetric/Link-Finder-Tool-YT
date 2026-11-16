import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {accountedChannelPlan,approveAccountedChannels} from './youtube-accounted-channel-plan.mjs';
import {accountedChannelGroups,approveAccountedGroups,groupApproval} from './youtube-accounted-channel-groups.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
function fixture(){
  const records=Array.from({length:500},(_,i)=>{
    const a={name:'Artist '+i,profileId:String(i+1),cmArtist:String(i+1001),
      catalogProfile:{profile_id:String(i+1),cm_artist:String(i+1001)}};
    return {sourceRunId:'youtube-test-synthetic-source',sourceReceipt:'generated-artifacts/test/receipt-'+i+'.json',
      receiptSha256:digest('receipt'+i),record:{artist:a,tier:2,ownershipAccepted:false,
        candidates:i<47?[{title:a.name,url:'https://www.youtube.com/channel/UC'+String(i).padStart(22,'a')}]:[],
        videoPlan:{resolutionQueue:[]}}};
  });
  const files={'generated-artifacts/test/source.json':digest('source')},runtimeFiles={'runtime/run.mjs':digest('runtime')};
  const sourcePlan=accountedChannelPlan({id:'youtube-accounted-channel-checks-synthetic',preparedAt:'2026-11-16T21:00:00Z',
    sourceRoot:'generated-artifacts/youtube-accounted-channel-checks-synthetic',records,claims:[],
    currentRows:records.map(r=>({profile_id:r.record.artist.profileId,cm_artist:r.record.artist.cmArtist,
      artist:r.record.artist.name,tier:2,snapshot_at:'2026-11-16 00:00:00'})),sourceFiles:files,runtimeFiles});
  const sourceApproval=approveAccountedChannels(sourcePlan,{planSha256:digest(sourcePlan),capCents:94,
    approvedAt:'2026-11-16T21:01:00Z'});
  return {id:'youtube-accounted-channel-groups-synthetic',preparedAt:'2026-11-16T22:00:00Z',
    sourcePlan,sourceApproval,previousAttempt:{runs:[],admissions:[{n:0,reserved_cents:0}]},
    sourceFiles:files,runtimeFiles};
}
test('aggregate preserves exact requests and approval scope while each run stays within forty cents',()=>{
  const f=fixture(),p=accountedChannelGroups(f);
  assert.deepEqual(p.groups.map(g=>g.maximumCalls),[20,20,7]);
  assert.deepEqual(p.groups.map(g=>g.maximumSpendCents),[40,40,14]);
  assert.deepEqual(p.groups.flatMap(g=>g.operations),f.sourcePlan.operations);
  assert.equal(p.maximumCalls,47);assert.equal(p.maximumSpendCents,94);
  assert.ok(p.groups.every(g=>!g.executionEnabled&&g.noRetries&&g.noCatalogWrites));
  assert.deepEqual(accountedChannelGroups(p),p);
});
test('source paid allocations or existing ownership block re-packaging a failed launch',()=>{
  for(const previousAttempt of [{runs:[{id:'occupied'}],admissions:[{n:0,reserved_cents:0}]},
    {runs:[],admissions:[{n:1,reserved_cents:2}]}]){
    assert.throws(()=>accountedChannelGroups({...fixture(),previousAttempt}));
  }
});
test('changed executor needs fresh approval and each group is bound to that exact approval',()=>{
  const f=fixture(),p=accountedChannelGroups(f);
  assert.throws(()=>approveAccountedGroups(p,f.sourceApproval),'Original launch approval is not group execution permission');
  const a=approveAccountedGroups(p,{planSha256:digest(p),capCents:94,approvedAt:'2026-11-16T22:01:00Z'});
  const g=groupApproval(p,a,p.groups[0]);assert.equal(g.capCents,40);
  assert.equal(g.parentPlanSha256,digest(p));assert.equal(g.parentApprovalSha256,digest(a));
  const tampered=structuredClone(p);tampered.groups[0].operations[0].targetUrl='https://www.youtube.com/@other';
  assert.throws(()=>approveAccountedGroups(tampered,a));
  assert.throws(()=>groupApproval(p,a,{...p.groups[0],maximumSpendCents:42}));
  const changed=accountedChannelGroups({...f,runtimeFiles:{'runtime/run.mjs':digest('changed')}});
  assert.throws(()=>approveAccountedGroups(changed,a));
});
test('an oversized flat run is rejected before opening a connection or making a request',async()=>{
  const {sourcePlan,sourceApproval}=fixture();
  await assert.rejects(()=>executeMixedCaptures({plan:sourcePlan,approval:sourceApproval,credential:'synthetic',
    approvalCheck:(p,a)=>assert.deepEqual(approveAccountedChannels(p,a),a),
    assertFrozen:()=>assert.fail('Must stop before runtime or database operations')}),
  /at most twenty checks/);
});
