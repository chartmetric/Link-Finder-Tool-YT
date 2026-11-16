import test from 'node:test';
import assert from 'node:assert/strict';
import {accountedChannelPlan,approveAccountedChannels} from './youtube-accounted-channel-plan.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
import {executeMixedCaptures} from './run-youtube-mixed-captures.mjs';
const url=n=>'https://www.youtube.com/channel/UC'+String(n).padStart(22,'a');
function fixture(){
  const records=Array.from({length:500},(_,i)=>{
    const n=i+1,a={profileId:String(n),cmArtist:String(n+1000),name:'Artist '+n,
      catalogProfile:{profile_id:String(n),cm_artist:String(n+1000)}};
    return {sourceRunId:i<90?'youtube-test-original-source':'youtube-search-continuation-source',
      sourceReceipt:'generated-artifacts/synthetic/receipt-'+n+'.json',receiptSha256:digest('receipt-'+n),
      record:{artist:a,tier:2,ownershipAccepted:false,
        candidates:i<5?[{url:url(n),title:a.name,source:'serper'}]:[],
        videoPlan:{resolutionQueue:i<8?[{url:'https://www.youtube.com/watch?v=12345678901'}]:[]}}};
  });
  return {id:'youtube-accounted-channel-checks-synthetic',sourceRoot:'generated-artifacts/youtube-accounted-channel-checks-synthetic',
    preparedAt:'2026-11-16T21:00:00Z',records,claims:[],
    currentRows:records.map(({record:{artist:a}})=>({profile_id:a.profileId,cm_artist:a.cmArtist,
      artist:a.name,tier:3,snapshot_at:'2026-11-16 00:00:00'})),
    sourceFiles:{'generated-artifacts/synthetic/results.json':digest('source')},
    runtimeFiles:{'runtime/run.mjs':digest('runtime')}};
}
test('new accounted-source policy selects one exact channel per artist and preserves Topic labels',()=>{
  const f=fixture(),r=f.records[0].record;
  r.candidates.push({...r.candidates[0]});
  r.candidates.push({url:url(501),title:r.artist.name+' - Topic'});
  f.records[1].record.candidates[0].title+=' - Topic';
  const p=accountedChannelPlan(f);
  assert.equal(p.operations.length,5);assert.equal(p.maximumSpendCents,10);
  assert.equal(p.alternatives.filter(a=>a.profileId==='1').length,2);
  assert.equal(p.selections[0].url,url(1));
  assert.match(p.selections[1].topicLabel,/^Topic — auto-generated/);
  assert.equal(p.remaining.length,495);assert.ok(p.remaining.every(r=>!r.processed&&!r.noMatch));
  assert.ok(p.alternatives.every(a=>!a.ownershipAccepted&&!a.importEligible));
  assert.ok(p.operations.every(o=>o.kind==='metadata'&&o.reservationCents===2&&
    o.request.url.startsWith('https://api.scrapecreators.com/v1/youtube/channel?')));
  assert.equal(p.executionEnabled,false);assert.equal(p.uploaderCalls,0);
  assert.deepEqual(accountedChannelPlan(p),p);
});
test('full-cohort and historical shared claims hold targets before selecting, not only within chunks',()=>{
  const f=fixture();
  f.records[499].record.candidates=[{url:url(1),title:'Artist 500'}];
  f.claims=[{url:url(2),profileId:'8888',cmArtist:'9999'}];
  const p=accountedChannelPlan(f);
  assert.equal(p.operations.length,3);
  assert.equal(p.alternatives.filter(a=>a.sharedChannelConflict).length,3);
  assert.ok(!p.selections.some(s=>['1','2','500'].includes(s.profileId)));
});
test('name mentions, changed identities, missing eligibility and stale snapshots are held, not matches',()=>{
  const f=fixture();
  f.records[0].record.candidates[0].title='A distributor mentioning Artist 1';
  f.currentRows[1].cm_artist='99999';
  f.currentRows[2].snapshot_at='2026-11-12 00:00:00';
  f.currentRows=f.currentRows.filter(r=>r.profile_id!=='4');
  const p=accountedChannelPlan(f);
  assert.equal(p.operations.length,1);assert.equal(p.operations[0].profileId,'5');
  assert.ok(p.remaining.every(r=>!r.processed&&!r.noMatch));
  assert.equal(p.selections[0].startingTier,2);assert.equal(p.selections[0].tier,3);
});
test('approval binds the new exact source, requests, runtime and price; legacy approval cannot carry over',async()=>{
  const p=accountedChannelPlan(fixture());
  const a=approveAccountedChannels(p,{planSha256:digest(p),capCents:10,approvedAt:'2026-11-16T21:01:00Z'});
  assert.equal(a.scope,'exact_channel_metadata_only_no_retries_no_catalog_writes');
  for(const patch of [{planSha256:digest('changed')},{capCents:12},{approvedAt:'2026-11-15T00:00:00Z'}])
    assert.throws(()=>approveAccountedChannels(p,{...a,...patch}));
  for(const patch of [{maximumSpendCents:12},{uploaderCalls:1},{runtimeFiles:{'runtime/run.mjs':digest('new')}}])
    assert.throws(()=>approveAccountedChannels({...p,...patch},a));
  // The shared worker rejects this new policy unless its dedicated validator
  // is supplied; the default legacy approval path is never widened.
  await assert.rejects(()=>executeMixedCaptures({plan:p,approval:a,credential:'synthetic'}));
  await assert.rejects(()=>executeMixedCaptures({plan:p,approval:{...a,capCents:12},credential:'synthetic',
    approvalCheck:(p,a)=>assert.deepEqual(approveAccountedChannels(p,a),a)}));
});
test('duplicate identities, source traversal and malformed current rows block preparation',()=>{
  for(const mutate of [
    f=>f.records.push(f.records[0]),
    f=>{f.records[1].record.artist.cmArtist=f.records[0].record.artist.cmArtist;},
    f=>{f.sourceFiles={'generated-artifacts/../outside.json':digest('bad')};},
    f=>f.currentRows.push(f.currentRows[0]),
  ]){
    const f=fixture();mutate(f);assert.throws(()=>accountedChannelPlan(f));
  }
});
