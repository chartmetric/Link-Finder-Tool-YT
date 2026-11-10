import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreKnownAnswers} from './instagram-known-answer-benchmark.mjs';
import {assertBlindInput,validateAdjudications,buildOwnershipInputs,assembleOwnershipSuite,
  prepareOwnershipBenchmark} from './instagram-ownership-benchmark.mjs';

const read=async name=>JSON.parse(await fs.readFile(`scripts/fixtures/${name}.json`,'utf8'));
const inputs=await read('instagram-ownership-inputs');
const snapshots=await read('instagram-ownership-snapshots');
const labels=await read('instagram-ownership-adjudications');
const legacy=await read('instagram-known-answer-labels');
const requests=await buildOwnershipInputs(inputs,snapshots);
const suite=assembleOwnershipSuite(labels,requests,legacy);
const digest=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
const decisions=(request,fn)=>({requestId:request.id,inputSha256:request.inputSha256,
  decisions:request.candidates.map((c,i)=>({url:c.url,...fn(c,i)}))});

test('independent source review stays separate from user confirmation and unresolved prospects',()=>{
  assert.deepEqual(suite.counts,{artistAccountPairs:10,distinctTargetArtists:5,
    distinctAccounts:8,confirmedArtistOwned:3,confirmedNotArtistOwned:7});
  assert.equal(suite.legacyUserConfirmedOnly.length,3);
  assert.equal(suite.uncertain.length,4);
  assert.ok(suite.uncertain.every(c=>c.expectedArtistOwned===null));
  const score=scoreKnownAnswers(suite);
  assert.equal(score.knownAnswers,10);assert.equal(score.testedKnownAnswers,0);
  for(const stratum of ['artist_owned','wrong_person','label','festival','venue','fan','brand']) {
    assert.ok(score.byStratum[stratum].cases>0);
    assert.equal(score.byStratum[stratum].tested,0);
  }
  assert.ok(score.rows.every(r=>r.outcome==='not_tested'));
  assert.equal(score.populationAccuracyClaim,false);
  assert.equal(score.thresholdCalibrated,false);
  assert.equal(score.productionApproved,false);
});

test('portable snapshots reconstruct frozen original baselines without ignored archives',()=>{
  for(const r of requests.slice(0,3)) {
    assert.equal(r.inputSha256,snapshots.packets[r.id].inputSha256);
    assert.deepEqual(r.body.state,snapshots.packets[r.id].state);
    assert.ok(Buffer.byteLength(JSON.stringify(r.body))<=6000);
    assert.equal(digest(r.body),r.inputSha256);
    assert.ok(r.body.state.candidates.every(c=>c.reference.url===r.body.state.knownProfileUrl));
  }
  const newPublic=requests.slice(3).map(r=>r.body.state.candidates[1]);
  for(const c of newPublic) {
    assert.deepEqual(c.observedExactCatalogLinks,[]);
    assert.deepEqual(c.candidate,{platform:'instagram',url:c.url,externalUrls:[]});
    assert.ok(c.sourceObservation.observedAt);
  }
});

test('labels, provenance reviews and grading artist-site proof never enter verifier requests',async()=>{
  const changed=structuredClone(labels);
  changed.evidence.aimee.review='EVALUATOR_ONLY_SENTINEL';
  changed.cases[0].savedExactLinkEligible=false;
  assembleOwnershipSuite(changed,requests,legacy);
  const rebuilt=await buildOwnershipInputs(inputs,snapshots);
  assert.deepEqual(rebuilt,requests);
  for(const r of rebuilt) {
    assertBlindInput(r.body);
    const text=JSON.stringify(r.body);
    assert.ok(!text.includes('EVALUATOR_ONLY_SENTINEL'));
    for(const id of ['aimee','ernest','format'])assert.ok(!text.includes(labels.evidence[id].bodySha256));
  }
  for(const key of ['expectedArtistOwned','labelEvidence','review','stratum','ownershipFreshness',
    'currentAdjudication','validUntil','reviewer','approval']) {
    assert.throws(()=>assertBlindInput({state:{candidates:[{[key]:'hidden'}]}}),/Evaluator field/);
  }
});

