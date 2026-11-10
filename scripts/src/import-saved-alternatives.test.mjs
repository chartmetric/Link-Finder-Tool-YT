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

// Synthetic archive: account metadata is reusable, artist/account judgments are not.
async function sharedHandleFixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shared-handle-import-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const sharedUrl=url('shared'), alternativeUrl=url('uninspected');
  const scope=prepareSavedAlternativeScope([
    target(101,[sharedUrl,alternativeUrl]),target(202,[sharedUrl]),
  ],{approved:true,budgetId:'synthetic-shared-handle',maxSpendCents:20,
    candidateMetadataFetchesApproved:true,savedAlternativesApproved:true},{inspectAlternatives:true});
  const at='2026-11-10T10:00:00.000Z';
  const metadata={available:true,candidate:{url:sharedUrl,bio:'Shared synthetic account bio'}};
  const metadataResponse={at,status:200,requestedUrl:sharedUrl,data:metadata.candidate};
  const metadataRequest={key:'shared-metadata',kind:'scrapecreators_candidate',profileId:'101',
    body:{url:sharedUrl},sha256:digest({url:sharedUrl})};
  const requests=[metadataRequest],responses=new Map();
  const artists=scope.targets.map((target,i)=>{
    const pid=target.profileId;
    const body={state:{savedSearchEvidence:{url:sharedUrl},catalogArtist:target.player.catalog_profile,
      artist:target.artist,syntheticRequest:`request-for-${pid}`}};
    const request={key:`verify-${pid}`,kind:'jev',profileId:pid,body,sha256:digest(body)};
    const answer={verdict:i===0?'likely':'mismatch',sameIdentityProbability:i===0?0.91:0.12,
      reason:`answer-for-${pid}`};
    const review={url:sharedUrl,status:'unresolved_ownership_conflict',reason:'shared_handle_across_catalog_artists',
      evidence:[`review-for-${pid}`],reviewSuggestion:false,verified:false,liveLinkAccepted:false};
    requests.push(request);
    responses.set(request.key,{at,status:200,decisionRequest:body,requestBodySha256:request.sha256,
      data:{model:scope.expectedModel,answers:[answer]}});
    return {artist:target.artist,profileId:pid,cmArtist:target.player.cm_artist,status:'inconclusive',
      verified:false,liveLinkAccepted:false,candidates:target.candidates.map((candidate,index)=>({
        ...candidate,status:index===0?'inconclusive':'uninspected',
        reason:index===0?review.reason:'not_inspected_within_approved_run',
        ...(index===0?{metadata:structuredClone(metadata),recordedAnswer:answer,review,requestSha256:request.sha256}:{}),
      }))};
  });
  const journal=requests.flatMap(request=>[
    {phase:'admitted',key:request.key,profileId:request.profileId,reservedCents:2,request,at},
    {phase:'returned',key:request.key,at},
  ]);
  const result={status:'completed',stopReason:null,budgetExhausted:false,artists,
    budget:{budgetId:scope.authorization.budgetId,scopeSha256:digest(scope),maximumSpendCents:20,
      reservedCents:6,admitted:3,returned:3,stopped:true}};
  const write=async(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value));
  await fs.mkdir(path.join(dir,'metadata-responses'));await fs.mkdir(path.join(dir,'model-responses'));
  await write('scope.json',{scope,scopeSha256:digest(scope)});
  await fs.writeFile(path.join(dir,'admissions.jsonl'),journal.map(event=>JSON.stringify(event)).join('\n')+'\n');
  await write('metadata-responses/shared-metadata.json',metadataResponse);
  for(const [key,response] of responses)await write(`model-responses/${key}.json`,response);
  const save=async()=>{
    await write('summary.json',result);
    await fs.writeFile(path.join(dir,'outcomes.jsonl'),JSON.stringify(result)+'\n');
  };
  await save();
  return {dir,result,save,metadata,metadataRequest,metadataResponse,requests,responses,sharedUrl,alternativeUrl};
}

