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
// Synthetic second reviews exercise governance only; never write these back as
// real reviews or send them to a provider.
function secondReview(c,overrides={}) {
  return {...structuredClone(c.reviews.primary[0]),id:`${c.id}-second-1`,
    reviewerId:'synthetic-second-reviewer',rationale:'Synthetic fixture: independently agrees with source decision.',
    reviewedAt:'2026-11-10T12:00:00.000Z',...overrides};
}
function agreeingLabels() {
  const fixture=structuredClone(labels);
  for(const c of fixture.cases)c.reviews.second=[secondReview(c)];
  return fixture;
}
const suite=assembleOwnershipSuite(agreeingLabels(),requests,legacy);
const digest=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
const decisions=(request,fn)=>({requestId:request.id,inputSha256:request.inputSha256,
  decisions:request.candidates.map((c,i)=>({url:c.url,...fn(c,i)}))});

test('agreeing distinct source reviewers count once, separate from user confirmation and unresolved prospects',()=>{
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
  assert.equal(suite.reviewCounts.agreed,10);
  assert.equal(suite.quarantined.length,0);
  assert.equal(suite.disagreements.length,0);
  assert.notEqual(suite.requests[0].candidates[0].activeReviews.primary.rationale,
    suite.requests[0].candidates[0].activeReviews.second.rationale);
});

test('committed single-curator records are retained but missing second reviews never enter totals',()=>{
  const prepared=assembleOwnershipSuite(labels,requests,legacy);
  assert.deepEqual(prepared.counts,{artistAccountPairs:0,distinctTargetArtists:0,
    distinctAccounts:0,confirmedArtistOwned:0,confirmedNotArtistOwned:0});
  assert.deepEqual(prepared.reviewCounts,{total:10,agreed:0,missingReviews:10,
    conflictingReviews:0,unresolvedReviews:0});
  assert.equal(prepared.quarantined.length,10);
  assert.equal(scoreKnownAnswers(prepared).knownAnswers,0);
  const primary=prepared.quarantined[0].activeReviews.primary;
  assert.deepEqual(primary,labels.cases[0].reviews.primary[0]);
  assert.equal(primary.reviewedAt,null,'Do not invent legacy review times');
  assert.equal(prepared.quarantined[0].expectedArtistOwned,null);
  assert.deepEqual(prepared.evidence,labels.evidence);
  for(const slots of [[],['primary'],['second']]) {
    const fixture=agreeingLabels();
    for(const slot of slots)fixture.cases[0].reviews[slot]=[];
    if(!slots.length)fixture.cases[0].reviews={primary:[],second:[]};
    const out=assembleOwnershipSuite(fixture,requests,legacy);
    assert.equal(out.counts.artistAccountPairs,9);
    assert.equal(out.quarantined[0].reviewStatus,'missing_review');
    assert.equal(scoreKnownAnswers(out).knownAnswers,9);
  }
});

