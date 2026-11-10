import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contextualTestPair} from './instagram-contextual-test-prep.mjs';
import {preflightContextualComparison,executeContextualComparison} from './instagram-contextual-test-run.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {CORROBORATED_POLICY,IDENTITY_CONTEXT_POLICY} from './musician-instagram-matching.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>hash(JSON.stringify(v));
const write=(file,v)=>fs.writeFile(file,JSON.stringify(v,null,2));
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
// Any accidental default HTTP dispatch fails, even on machines with credentials.
globalThis.fetch=()=>{throw Error('Ordinary tests must never use the network.');};

// Transactional fake: tests cannot connect to PostgreSQL or alter real budgets.
function coordinator(){
  const budgets=new Map(),admissions=new Map(),queries=[];
  let tail=Promise.resolve();
  const insert=async(sql,p)=>{
    queries.push(sql);assert.doesNotMatch(sql,/instagram_pilot_|UPDATE.*cap_cents|DELETE/i);
    if(sql.startsWith('INSERT INTO instagram_saved_batch_budgets')){
      if(!budgets.has(p[0]))budgets.set(p[0],{scope_sha256:p[1],cap_cents:p[2],reserved_cents:0,owner:null});
      return {rows:[]};
    }
    throw Error('Unexpected pool query');
  };
  return {budgets,admissions,queries,query:insert,connect:async()=>{
    let unlock,local,keys;
    return {release(){},async query(sql,p){
      queries.push(sql);assert.doesNotMatch(sql,/instagram_pilot_|DELETE/i);
      if(sql==='BEGIN'){
        const prev=tail;tail=new Promise(resolve=>{unlock=resolve;});await prev;
        local=structuredClone(budgets);keys=structuredClone(admissions);
      }else if(sql==='COMMIT'){
        budgets.clear();for(const [k,v] of local)budgets.set(k,v);
        admissions.clear();for(const [k,v] of keys)admissions.set(k,v);
        unlock();unlock=null;
      }else if(sql==='ROLLBACK'){unlock?.();unlock=null;}
      else if(sql.startsWith('SELECT'))return {rows:local.has(p[0])?[{...local.get(p[0])}]:[]};
      else if(sql.includes('SET owner'))local.get(p[0]).owner=p[1];
      else if(sql.startsWith('INSERT INTO instagram_saved_batch_admissions')){
        const key=JSON.stringify([p[0],p[1]]);if(keys.has(key))throw Error('Duplicate admission');
        keys.set(key,{profileId:p[2],cents:p[3]});
      }else if(sql.includes('reserved_cents=reserved_cents+2'))local.get(p[0]).reserved_cents+=2;
      else assert.ok(sql.startsWith('SET LOCAL'),'Unexpected fake SQL: '+sql);
      return {rows:[]};
    }};
  }};
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'contextual-run-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
  const url='https://www.instagram.com/target_artist/';
  const profile={url,identityComparison:{reference:{platform:'spotify',url:music},
    status:'likely',reasons:['historical result untouched'],
    candidate:{url,displayName:'Target Artist',bio:'Musician.',directExternalUrls:[],externalUrls:[]}},
    jevVerification:{sameIdentityProbability:0.77,verdict:'likely'}};
  const target={key:'target',role:'candidate',status:'prepared',profileId:'1',artist:'Target Artist',url,profile,
    player:{profile_id:'1',artist:'Target Artist',account_ids:['1'],accounts:[{account_id:'1',platform:'spotify',account_url:music}]},
    context:{ownershipConfirmed:false,items:[{kind:'release',source:'saved_catalog',text:'A saved release',
      binding:'profile_only',asOf:'2026-01-01'}]}};
  const donorProfile=structuredClone(profile);
  donorProfile.url=donorProfile.identityComparison.candidate.url='https://www.instagram.com/control_artist/';
  donorProfile.identityComparison.candidate.displayName='Control Artist';
  const control={key:'control',role:'control',status:'prepared',sourceProfileId:'2',
    sourceArtist:'Control Artist',url:donorProfile.url,profile:donorProfile};
  const source=[target,control],original={expectedModel:'resolved-fixed'};
  const requests=[];
  for(const s of source)for(const r of contextualTestPair(target,s.profile))
    requests.push({...r,key:`${s.role}-${r.variant}`,role:s.role,sourceKey:s.key,sourceProfileId:s.sourceProfileId??s.profileId,
      profileId:'1',artist:target.artist,instagramUrl:s.url});
  const manifest={version:1,preparationOnly:true,
    authorization:{approved:false,requiresNewApproval:true,existingBudgetReuseAllowed:false,
      conservativeCentsPerRequest:2,requestedMaximumSpendCents:8},
    sourceRowsSha256:digest(source),sourceScopeSha256:digest(original),
    codeHashes:{'instagram-contextual-test-prep.mjs':hash(await fs.readFile(new URL('./instagram-contextual-test-prep.mjs',import.meta.url)))},
    expectedModel:'resolved-fixed',requests,artists:1,distinctControlAccounts:1,controlSourceArtists:1,
    policyByVariant:{current:CORROBORATED_POLICY,fuller_metadata:IDENTITY_CONTEXT_POLICY},
    comparison:'Metadata and rubric change together; not calibrated accuracy.',
    selection:[{profileId:'1',artist:target.artist,url}]};
  const manifestPath=path.join(dir,'manifest.json'),approvalPath=path.join(dir,'approval.json');
  await write(manifestPath,manifest);await write(path.join(dir,'scope.json'),original);
  await write(path.join(dir,'source-rows.json'),source);
  const prepared=await preflightContextualComparison({manifestPath,batchDir:dir});
  const approval={...prepared.report.approvalTemplate,approved:true,budgetId:'contextual-comparison-mock-approval',approvalReference:'Mock-only approval'};
  await write(approvalPath,approval);
  const calls=[],pool=coordinator();
  const transport={live:true,dispatch:async({key})=>{
    calls.push(key);return {model:'resolved-fixed',cost:0.001,answers:[{sameIdentityProbability:0.1,verdict:'mismatch',
      verdictLabelConfidence:0.8,verdictProbabilities:{mismatch:0.8,uncertain:0.2}}]};
  }};
  const args={manifestPath,batchDir:dir,approvalPath,outputDir:path.join(dir,'output'),pool,transport};
  return {dir,args,manifest,approval,source,calls,pool,transport,run:overrides=>executeContextualComparison({...args,...overrides})};
}
test('preflight is local; controls precede targets; full metadata and fresh scores are exported without source changes',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.dir,'source-rows.json'),'utf8');
  assert.equal(f.calls.length,0);assert.equal(f.pool.queries.length,0);
  const summary=await f.run();
  assert.equal(summary.status,'completed');assert.equal(summary.maximumSpendCents,8);
  assert.deepEqual(f.calls,['control-current','control-fuller_metadata','candidate-current','candidate-fuller_metadata']);
  assert.equal(summary.budget.reservedCents,8);
  const rows=await read(path.join(f.args.outputDir,'findings.json'));
  assert.equal(rows.length,4);
  for(const r of rows){
    assert.equal(r.score,0.1);assert.equal(r.verdictLabelConfidence,0.8);
    assert.equal(r.verdictProbabilities.mismatch,0.8);assert.equal(r.liveLinkChanged,false);
    assert.deepEqual(r.completeRequest,JSON.parse(JSON.stringify(f.manifest.requests.find(q=>q.key===r.key).body)));
    assert.deepEqual(r.metadataActuallySupplied,r.completeRequest.state.artistContext);
  }
  assert.match(await fs.readFile(path.join(f.args.outputDir,'artist-instagram-findings.csv'),'utf8'),/A saved release/);
  assert.equal(await fs.readFile(path.join(f.dir,'source-rows.json'),'utf8'),before);
  await assert.rejects(f.run(),/EEXIST/);
  const replay=await f.run({outputDir:path.join(f.dir,'attempted-replay')});
  assert.equal(replay.status,'stopped');assert.equal(f.calls.length,4);
});
test('separate approval must bind exact manifest, ceiling, model and current code before any coordinator call',async t=>{
  const f=await fixture(t);
  for(const change of [{approved:false},{manifestSha256:'changed'},{maxSpendCents:10},
    {expectedModel:'other'},{codeFingerprint:'changed'},{budgetId:'pilot-existing'},{approvalReference:''}]){
    await write(f.args.approvalPath,{...f.approval,...change});
    await assert.rejects(f.run());
  }
  assert.equal(f.pool.queries.length,0);assert.equal(f.calls.length,0);
  await assert.rejects(fs.stat(f.args.outputDir),/ENOENT/);
});
test('tampered requests, source evidence and preparation code bindings fail closed before spend',async t=>{
  const f=await fixture(t);
  for(const mutate of [
    m=>{m.requests[0].body.state.artist='tampered';},
    m=>{m.requests[0].role='arbitrary';},
    m=>{m.codeHashes['instagram-contextual-test-prep.mjs']='changed';},
    m=>{m.requests[0].key='../escape';},
    m=>{m.requests.pop();},
    m=>{m.sourceRowsSha256='changed';},
  ]){
    const m=structuredClone(f.manifest);mutate(m);await write(f.args.manifestPath,m);
    await assert.rejects(f.run());
  }
  assert.equal(f.pool.queries.length,0);assert.equal(f.calls.length,0);
});
test('high-scoring control stops immediately and preserves fresh decision and unused allowance',async t=>{
  const f=await fixture(t);
  f.transport.dispatch=async({key})=>{f.calls.push(key);return {model:'resolved-fixed',cost:0.001,
    answers:[{sameIdentityProbability:0.91,verdict:'likely'}]};};
  const summary=await f.run();
  assert.equal(summary.stopReason,'control_promoted');assert.equal(f.calls.length,1);
  assert.equal(summary.budget.reservedCents,2);
  const rows=await read(path.join(f.args.outputDir,'findings.json'));assert.equal(rows[0].score,0.91);
});
test('resolved model drift stops before targets but archives the changed response and its score',async t=>{
  const f=await fixture(t),normal=f.transport.dispatch;
  f.transport.dispatch=async args=>({...await normal(args),model:'changed-model'});
  const summary=await f.run();
  assert.equal(summary.stopReason,'model_changed');assert.equal(f.calls.length,1);
  const rows=await read(path.join(f.args.outputDir,'findings.json'));
  assert.equal(rows[0].modelMatches,false);assert.equal(rows[0].score,0.1);
  assert.match(await fs.readFile(path.join(f.args.outputDir,'results.jsonl'),'utf8'),/changed-model/);
});
test('code changes between requests prevent further paid admissions',async t=>{
  const f=await fixture(t);let checks=0;
  const summary=await f.run({fingerprint:async()=>++checks===1?f.approval.codeFingerprint:'changed'});
  assert.equal(summary.stopReason,'code_or_deadline_check');assert.equal(f.calls.length,1);
  assert.equal(summary.budget.reservedCents,2);
});
test('uncertain dispatch after a returned response keeps partial files, reserves both calls and cannot replay',async t=>{
  const f=await fixture(t),normal=f.transport.dispatch;
  f.transport.dispatch=async args=>{
    if(f.calls.length===1){f.calls.push(args.key);throw Error('Unknown paid outcome');}
    return normal(args);
  };
  const summary=await f.run();
  assert.equal(summary.stopReason,'dispatch_or_response_uncertain');assert.equal(summary.completedResponses,1);
  assert.equal(summary.budget.reservedCents,4);
  assert.equal((await read(path.join(f.args.outputDir,'findings.json'))).length,1);
  assert.match(await fs.readFile(path.join(f.args.outputDir,'admissions.jsonl'),'utf8'),/stopped_no_retry/);
  const replay=await f.run({outputDir:path.join(f.dir,'new-directory')});
  assert.equal(replay.status,'stopped');assert.equal(f.calls.length,2);
});
test('exclusive durable ownership prevents two executors spending on one approval',async t=>{
  const f=await fixture(t);
  const summaries=await Promise.all([f.run(),f.run({outputDir:path.join(f.dir,'parallel-output')})]);
  assert.equal(summaries.filter(s=>s.status==='completed').length,1);
  assert.equal(f.calls.length,4);assert.equal(f.pool.admissions.size,4);
});
test('one failed terminal export does not discard other partial outputs or refund admissions',async t=>{
  const f=await fixture(t),normal=f.transport.dispatch;
  f.transport.dispatch=async args=>{
    const response=await normal(args);
    if(f.calls.length===1)await fs.mkdir(path.join(f.args.outputDir,'findings.json'));
    return {...response,model:'changed-model'};
  };
  await assert.rejects(f.run(),/Partial archive persistence failed/);
  const summary=await read(path.join(f.args.outputDir,'summary.json'));
  assert.equal(summary.budget.reservedCents,2);
  assert.match(await fs.readFile(path.join(f.args.outputDir,'artist-instagram-findings.csv'),'utf8'),/changed-model/);
  assert.equal(f.calls.length,1);
});
test('frozen transport uses only injected fetch, archives fresh typed probabilities, and never retries uncertainty',async t=>{
  const f=await fixture(t);let calls=0;
  const transport=frozenJevTransport({responseDir:path.join(f.args.outputDir,'responses'),apiKey:'mock-not-a-secret',fetchImpl:async()=>{
    calls++;
    if(calls===2)throw Error('Dispatch uncertain');
    return new Response(JSON.stringify({model:'resolved-fixed',usage:{cost:0.001},answers:{
      candidate_0_same_identity:{noul:0.12},candidate_0_verdict:{choice:'mismatch',confidence:0.7,probabilities:{mismatch:0.7}},
    }}),{status:200});
  }});
  const summary=await f.run({transport});
  assert.equal(summary.completedResponses,1);assert.equal(summary.budget.reservedCents,4);assert.equal(calls,2);
  const raw=await read(path.join(f.args.outputDir,'responses','control-current.json'));
  assert.equal(raw.data.answers.candidate_0_same_identity.noul,0.12);
  const findings=await read(path.join(f.args.outputDir,'findings.json'));
  assert.equal(findings[0].verdictLabelConfidence,0.7);
});
