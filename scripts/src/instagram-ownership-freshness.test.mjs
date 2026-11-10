import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appendOwnershipReview,ownershipFreshness} from './instagram-ownership-freshness.mjs';
import {validateAdjudications,assembleOwnershipSuite,buildOwnershipInputs,
  scoreOwnershipBenchmark,prepareOwnershipBenchmark} from './instagram-ownership-benchmark.mjs';

const read=async name=>JSON.parse(await fs.readFile(`scripts/fixtures/${name}.json`,'utf8'));
const labels=await read('instagram-ownership-adjudications');
const legacy=await read('instagram-known-answer-labels');
const requests=await buildOwnershipInputs(await read('instagram-ownership-inputs'),await read('instagram-ownership-snapshots'));
const asOf='2026-11-10T00:00:00.000Z';
const review={id:'review-a',caseId:'aimee-owned',supersedes:null,action:'re_adjudicated',
  reviewedAt:asOf,reviewer:'Offline fixture curator',reason:'Re-reviewed committed source facts only.',
  validUntil:'2026-11-12T00:00:00.000Z',validityReason:'Synthetic test window, not a production policy.',
  adjudication:{expectedArtistOwned:true,stratum:'artist_owned',evidenceIds:['aimee']}};
const append=(data,r,evidence={})=>appendOwnershipReview(data,{review:r,evidence},validateAdjudications);
const responses=suite=>suite.requests.map(r=>({requestId:r.id,inputSha256:r.inputSha256,
  decisions:r.candidates.map(c=>({url:c.url,verdict:'verified',sameIdentityProbability:0.99}))}));

test('original observations remain historical-only and never current negative answers',()=>{
  const suite=assembleOwnershipSuite(labels,requests,legacy,{asOf});
  const historical=scoreOwnershipBenchmark(suite,responses(suite),{asOf});
  const current=scoreOwnershipBenchmark(suite,responses(suite),{asOf,mode:'current'});
  assert.equal(historical.knownAnswers,10);
  assert.equal(historical.wronglyAcceptedKnownNegatives,7);
  assert.equal(current.knownAnswers,0);
  assert.equal(current.wronglyAcceptedKnownNegatives,0);
  assert.ok(current.rows.every(r=>r.expectedArtistOwned===null&&r.outcome==='unscored'));
  assert.equal(current.currentOwnershipClaimsAllowed,false);
  assert.equal(current.excludedFromCurrentOwnership,10);
});

test('re-adjudication is append-only; expiry boundary is unscored, not wrong identity',()=>{
  const before=JSON.stringify(labels);
  const updated=append(labels,review);
  assert.equal(JSON.stringify(labels),before);
  assert.deepEqual(updated.cases,labels.cases);
  assert.deepEqual(updated.evidence,labels.evidence);
  assert.equal(ownershipFreshness(updated,updated.cases[0],{asOf:'2026-11-09T00:00:00.000Z'}).status,'historical_only');
  const suite=assembleOwnershipSuite(updated,requests,legacy,{asOf});
  const current=scoreOwnershipBenchmark(suite,responses(suite),{mode:'current',asOf});
  assert.equal(current.knownAnswers,1);
  assert.equal(current.rows[0].expectedArtistOwned,true);
  assert.equal(current.rows[0].savedEvidenceAndVerifierGatePassed,false);
  const expired=scoreOwnershipBenchmark(suite,responses(suite),{mode:'current',asOf:review.validUntil});
  assert.equal(expired.knownAnswers,0);
  assert.equal(expired.rows[0].ownershipFreshness.status,'expired');
  assert.equal(expired.rows[0].expectedArtistOwned,null);
  assert.equal(scoreOwnershipBenchmark(suite,[],{asOf:review.validUntil}).knownAnswers,10);
});

test('stale notice preserves positive label; renewal explicitly supersedes the notice',()=>{
  const initial=append(labels,review);
  const stale={id:'notice',caseId:review.caseId,supersedes:review.id,action:'stale',
    reviewedAt:'2026-11-11T00:00:00.000Z',reviewer:'Curator',reason:'Possible handle reuse, not proven wrong identity.'};
  const marked=append(initial,stale);
  assert.equal(marked.cases[0].expectedArtistOwned,true);
  assert.equal(ownershipFreshness(marked,marked.cases[0],{asOf:stale.reviewedAt}).status,'stale');
  const renewed=append(marked,{...review,id:'renewal',supersedes:'notice',reviewedAt:stale.reviewedAt});
  assert.equal(renewed.freshness.reviews.length,3);
  assert.equal(ownershipFreshness(renewed,renewed.cases[0],{asOf:stale.reviewedAt}).status,'current');
  for(const bad of [
    {...review,id:'renewal',supersedes:null},
    {...stale,adjudication:{expectedArtistOwned:false}},
    {...review,validUntil:review.reviewedAt},
    {...review,reviewer:''},
    {...review,reviewedAt:'2026-11-09T00:00:00.000Z'},
  ]) assert.throws(()=>append(initial,bad));
});

