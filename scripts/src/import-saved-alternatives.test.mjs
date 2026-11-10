import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {buildSavedAlternativesDocument} from './import-saved-alternatives.mjs';
import {digest,prepareSavedAlternativeScope} from './instagram-next-saved-batch.mjs';
import {runSavedAlternatives} from './instagram-saved-alternatives-runner.mjs';

const statuses=['unavailable','unsupported','inconclusive','positive_review_suggestion','uninspected'];
const url=n=>`https://www.instagram.com/saved_${n}/`;
const target=(id,urls)=>({
  artist:`Artist ${id}`,profileId:String(id),
  player:{profile_id:String(id),cm_artist:String(id),source_identity_matches:true,
    catalog_profile:{profile_id:String(id),cm_artist:String(id)},savedCandidateUrls:urls},
  candidates:urls.map(url=>({url,title:'Original saved title',snippet:'Saved snippet, not account bio'})),
});
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'alternative-import-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const scope=prepareSavedAlternativeScope([target(1,statuses.map((_,i)=>url(i))),target(2,[])],
    {approved:true,budgetId:'new-parent-fixture',maxSpendCents:20,
      candidateMetadataFetchesApproved:true,savedAlternativesApproved:true},{inspectAlternatives:true});
  const body={state:{savedSearchEvidence:{url:url(3)},exactUnicode:'原文\nComplete retained request'}};
  const request={key:'verify-fixture',kind:'jev',profileId:'1',body,sha256:digest(body)};
  const meta={key:'metadata-fixture',kind:'scrapecreators_candidate',profileId:'1',body:{url:url(3)},sha256:digest({url:url(3)})};
  const at='2026-11-10T10:00:00.000Z';
  const journal=[
    {phase:'admitted',key:meta.key,profileId:'1',reservedCents:2,request:meta,at},
    {phase:'returned',key:meta.key,estimatedCost:0.02,at},
    {phase:'admitted',key:request.key,profileId:'1',reservedCents:2,request,at},
    {phase:'returned',key:request.key,reportedCost:0.001,at},
  ];
  const result={status:'completed',stopReason:null,budgetExhausted:false,
    artists:[{artist:'Artist 1',profileId:'1',cmArtist:'1',status:'positive_review_suggestion',verified:false,liveLinkAccepted:false,
      candidates:scope.targets[0].candidates.map((c,i)=>({...c,status:statuses[i],reason:`saved_reason_${i}`,
        ...(i===3 ? {metadata:{available:true,candidate:{url:c.url,bio:'Exact captured bio'}},
          review:{reviewSuggestion:true,reason:'review_only'},recordedAnswer:{verdict:'likely',sameIdentityProbability:0.9},
          requestSha256:request.sha256} : {})}))},
    {artist:'Artist 2',profileId:'2',cmArtist:'2',status:'no_saved_candidate',candidates:[],verified:false,liveLinkAccepted:false}],
    budget:{budgetId:scope.authorization.budgetId,scopeSha256:digest(scope),maximumSpendCents:20,
      reservedCents:4,admitted:2,returned:2,reportedCostUsd:0.001,estimatedCostUsd:0.02,stopped:true}};
  await fs.mkdir(path.join(dir,'metadata-responses'));await fs.mkdir(path.join(dir,'model-responses'));
  const write=async(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value));
  await write('scope.json',{scope,scopeSha256:digest(scope)});
  await fs.writeFile(path.join(dir,'admissions.jsonl'),journal.map(v=>JSON.stringify(v)).join('\n')+'\n');
  await write('metadata-responses/metadata-fixture.json',{at,status:200,requestedUrl:url(3),data:{bio:'Exact raw provider bio'}});
  await write('model-responses/verify-fixture.json',{at,status:200,decisionRequest:body,requestBodySha256:request.sha256,data:{original:'response'}});
  const save=async()=>{await write('summary.json',result);await fs.writeFile(path.join(dir,'outcomes.jsonl'),JSON.stringify(result)+'\n');};
  await save();
  return {dir,scope,result,save,write};
}
test('all candidate distinctions, exact evidence and one parent budget survive offline import',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.dir,'summary.json'),'utf8');
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('Network forbidden');};
  let doc;
  try {doc=await buildSavedAlternativesDocument(f.dir);} finally {globalThis.fetch=oldFetch;}
  assert.deepEqual(doc.rows.map(r=>r.status),[...statuses,'no_saved_candidate']);
  assert.equal(doc.batch.artistCount,2);assert.equal(doc.batch.candidateCount,5);
  assert.equal(doc.batch.verifiedCount,0);assert.equal(doc.batch.reviewCount,1);
  assert.equal(doc.batch.reservedUsd,0.04);assert.equal(doc.batch.reportedUsd,0.001);
  assert.ok(doc.rows.every(r=>r.verifiedUrl===null));
  assert.match(doc.batch.explanation,/never calls providers/);
  assert.match(doc.rows[3].fields.find(f=>f.label==='jev exact journaled request (JSON)').value,/原文/);
  assert.match(doc.rows[3].fields.find(f=>f.label==='scrapecreators_candidate original provider response (JSON)').value,/Exact raw provider bio/);
  assert.match(doc.rows[3].fields.find(f=>f.label==='Captured candidate metadata receipt (JSON)').value,/Exact captured bio/);
  assert.equal(await fs.readFile(path.join(f.dir,'summary.json'),'utf8'),before);
  assert.deepEqual(await buildSavedAlternativesDocument(f.dir),doc);
});
test('interrupted checkpoint is labelled, missing raw response is not reconstructed',async t=>{
  const f=await fixture(t);
  delete f.result.status;delete f.result.stopReason;
  await f.save();await fs.unlink(path.join(f.dir,'summary.json'));
  await fs.unlink(path.join(f.dir,'model-responses/verify-fixture.json'));
  const doc=await buildSavedAlternativesDocument(f.dir);
  assert.equal(doc.batch.status,'interrupted_checkpoint');
  assert.match(doc.rows[3].fields.find(f=>f.label==='jev response archive status').value,/Unavailable/);
  assert.match(doc.batch.metrics.find(m=>m.label==='Spending observation').value,/journal may be newer/);
});
test('reject mismatched scope, reordered URLs, link acceptance and unknown states',async t=>{
  const f=await fixture(t);
  f.result.artists[0].candidates.reverse();await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/does not match/);
  f.result.artists[0].candidates.reverse();f.result.artists[0].verified=true;await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/claims accepted/);
  f.result.artists[0].verified=false;f.result.artists[0].candidates[0].status='verified';await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/Unknown candidate/);
  await f.write('scope.json',{scope:f.scope,scopeSha256:'wrong'});
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/scope identity/);
});
test('reject fabricated request evidence, mismatched raw accounts and torn journals',async t=>{
  const f=await fixture(t);
  f.result.artists[0].candidates[3].requestSha256='fake';await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/no completed exact admission/);
  delete f.result.artists[0].candidates[3].requestSha256;await f.save();
  await f.write('metadata-responses/metadata-fixture.json',{requestedUrl:url(999)});
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/differs from its requested account/);
  await fs.appendFile(path.join(f.dir,'admissions.jsonl'),'{"phase":');
  await assert.rejects(buildSavedAlternativesDocument(f.dir),SyntaxError);
});
test('reject conflicting final summary, changed budget and omitted artists',async t=>{
  const f=await fixture(t);
  await f.write('summary.json',{...f.result,status:'different'});
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/Summary and last/);
  f.result.budget.budgetId='another';await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/Parent budget/);
  f.result.budget.budgetId=f.scope.authorization.budgetId;f.result.artists.pop();await f.save();
  await assert.rejects(buildSavedAlternativesDocument(f.dir),/omits approved/);
});
test('CLI writes immutable UI documents and refuses existing output directories',async t=>{
  const f=await fixture(t),out=path.join(f.dir,'prepared');
  execFileSync(process.execPath,['scripts/src/import-saved-alternatives.mjs',f.dir,out]);
  const index=JSON.parse(await fs.readFile(path.join(out,'index.json'),'utf8'));
  const doc=JSON.parse(await fs.readFile(path.join(out,`${index.batches[0].id}.json`),'utf8'));
  assert.equal(doc.rows.length,6);
  assert.throws(()=>execFileSync(process.execPath,['scripts/src/import-saved-alternatives.mjs',f.dir,out],{stdio:'pipe'}));
});
test('actual runner zero-dispatch checkpoint imports without inventing a dispatch date',async t=>{
  const f=await fixture(t);
  const budget={budgetId:f.scope.authorization.budgetId,scopeSha256:digest(f.scope),
    maximumSpendCents:20,reservedCents:20,admitted:10,returned:10,stopped:false};
  await fs.writeFile(path.join(f.dir,'admissions.jsonl'),'');
  await fs.writeFile(path.join(f.dir,'outcomes.jsonl'),'');
  const result=await runSavedAlternatives({scope:f.scope,
    gate:{snapshot:()=>({...budget}),request:()=>{throw Error('Must not dispatch');},stop:()=>{budget.stopped=true;}},
    persist:async snapshot=>fs.appendFile(path.join(f.dir,'outcomes.jsonl'),JSON.stringify(snapshot)+'\n')});
  await f.write('summary.json',result);
  const doc=await buildSavedAlternativesDocument(f.dir);
  assert.equal(doc.batch.notInspectedCount,5);assert.equal(doc.batch.noCandidateCount,1);
  assert.equal(doc.batch.metrics.find(m=>m.label==='Budget exhausted').value,'true');
  assert.match(doc.batch.metrics.find(m=>m.label==='Run date source').value,/no dispatch date/);
});