test('conflicts retain both rationales and times, regardless of perfect or rejecting model scores',()=>{
  const fixture=agreeingLabels(),c=fixture.cases[0];
  c.reviews.second=[secondReview(c,{expectedArtistOwned:false,stratum:'fan',
    rationale:'Synthetic conflicting interpretation: fan account, not artist ownership.',
    observedAt:'2026-11-09T18:47:00.000Z'})];
  const out=assembleOwnershipSuite(fixture,requests,legacy);
  assert.equal(out.reviewCounts.conflictingReviews,1);
  assert.equal(out.counts.artistAccountPairs,9);
  assert.equal(out.counts.confirmedArtistOwned,2);
  assert.equal(out.counts.confirmedNotArtistOwned,7);
  const [conflict]=out.disagreements;
  assert.equal(conflict.caseId,c.id);assert.equal(conflict.active,true);
  assert.deepEqual(conflict.primary,c.reviews.primary[0]);
  assert.deepEqual(conflict.second,c.reviews.second[0]);
  assert.deepEqual(out.quarantined[0].reviewHistory,c.reviews);
  assert.equal(out.quarantined[0].expectedArtistOwned,null);
  assert.equal(out.quarantined[0].stratum,null);
  assert.equal(conflict.record,null,'Unrecorded disagreements are still detected');
  fixture.disagreements.push({caseId:c.id,primaryReviewId:c.reviews.primary[0].id,
    secondReviewId:c.reviews.second[0].id,rationale:'Synthetic explicit disagreement record.',
    recordedAt:'2026-11-10T12:30:00.000Z'});
  const recorded=assembleOwnershipSuite(fixture,requests,legacy);
  assert.deepEqual(recorded.recordedDisagreements,fixture.disagreements);
  assert.deepEqual(recorded.disagreements[0].record,fixture.disagreements[0]);
  assert.equal(recorded.counts.artistAccountPairs,9);
  for(const accepted of [true,false]) {
    const score=scoreKnownAnswers(out,out.requests.map(r=>decisions(r,()=>({
      verdict:accepted?'verified':'mismatch',sameIdentityProbability:accepted?1:0}))));
    assert.equal(score.knownAnswers,9);assert.equal(score.testedKnownAnswers,9);
    assert.equal(score.byStratum.artist_owned.cases,2);
    assert.equal(score.rows.find(r=>r.id===c.id).outcome,'unscored');
    assert.equal(score.wronglyAcceptedKnownNegatives,accepted?7:0);
    assert.equal(score.heldKnownPositives,accepted?0:2);
  }
  // Even two negative ownership decisions disagree if the source role differs.
  const roles=agreeingLabels();
  roles.cases[1].reviews.second[0].stratum='label';
  const roleConflict=assembleOwnershipSuite(roles,requests,legacy);
  assert.equal(roleConflict.quarantined[0].reviewStatus,'conflicting_reviews');
  assert.equal(roleConflict.counts.confirmedNotArtistOwned,6);
});

test('explicit unresolved judgments never become agreed positives or negatives',()=>{
  const fixture=agreeingLabels(),c=fixture.cases[0];
  for(const review of [c.reviews.primary[0],c.reviews.second[0]]) {
    review.expectedArtistOwned=null;review.stratum=null;
    review.rationale='Synthetic review: insufficient source evidence.';
  }
  const out=assembleOwnershipSuite(fixture,requests,legacy);
  assert.equal(out.quarantined[0].reviewStatus,'unresolved_review');
  assert.equal(out.counts.artistAccountPairs,9);
  assert.equal(scoreKnownAnswers(out).knownAnswers,9);
});

test('revisions can introduce and resolve conflict without majority voting or erasing history',()=>{
  const fixture=agreeingLabels(),c=fixture.cases[0];
  const revision=(review,id,changes={})=>({...structuredClone(review),id,supersedes:review.id,
    reviewedAt:'2026-11-10T13:00:00.000Z',...changes});
  const revised=revision(c.reviews.primary[0],'primary-2',{
    expectedArtistOwned:false,stratum:'fan',rationale:'Synthetic revision changes ownership decision.'});
  c.reviews.primary.push(revised);
  fixture.disagreements.push({caseId:c.id,primaryReviewId:revised.id,
    secondReviewId:c.reviews.second[0].id,rationale:'Synthetic disagreement before revision.',
    recordedAt:null});
  let out=assembleOwnershipSuite(fixture,requests,legacy);
  assert.equal(out.quarantined[0].reviewStatus,'conflicting_reviews');
  // Repeated revisions by one reviewer are not extra votes.
  c.reviews.second.push(revision(c.reviews.second[0],'second-2'),
    revision({...c.reviews.second[0],id:'second-2'},'second-3'));
  out=assembleOwnershipSuite(fixture,requests,legacy);
  assert.equal(out.counts.artistAccountPairs,9);
  assert.equal(out.quarantined[0].activeReviews.primary.id,'primary-2');
  const last=c.reviews.second.at(-1);
  c.reviews.second.push(revision(last,'second-4',{
    expectedArtistOwned:false,stratum:'fan',rationale:'Synthetic revision agrees with revised primary decision.'}));
  out=assembleOwnershipSuite(fixture,requests,legacy);
  assert.equal(out.quarantined.length,0);assert.equal(out.counts.artistAccountPairs,10);
  assert.equal(out.counts.confirmedArtistOwned,2);assert.equal(out.counts.confirmedNotArtistOwned,8);
  assert.equal(out.requests[0].candidates[0].expectedArtistOwned,false,
    'Use active consensus, not the original proposed label');
  assert.deepEqual(out.requests[0].candidates[0].reviewHistory,c.reviews);
  assert.ok(out.disagreements.length>0);
  assert.ok(out.disagreements.every(d=>!d.active));
  assert.deepEqual(out.recordedDisagreements,fixture.disagreements);
  assert.equal(scoreKnownAnswers(out).byStratum.fan.cases,2);
});