test('a changed identity is explicit new adjudication, never an edit to original answers',()=>{
  const evidence={replacement:{...labels.evidence.brand,
    selectedLinks:[labels.cases[0].url],acquisition:{kind:'existing_archive',archiveReference:'fixture://archived-proof'}}};
  const updated=append(labels,{...review,adjudication:{
    expectedArtistOwned:false,stratum:'brand',evidenceIds:['replacement']}},evidence);
  const suite=assembleOwnershipSuite(updated,requests,legacy,{asOf});
  assert.equal(suite.requests[0].candidates[0].expectedArtistOwned,true);
  const current=scoreOwnershipBenchmark(suite,responses(suite),{mode:'current',asOf});
  assert.equal(current.rows[0].expectedArtistOwned,false);
  assert.equal(current.wronglyAcceptedKnownNegatives,1);
  assert.equal(scoreOwnershipBenchmark(suite,responses(suite),{asOf}).wronglyAcceptedKnownNegatives,7);
});

test('new sources require acquisition provenance and separate prior scope/spending approvals',()=>{
  const r={...review,adjudication:{...review.adjudication,evidenceIds:['new-proof']}};
  const base={...labels.evidence.aimee};
  assert.throws(()=>append(labels,r,{'new-proof':base}),/declare/);
  assert.throws(()=>append(labels,review,{aimee:base}),/immutable/);
  const approval={scopeReference:'fixture-scope',spendingReference:'fixture-zero-cost-approval',
    approvedAt:'2026-11-09T00:00:00.000Z',maxSpendUsd:0};
  const source={...base,acquisition:{kind:'new_collection',approval}};
  assert.doesNotThrow(()=>append(labels,r,{'new-proof':source}));
  for(const change of [
    p=>delete p.spendingReference,p=>delete p.scopeReference,p=>p.maxSpendUsd=-1,
    p=>p.approvedAt='2026-11-10T00:00:00.000Z',
  ]) {
    const bad=structuredClone(source);change(bad.acquisition.approval);
    assert.throws(()=>append(labels,r,{'new-proof':bad}),/approval|Approval/);
  }
  const wrong=structuredClone(source);
  wrong.selectedLinks[1]='https://open.spotify.com/artist/wrong';
  const bad=append(labels,r,{'new-proof':wrong});
  assert.throws(()=>assembleOwnershipSuite(bad,requests,legacy,{asOf}),/target music ID/);
});

test('offline proposal emits queue and both scoring bases without touching originals or the network',async()=>{
  const parent=await fs.mkdtemp('generated-artifacts/ownership-freshness-test-');
  const original=await fs.readFile('scripts/fixtures/instagram-ownership-adjudications.json','utf8');
  const fetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('No network allowed');};
  try {
    const reviewFile=`${parent}/review.json`;
    await fs.writeFile(reviewFile,JSON.stringify({review}));
    await prepareOwnershipBenchmark({destination:`${parent}/run`,asOf,reviewFile});
    const queue=JSON.parse(await fs.readFile(`${parent}/run/re-adjudication-queue.json`,'utf8'));
    assert.equal(queue.length,9);
    const current=JSON.parse(await fs.readFile(`${parent}/run/current-ownership-scorecard.json`,'utf8'));
    assert.equal(current.knownAnswers,1);
    assert.equal(current.asOf,asOf);
    assert.equal(await fs.readFile('scripts/fixtures/instagram-ownership-adjudications.json','utf8'),original);
    assert.deepEqual(await buildOwnershipInputs(await read('instagram-ownership-inputs'),
      await read('instagram-ownership-snapshots')),requests);
    assert.throws(()=>assembleOwnershipSuite(labels,requests,legacy,{asOf:'not-a-date'}),/asOf/);
  } finally {
    globalThis.fetch=fetch;
    await fs.rm(parent,{recursive:true,force:true});
  }
});
