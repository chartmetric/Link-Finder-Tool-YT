import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {digest,prepareSavedAlternativeScope} from './instagram-next-saved-batch.mjs';
import {openSavedAlternativeBatchGate} from './instagram-saved-batch-gate.mjs';
import {runSavedAlternatives} from './instagram-saved-alternatives-runner.mjs';

const url=handle=>`https://www.instagram.com/${handle}/`;
const target=(id,handles)=>({
  artist:`Artist ${id}`,profileId:String(id),sourceCapturedAt:'2026-11-10',sourceArtistName:`Artist ${id}`,
  player:{profile_id:String(id),cm_artist:String(id),artist:`Artist ${id}`,accounts:[],
    source_identity_matches:true,catalog_profile:{profile_id:String(id),cm_artist:String(id)},
    savedCandidateUrls:handles.map(url)},
  candidates:handles.map(h=>({url:url(h),title:`Saved title ${h}`,snippet:'Search evidence only'})),
  context:{ownershipConfirmed:false,items:[]},
});
function freeze(targets,{cap=2000,alternatives=true}={}){
  return prepareSavedAlternativeScope(targets,{approved:true,budgetId:'new-test-only-parent',
    maxSpendCents:cap,candidateMetadataFetchesApproved:true,savedAlternativesApproved:alternatives},
    {inspectAlternatives:alternatives});
}
// Transactional coordinator fixture, not a pg connection or an HTTP fetch stub.
function coordinator(scope){
  const row={scope_sha256:digest(scope),cap_cents:scope.authorization.maxSpendCents,reserved_cents:0,owner:null};
  const keys=new Set();let before;
  return {row,keys,pool:{connect:async()=>({release(){},query:async(sql,p=[])=>{
    assert.doesNotMatch(sql,/instagram_pilot_/);
    if(sql==='BEGIN')before={row:structuredClone(row),keys:new Set(keys)};
    if(sql==='ROLLBACK'&&before){
      Object.assign(row,before.row);keys.clear();for(const k of before.keys)keys.add(k);
    }
    if(sql.startsWith('SELECT'))return {rows:[structuredClone(row)]};
    if(sql.includes('SET owner'))row.owner=p[1];
    if(sql.startsWith('INSERT')){
      if(keys.has(p[1]))throw Error('Duplicate non-replayable admission');
      keys.add(p[1]);
    }
    if(sql.includes('reserved_cents=reserved_cents+2'))row.reserved_cents+=2;
    return {rows:[]};
  }})}};
}
const metadata=u=>({cost:0.02,costBasis:'conservative_metadata_estimate',available:true,
  candidate:{url:u,displayName:'Captured artist',bio:'Captured bio',externalUrls:[]}});
const answer=(verdict='uncertain')=>({cost:0.001,model:'typesafe/jev-1.13-20260917',
  answers:[{verdict,sameIdentityProbability:0.5}]});