test('disagreement ledger requires real conflicting decisions, a rationale and an explicit time',()=>{
  for(const overrides of [
    {},{primaryReviewId:'unknown'},{secondReviewId:'unknown'},
    {rationale:''},{recordedAt:undefined},
  ]) {
    const fixture=agreeingLabels(),c=fixture.cases[0];
    fixture.disagreements=[{caseId:c.id,primaryReviewId:c.reviews.primary[0].id,
      secondReviewId:c.reviews.second[0].id,rationale:'Synthetic disagreement.',recordedAt:null,...overrides}];
    // With no overrides, the recorded decisions actually agree.
    if(Object.keys(overrides).length) {
      c.reviews.second[0].stratum='fan';
      c.reviews.second[0].expectedArtistOwned=false;
    }
    assert.throws(()=>assembleOwnershipSuite(fixture,requests,legacy));
  }
});

test('invalid reviewer identity, missing rationale/times and ambiguous revision chains fail closed',()=>{
  for(const mutate of [
    c=>delete c.reviews,
    c=>c.reviews.second[0].reviewerId=c.reviews.primary[0].reviewerId,
    c=>c.reviews.second[0].id=c.reviews.primary[0].id,
    c=>c.reviews.second[0].rationale=' ',
    c=>delete c.reviews.second[0].observedAt,
    c=>c.reviews.second[0].observedAt='invalid',
    c=>delete c.reviews.second[0].reviewedAt,
    c=>c.reviews.second[0].evidenceIds=['missing'],
    c=>c.reviews.second[0].supersedes='unknown',
    c=>c.reviews.second.push({...c.reviews.second[0],id:'revision',supersedes:null}),
    c=>c.reviews.second.push({...c.reviews.second[0],id:'revision',
      supersedes:c.reviews.second[0].id,reviewerId:'another-reviewer'}),
    c=>c.reviews.second.push({...c.reviews.second[0],id:'revision',
      supersedes:c.reviews.second[0].id,reviewedAt:'2026-11-01T00:00:00.000Z'}),
    c=>c.reviews.third=[secondReview(c)],
  ]) {
    const fixture=agreeingLabels();mutate(fixture.cases[0]);
    assert.throws(()=>assembleOwnershipSuite(fixture,requests,legacy));
  }
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
    'currentAdjudication','validUntil','reviewer','approval','currentReviews','reviews','disagreements',
    'reviewerId','rationale','activeReviews','reviewHistory','reviewStatus']) {
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
    assert.equal(out.score.knownAnswers,0);
    assert.equal(out.suite.quarantined.length,10);
    const manifest=JSON.parse(await fs.readFile(`${destination}/benchmark.json`,'utf8'));
    assert.deepEqual(manifest.quarantined[0].reviewHistory,labels.cases[0].reviews);
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