for(const interrupted of [false,true]) {
  test(`shared-handle ${interrupted?'interrupted checkpoint':'final archive'} keeps judgments bound to each artist`,async t=>{
    const f=await sharedHandleFixture(t);
    if(interrupted) {
      delete f.result.status;delete f.result.stopReason;
      await f.save();await fs.unlink(path.join(f.dir,'summary.json'));
    }
    const before=await fs.readFile(path.join(f.dir,'outcomes.jsonl'),'utf8');
    const oldFetch=globalThis.fetch;
    globalThis.fetch=()=>{throw Error('Network forbidden in synthetic archive test');};
    let doc;
    try {doc=await buildSavedAlternativesDocument(f.dir);} finally {globalThis.fetch=oldFetch;}
    assert.equal(doc.batch.status,interrupted?'interrupted_checkpoint':'completed');
    assert.equal(doc.batch.artistCount,2);assert.equal(doc.batch.candidateCount,3);
    assert.equal(doc.batch.verifiedCount,0);assert.equal(doc.batch.reviewCount,0);
    assert.equal(doc.batch.notInspectedCount,1);assert.equal(doc.batch.reservedUsd,0.06);
    const sharedRows=doc.rows.filter(row=>row.candidateUrl===f.sharedUrl);
    assert.deepEqual(sharedRows.map(row=>row.profileId),['101','202']);
    assert.equal(new Set(doc.rows.map(row=>row.id)).size,3);
    for(const row of sharedRows) {
      const artist=f.result.artists.find(artist=>artist.profileId===row.profileId);
      const candidate=artist.candidates[0];
      const request=f.requests.find(request=>request.kind==='jev'&&request.profileId===row.profileId);
      const value=label=>{
        const fields=row.fields.filter(field=>field.label===label);
        assert.equal(fields.length,1,label);
        return JSON.parse(fields[0].value);
      };
      assert.equal(row.artistName,artist.artist);assert.equal(row.verifiedUrl,null);
      assert.equal(row.status,'inconclusive');
      assert.equal(row.score,candidate.recordedAnswer.sameIdentityProbability);
      assert.equal(row.verdict,candidate.recordedAnswer.verdict);
      assert.deepEqual(value('Captured candidate metadata receipt (JSON)'),f.metadata);
      assert.deepEqual(value('scrapecreators_candidate exact journaled request (JSON)'),f.metadataRequest.body);
      assert.deepEqual(value('scrapecreators_candidate original provider response (JSON)'),f.metadataResponse);
      assert.deepEqual(value('jev exact journaled request (JSON)'),request.body);
      assert.equal(value('jev admission and completion receipt (JSON)').admission.profileId,row.profileId);
      assert.deepEqual(value('jev original provider response (JSON)'),f.responses.get(request.key));
      assert.deepEqual(value('Recorded model answer (JSON)'),candidate.recordedAnswer);
      assert.deepEqual(value('Review-only suggestion (JSON)'),candidate.review);
      const other=row.profileId==='101'?'202':'101';
      assert.doesNotMatch(JSON.stringify(row),new RegExp(`(?:request|answer|review)-for-${other}`));
    }
    const alternative=doc.rows.find(row=>row.candidateUrl===f.alternativeUrl);
    assert.equal(alternative.profileId,'101');assert.equal(alternative.status,'uninspected');
    assert.equal(alternative.score,null);assert.equal(alternative.verdict,null);assert.equal(alternative.verifiedUrl,null);
    for(const label of ['Recorded model answer (JSON)','Review-only suggestion (JSON)','Captured candidate metadata receipt (JSON)'])
      assert.equal(alternative.fields.find(field=>field.label===label).value,'');
    assert.ok(!alternative.fields.some(field=>/exact journaled request|original provider response/.test(field.label)));
    assert.match(alternative.fields.find(field=>field.label==='Exact request delivery status').value,/No model admission/);
    assert.equal(await fs.readFile(path.join(f.dir,'outcomes.jsonl'),'utf8'),before);
  });
}
