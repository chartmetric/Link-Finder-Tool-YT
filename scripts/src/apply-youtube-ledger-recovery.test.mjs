import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRecoveryTransaction,recoveredLedger,assertRecoverySnapshot} from './apply-youtube-ledger-recovery.mjs';

function fixture(){
  const prior={run_id:'old-run',operation_key:'already-returned',profile_id:'1',cm_artist:'2',
    video_id:'abcdefghijk',input_sha256:'a'.repeat(64),status:'returned',
    receipt_sha256:'b'.repeat(64),raw_sha256:'c'.repeat(64),http_status:200};
  const pending={...prior,operation_key:'saved-pending',profile_id:'3',cm_artist:'4',
    video_id:'lmnopqrstuv',status:'admitted',receipt_sha256:null,raw_sha256:null,http_status:null};
  const proposal={ledger:{
    campaign:[{id:'paused-parent',status:'stopped'}],
    runs:[{id:'old-run',owner:'original-owner',plan_sha256:'d'.repeat(64),
      approval_sha256:'e'.repeat(64),cap_cents:8,reserved_cents:4,status:'stopped'}],
    admissions:[prior,pending],activeTests:[],pendingTests:[],
  },proposedAcknowledgment:{runId:'old-run',operationKey:'saved-pending',
    receiptSha256:'f'.repeat(64),rawSha256:'0'.repeat(64)}};
  const state=structuredClone(proposal.ledger),events=[];let before,updates=0,installs=0,checks=0;
  const client={async query(sql,params=[]){
    events.push(sql.split(/\s+/).slice(0,2).join(' '));
    if(sql==='BEGIN'){before=structuredClone(state);return {};}
    if(sql==='ROLLBACK'){Object.assign(state,before);return {};}
    if(sql==='COMMIT'||sql.startsWith('SET LOCAL')||sql.startsWith('LOCK TABLE'))return {};
    if(sql.includes('SELECT status FROM youtube_link_campaigns'))return {rows:[{status:state.campaign[0].status}]};
    if(sql.includes('FROM youtube_link_campaigns'))return {rows:structuredClone(state.campaign)};
    if(sql.includes('FROM youtube_video_stage_runs'))return {rows:structuredClone(state.runs)};
    if(sql.includes('FROM youtube_video_stage_admissions'))return {rows:structuredClone(state.admissions)};
    if(sql.includes('FROM youtube_discovery_test_runs'))return {rows:structuredClone(state.activeTests)};
    if(sql.includes('FROM youtube_bounded_test_admissions'))return {rows:structuredClone(state.pendingTests)};
    if(sql.startsWith('UPDATE youtube_video_stage_admissions')){
      assert.deepEqual(params,['old-run','saved-pending','3','4','lmnopqrstuv','a'.repeat(64),'f'.repeat(64),'0'.repeat(64)]);
      updates++;Object.assign(state.admissions[1],recoveredLedger(proposal).admissions[1]);return {rowCount:1};
    }
    assert.fail('Unexpected SQL: '+sql);
  }};
  return {proposal,state,events,client,get updates(){return updates;},
    get installs(){return installs;},get checks(){return checks;},
    verifySource:async()=>{checks++;},installResult:async()=>{installs++;}};
}
test('recovery updates one acknowledgment under locks with no run/reservation changes',async()=>{
  const f=fixture(),before=structuredClone(f.state);
  const result=await applyRecoveryTransaction(f);
  assert.equal(result.acknowledgmentChanges,1);assert.equal(result.providerCalls,0);
  assert.equal(result.ownershipAccepted,false);assert.equal(result.runResumed,false);
  assert.equal(f.updates,1);assert.equal(f.installs,1);assert.equal(f.checks,2);
  assert.deepEqual(f.state.runs,before.runs);assert.deepEqual(f.state.admissions[0],before.admissions[0]);
  assert.deepEqual(f.state,recoveredLedger(f.proposal));
  assert.equal(f.events.at(-1),'COMMIT');
});
test('idempotent recovery verifies the exact prior acknowledgment without another update',async()=>{
  const f=fixture();Object.assign(f.state,recoveredLedger(f.proposal));
  const result=await applyRecoveryTransaction(f);
  assert.equal(result.alreadyApplied,true);assert.equal(result.acknowledgmentChanges,0);
  assert.equal(f.updates,0);assert.equal(f.installs,1);
});
test('ledger drift blocks the write and rolls back, including new or uncertain work',async()=>{
  for(const mutate of [
    s=>s.campaign[0].status='running',
    s=>s.runs[0].owner='other-owner',
    s=>s.runs[0].reserved_cents=0,
    s=>s.runs[0].status='running',
    s=>s.activeTests.push({id:'another-test'}),
    s=>s.pendingTests.push({run_id:'other-run',operation_key:'uncertain'}),
    s=>s.admissions[0].receipt_sha256='9'.repeat(64),
    s=>s.admissions.push({...s.admissions[1],operation_key:'different'}),
  ]){
    const f=fixture();mutate(f.state);
    await assert.rejects(()=>applyRecoveryTransaction(f));
    assert.equal(f.updates,0);assert.equal(f.installs,0);assert.equal(f.events.at(-1),'ROLLBACK');
  }
});
test('source or local-result persistence failures roll back the acknowledgment',async()=>{
  for(const where of ['before','install','after']){
    const f=fixture();let count=0;
    await assert.rejects(()=>applyRecoveryTransaction({...f,
      verifySource:async()=>{count++;if(where==='before'||where==='after'&&count===2)throw Error('evidence changed');},
      installResult:async()=>{if(where==='install')throw Error('disk failed');},
    }));
    assert.equal(f.state.admissions[1].status,'admitted');
    assert.equal(f.state.runs[0].reserved_cents,4);
    assert.equal(f.events.at(-1),'ROLLBACK');
  }
});
test('a different acknowledgment cannot masquerade as an idempotent recovery',()=>{
  const f=fixture(),changed=recoveredLedger(f.proposal);
  changed.admissions[1].receipt_sha256='1'.repeat(64);
  assert.throws(()=>assertRecoverySnapshot(f.proposal,changed));
});