async function setup(t,scope,dispatch,priorMetadata=[]){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-alternatives-'));
  const db=coordinator(scope),calls=[],snapshots=[];
  const transport={live:true,dispatch:async r=>{
    calls.push(structuredClone(r));return dispatch(r,calls.length);
  }};
  const gate=await openSavedAlternativeBatchGate({pool:db.pool,scope,scopeSha256:digest(scope),
    transport,journalPath:path.join(dir,'journal'),priorMetadata});
  t.after(async()=>{await gate.close();await fs.rm(dir,{recursive:true,force:true});});
  const run=()=>runSavedAlternatives({scope,gate,persist:async s=>snapshots.push(s)});
  return {dir,db,calls,snapshots,gate,run,transport};
}
test('approved continuation preserves completed rows and reuses exact-account metadata without paid replay',async t=>{
  const scope=freeze([target(1,['shared']),target(2,['restricted']),target(3,['shared']),target(4,['fresh'])],
    {alternatives:false});
  let attempts=0;
  const first=await setup(t,scope,r=>{
    if(++attempts===3)throw Error('Confirmed restriction ended historical worker');
    return r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer('likely');
  });
  const archived=await first.run();
  assert.equal(archived.status,'stopped');
  assert.equal(archived.artists[2].candidates[0].status,'uninspected');
  const second=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'
    ?metadata(r.payload.body.url):answer('likely'),[metadata(url('shared'))]);
  const resumed=await runSavedAlternatives({scope,gate:second.gate,previousArtists:archived.artists,persist:async()=>{}});
  assert.equal(resumed.status,'completed');
  assert.deepEqual(resumed.artists.slice(0,2),archived.artists.slice(0,2));
  assert.equal(second.calls.length,3);
  assert.equal(second.calls.filter(r=>r.kind==='scrapecreators_candidate').length,1);
  assert.equal(second.calls[0].kind,'jev');
  assert.equal(resumed.artists[2].candidates[0].reason,'shared_handle_across_catalog_artists');
});
test('continuation rejects changed artist identity before any admission',async t=>{
  const scope=freeze([target(1,['one'])],{alternatives:false});
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer());
  const old=[{artist:'Wrong artist',profileId:'1',cmArtist:'1',candidates:[{url:url('one'),status:'uninspected'}]}];
  await assert.rejects(runSavedAlternatives({scope,gate:f.gate,previousArtists:old,persist:async()=>{}}),/do not match/);
  assert.equal(f.calls.length,0);
});
test('round robin gives all first candidates a turn before saved alternatives; no discovery or imports',async t=>{
  const scope=freeze([target(1,['a1','a2','a3']),target(2,['b1','b2']),target(3,[])]);
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'
    ?(r.payload.body.url===url('a1')?{cost:0.02,available:false,reason:'restricted'}:metadata(r.payload.body.url))
    :answer(r.payload.body.state.savedSearchEvidence.url===url('a3')?'likely':'uncertain'));
  const result=await f.run();
  assert.deepEqual(f.calls.filter(c=>c.kind==='scrapecreators_candidate').map(c=>c.payload.body.url),
    ['a1','b1','a2','b2','a3'].map(url));
  assert.ok(f.calls.every(c=>['scrapecreators_candidate','jev'].includes(c.kind)));
  assert.equal(result.artists[0].candidates[0].status,'unavailable');
  assert.equal(result.artists[0].status,'positive_review_suggestion');
  assert.equal(result.artists[1].status,'inconclusive');
  assert.equal(result.artists[2].status,'no_saved_candidate');
  assert.equal(result.liveLinkChanges,0);assert.equal(result.newSearches,0);
  assert.equal(f.db.row.reserved_cents,f.calls.length*2);
});
test('opt-in is mandatory and the first-only option leaves alternatives uninspected',async t=>{
  const scope=freeze([target(1,['first','second'])],{alternatives:false});
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer());
  const result=await f.run();
  assert.equal(f.calls.length,2);assert.equal(result.artists[0].candidates[1].status,'uninspected');
  assert.throws(()=>prepareSavedAlternativeScope(scope.targets,{...scope.authorization,savedAlternativesApproved:false},
    {inspectAlternatives:true}),/approval/);
  const g=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  await assert.rejects(g.gate.request({profileId:'1',kind:'scrapecreators_candidate',url:url('second')}),/outside/);
  assert.equal(g.calls.length,0);
});
test('total parent budget bounds BOTH providers and does not allocate alternatives ahead of first turns',async t=>{
  const scope=freeze([target(1,['a1','a2']),target(2,['b1','b2'])],{cap:6});
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer());
  const result=await f.run();
  assert.equal(result.budgetExhausted,true);assert.equal(result.budget.reservedCents,6);
  assert.deepEqual(f.calls.map(c=>c.kind),['scrapecreators_candidate','jev','scrapecreators_candidate']);
  assert.equal(result.artists[1].candidates[0].reason,'parent_budget_exhausted_before_verification');
  assert.ok(result.artists.every(a=>a.candidates[1].status==='uninspected'));
  assert.equal(result.budget.reportedCostUsd,0.001);assert.equal(result.budget.estimatedCostUsd,0.04);
});
test('already exhausted parent never dispatches; a new owner cannot replenish a claimed parent',async t=>{
  const scope=freeze([target(1,['a1'])],{cap:2});
  const f=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  f.db.row.reserved_cents=2;
  // The runner's snapshot is advisory; the transactional check is authoritative.
  const result=await f.run();
  assert.equal(result.status,'stopped');assert.match(result.stopReason,/cap reached/);
  assert.equal(f.calls.length,0);assert.equal(f.db.row.reserved_cents,2);
  await assert.rejects(openSavedAlternativeBatchGate({pool:f.db.pool,scope,scopeSha256:digest(scope),
    transport:f.transport,journalPath:path.join(f.dir,'new-owner')}),/already claimed/);
});
test('shared handles reuse ONLY exact-account metadata, never another artist verdict or ownership',async t=>{
  const scope=freeze([target(1,['shared','distinct']),target(2,['shared'])]);
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer('likely'));
  const result=await f.run();
  assert.deepEqual(f.calls.map(c=>c.kind),['scrapecreators_candidate','jev','jev','scrapecreators_candidate','jev']);
  assert.ok(result.artists.every(a=>a.candidates[0].reason==='shared_handle_across_catalog_artists'));
  assert.ok(result.artists.every(a=>!a.candidates[0].review.reviewSuggestion));
  assert.equal(result.artists[0].candidates[1].status,'positive_review_suggestion');
  const verifies=f.calls.filter(c=>c.kind==='jev');
  assert.notEqual(verifies[0].payload.inputSha256,verifies[1].payload.inputSha256);
  assert.equal(verifies[2].payload.body.state.savedSearchEvidence.title,'Saved title distinct');
});
test('acknowledged partial failures keep receipts and let untouched artists/alternatives continue',async t=>{
  const scope=freeze([target(1,['bad','replacement']),target(2,['good'])]);
  const f=await setup(t,scope,r=>{
    if(r.kind==='scrapecreators_candidate')return r.payload.body.url===url('bad')
      ?{cost:0.02,costBasis:'conservative_metadata_estimate',available:false,reason:'acknowledged_provider_server_error_not_retried'}
      :metadata(r.payload.body.url);
    return answer('likely');
  });
  const result=await f.run();
  assert.deepEqual(f.calls.filter(c=>c.kind==='scrapecreators_candidate').map(c=>c.payload.body.url),
    ['bad','good','replacement'].map(url));
  assert.equal(result.status,'completed');
  assert.equal(result.artists[0].candidates[0].status,'unavailable');
  assert.equal(result.artists[1].status,'positive_review_suggestion');
  assert.equal(f.db.row.reserved_cents,10);
});
for(const phase of ['scrapecreators_candidate','jev']){
  test(`uncertain ${phase} admission stops globally, keeps earlier results and is never replayed`,async t=>{
    const scope=freeze([target(1,['good']),target(2,['uncertain','alternative']),target(3,['untouched'])]);
    const f=await setup(t,scope,r=>{
      const u=r.payload.body.url??r.payload.body.state.savedSearchEvidence.url;
      if(u===url('uncertain')&&r.kind===phase)throw Error('Unknown provider outcome');
      return r.kind==='scrapecreators_candidate'?metadata(u):answer('likely');
    });
    const result=await f.run();
    assert.equal(result.status,'stopped');
    assert.equal(result.artists[0].status,'positive_review_suggestion');
    assert.equal(result.artists[1].candidates[0].reason,'interrupted_or_uncertain_no_retry');
    assert.equal(result.artists[1].candidates[1].status,'uninspected');
    assert.equal(result.artists[2].status,'uninspected');
    const count=f.calls.length;
    await assert.rejects(f.gate.request({profileId:'2',kind:phase,url:url('uncertain')}),/stopped/);
    assert.equal(f.calls.length,count);assert.equal(f.db.row.reserved_cents,count*2);
    const journal=(await fs.readFile(path.join(f.dir,'journal'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(journal.at(-1).phase,'stopped_no_retry');
  });
}
test('unsupported mismatch, unavailable, uninspected, and no saved candidate stay distinct',async t=>{
  const scope=freeze([target(1,['mismatch','held']),target(2,['missing']),target(3,[])]);
  const f=await setup(t,scope,r=>r.kind==='jev'?answer('mismatch'):r.payload.body.url===url('missing')
    ?{cost:0.02,available:false,reason:'profile_unavailable_or_restricted'}:metadata(r.payload.body.url));
  const result=await f.run();
  assert.equal(result.artists[0].status,'unsupported');
  assert.equal(result.artists[0].candidates[1].status,'uninspected');
  assert.equal(result.artists[1].status,'unavailable');
  assert.equal(result.artists[2].status,'no_saved_candidate');
});
test('foreign metadata cannot seed the cache or authorize verification',async t=>{
  const scope=freeze([target(1,['requested','other'])]);
  const f=await setup(t,scope,()=>metadata(url('other')));
  const result=await f.run();
  assert.equal(result.status,'stopped');assert.match(result.stopReason,/exact requested account/);
  assert.equal(f.calls.length,1);assert.equal(f.db.row.reserved_cents,2);
  const g=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  await assert.rejects(g.gate.request({profileId:'1',kind:'jev',url:url('requested')}),/exact-account/);
  assert.equal(g.calls.length,0);
});
test('duplicate metadata admissions cannot be replayed even after completed receipts',async t=>{
  const scope=freeze([target(1,['shared']),target(2,['shared'])]);
  const f=await setup(t,scope,r=>metadata(r.payload.body.url));
  await f.gate.request({profileId:'1',kind:'scrapecreators_candidate',url:url('shared')});
  await assert.rejects(f.gate.request({profileId:'2',kind:'scrapecreators_candidate',url:url('shared')}),/Duplicate/);
  assert.equal(f.calls.length,1);assert.equal(f.db.row.reserved_cents,2);
});
test('output failures stop before any next provider admission',async t=>{
  const scope=freeze([target(1,['first','alternative']),target(2,['untouched'])]);
  const f=await setup(t,scope,r=>metadata(r.payload.body.url));
  await assert.rejects(runSavedAlternatives({scope,gate:f.gate,persist:async()=>{throw Error('Archive unavailable');}}),
    /Archive unavailable/);
  assert.equal(f.calls.length,1);assert.equal(f.gate.snapshot().stopped,true);
});
test('lost reservation commit acknowledgement is uncertain even before provider dispatch',async t=>{
  const scope=freeze([target(1,['first','alternative'])]);
  const f=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  const connect=f.db.pool.connect;
  f.db.pool.connect=async()=>{
    const client=await connect(),query=client.query;
    return {...client,query:async(sql,p)=>{
      const result=await query(sql,p);
      if(sql==='COMMIT')throw Error('Lost commit acknowledgement');
      // A rollback after a committed transaction cannot undo its reservation.
      return result;
    }};
  };
  // Model PostgreSQL ROLLBACK after successful COMMIT as a no-op.
  const wrapper=f.db.pool.connect;
  f.db.pool.connect=async()=>{
    const client=await wrapper();let committed=false;
    const query=client.query;
    return {...client,query:async(sql,p)=>{
      if(sql==='ROLLBACK'&&committed)return {rows:[]};
      if(sql==='COMMIT')committed=true;
      return query(sql,p);
    }};
  };
  const result=await f.run();
  assert.equal(result.status,'stopped');assert.match(result.stopReason,/Lost commit/);
  assert.equal(f.db.row.reserved_cents,2);assert.equal(f.db.keys.size,1);assert.equal(f.calls.length,0);
  await assert.rejects(f.gate.request({profileId:'1',kind:'scrapecreators_candidate',url:url('first')}),/stopped/);
});
test('exact frozen scope and provider kinds are enforced before dispatch',async t=>{
  const scope=freeze([target(1,['first'])]);
  const f=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  const changed=structuredClone(scope);changed.expectedModel='changed-model';
  const result=await runSavedAlternatives({scope:changed,gate:f.gate,persist:async()=>{}});
  assert.equal(result.status,'stopped');assert.match(result.stopReason,/frozen approval/);
  assert.equal(f.calls.length,0);
  const g=await setup(t,scope,()=>{throw Error('Must not dispatch');});
  await assert.rejects(g.gate.request({profileId:'1',kind:'discovery',url:url('first')}),/No discovery/);
  assert.equal(g.calls.length,0);assert.equal(g.db.row.reserved_cents,0);
});
test('durable admissions freeze the generated verifier body and search provenance before dispatch',async t=>{
  const scope=freeze([target(1,['first'])]);
  const f=await setup(t,scope,r=>r.kind==='scrapecreators_candidate'?metadata(r.payload.body.url):answer());
  await f.run();
  const rows=(await fs.readFile(path.join(f.dir,'journal'),'utf8')).trim().split('\n').map(JSON.parse);
  const verifier=rows.find(r=>r.phase==='admitted'&&r.request.kind==='jev').request;
  assert.equal(verifier.sha256,digest(verifier.body));
  assert.equal(verifier.body.state.savedSearchEvidence.url,url('first'));
  assert.equal(verifier.body.state.savedSearchEvidence.title,'Saved title first');
  assert.equal(JSON.stringify(verifier.body),JSON.stringify(f.calls.find(c=>c.kind==='jev').payload.body));
});
test('CLI preview validates the new scope without credentials, database access, providers or output creation',async t=>{
  const scope=freeze([target(1,['first','alternative'])]);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'saved-alternatives-preview-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'scope.json'),out=path.join(dir,'never-created');
  await fs.writeFile(file,JSON.stringify(scope));
  const result=JSON.parse(execFileSync(process.execPath,
    [new URL('./instagram-saved-alternatives-cli.mjs',import.meta.url).pathname,file,out],
    {env:{},encoding:'utf8'}));
  assert.equal(result.paidCalls,0);assert.equal(result.newSearches,0);assert.equal(result.liveLinkChanges,0);
  assert.equal(result.inspectSavedAlternatives,true);assert.equal(result.scopeSha256,digest(scope));
  await assert.rejects(fs.stat(out),{code:'ENOENT'});
});