test('bad snapshots, source bindings, duplicates and unproven labels fail explicitly',async()=>{
  const bad=structuredClone(snapshots);bad.packets['aimee-pair'].state.artist='different';
  await assert.rejects(buildOwnershipInputs(inputs,bad),/Frozen input hash/);
  const badIndex=structuredClone(inputs);badIndex.requests[0].candidateIndexes=[9,1];
  await assert.rejects(buildOwnershipInputs(badIndex,snapshots),/Invalid source/);
  const badPublic=structuredClone(inputs);badPublic.requests[3].publicCandidate.sourceObservation.declaredInstagramHref='https://www.instagram.com/other/';
  await assert.rejects(buildOwnershipInputs(badPublic,snapshots));
  for(const mutate of [
    x=>x.cases.push({...x.cases[0]}),
    x=>x.cases[0].evidenceIds=['missing'],
    x=>x.evidence.aimee.observedAt=null,
    x=>x.evidence.aimee.selectedLinks=['https://www.instagram.com/other/'],
    x=>x.uncertain[0].expectedArtistOwned=true,
  ]) {
    const x=structuredClone(labels);mutate(x);
    assert.throws(()=>validateAdjudications(x));
  }
  const wrongTarget=structuredClone(labels);
  wrongTarget.evidence.aimee.selectedLinks[1]='https://open.spotify.com/artist/other';
  assert.throws(()=>assembleOwnershipSuite(wrongTarget,requests,legacy),/target music ID/);
  const orphan=structuredClone(labels);orphan.cases[0].requestId='unknown';
  assert.throws(()=>assembleOwnershipSuite(orphan,requests,legacy),/adjudication/);
});

test('model misses and exact-link holds are independent, including confident wrong acceptances',()=>{
  const allHeld=scoreKnownAnswers(suite,suite.requests.map(r=>decisions(r,()=>({
    verdict:'likely',sameIdentityProbability:0.8}))));
  assert.equal(allHeld.heldKnownPositives,3);
  assert.equal(allHeld.modelMissWithExactLink,1);
  assert.equal(allHeld.modelAndEvidenceHeldKnownPositives,2);
  assert.equal(allHeld.exactLinkHeldKnownPositives,2);
  assert.equal(allHeld.wronglyAcceptedKnownNegatives,0);
  const allAccepted=scoreKnownAnswers(suite,suite.requests.map(r=>decisions(r,()=>({
    verdict:'verified',sameIdentityProbability:0.9}))));
  assert.equal(allAccepted.heldKnownPositives,0);
  assert.equal(allAccepted.evidenceOnlyHeldKnownPositives,2);
  assert.equal(allAccepted.wronglyAcceptedKnownNegatives,7);
  assert.equal(allAccepted.rows.filter(r=>r.savedEvidenceAndVerifierGatePassed).length,1);
  assert.equal(allAccepted.byStratum.wrong_person.modelAcceptedNegatives,2);
  assert.equal(allAccepted.byStratum.label.modelAcceptedNegatives,1);
  for(const decision of [{verdict:'verified',sameIdentityProbability:0.8999},
    {verdict:'likely',sameIdentityProbability:0.99}]) {
    const held=scoreKnownAnswers(suite,[decisions(suite.requests[0],()=>decision)]);
    assert.equal(held.rows[0].modelAccepted,false);
  }
});

test('offline preparation cannot dispatch network or overwrite previous output',async()=>{
  await fs.mkdir('generated-artifacts',{recursive:true});
  const parent=await fs.mkdtemp('generated-artifacts/ownership-benchmark-test-');
  const destination=`${parent}/run`;
  const fetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('Network forbidden in preparation');};
  try {
    const out=await prepareOwnershipBenchmark({destination});
    assert.equal(out.suite.run_allowed,false);
    assert.equal(out.suite.limits.paidCallsAllowedNow,0);
    assert.equal(out.score.testedKnownAnswers,0);
    for(const r of requests) {
      const packet=JSON.parse(await fs.readFile(`${destination}/requests/${r.id}.json`,'utf8'));
      assertBlindInput(packet.request);
      assert.deepEqual(packet.request,r.body);
      assert.equal(digest(packet.request),packet.inputSha256);
    }
    await assert.rejects(prepareOwnershipBenchmark({destination}),/EEXIST/);
    await assert.rejects(prepareOwnershipBenchmark({destination:'scripts/fixtures/overwrite'}),/ignored/);
  } finally {
    globalThis.fetch=fetch;
    await fs.rm(parent,{recursive:true,force:true});
  }
});
