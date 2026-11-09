import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreKnownAnswers,validateBenchmarkRequest} from './instagram-known-answer-benchmark.mjs';

const suite={requests:[{id:'core',inputSha256:'frozen',candidates:[
  {url:'right',category:'known_answer',expectedArtistOwned:true,savedExactLinkEligible:false},
  {url:'wrong',category:'known_answer',expectedArtistOwned:false,savedExactLinkEligible:false},
]},{id:'other',inputSha256:'otherhash',candidates:[
  {url:'uncertain',category:'unadjudicated',expectedArtistOwned:null,savedExactLinkEligible:true},
]}]};
const decision=(url,verdict='verified',sameIdentityProbability=0.95)=>({url,verdict,sameIdentityProbability});

test('preparation has no results; unknown cases never become known positives or negatives',()=>{
  const s=scoreKnownAnswers(suite);
  assert.equal(s.knownAnswers,2);assert.equal(s.testedKnownAnswers,0);
  assert.ok(s.rows.every(r=>r.outcome==='not_tested'));
  assert.equal(s.populationAccuracyClaim,false);assert.equal(s.thresholdCalibrated,false);
});

test('missed positives, wrong acceptances and evidence holds are separately visible',()=>{
  const response={requestId:'core',inputSha256:'frozen',decisions:[decision('right','likely',0.7),decision('wrong')]};
  const s=scoreKnownAnswers(suite,[response]);
  assert.equal(s.heldKnownPositives,1);assert.equal(s.wronglyAcceptedKnownNegatives,1);
  assert.equal(s.rows[1].savedEvidenceAndVerifierGatePassed,false);
  const pass=scoreKnownAnswers(suite,[{...response,decisions:[decision('right'),decision('wrong','mismatch',0.1)]}]);
  assert.equal(pass.rows[0].outcome,'recognized_known_positive');
  assert.equal(pass.rows[0].savedEvidenceAndVerifierGatePassed,false);
  assert.equal(pass.rows[1].outcome,'held_known_negative');
});

test('reject wrong request hashes, URL substitutions, invalid scores and duplicate results',()=>{
  const r={requestId:'core',inputSha256:'frozen',decisions:[decision('right'),decision('wrong')]};
  for(const invalid of [{...r,inputSha256:'changed'},{...r,decisions:[decision('swapped'),decision('wrong')]},
    {...r,decisions:[decision('right','verified',NaN),decision('wrong')]}]) {
    assert.throws(()=>scoreKnownAnswers(suite,[invalid]));
  }
  assert.throws(()=>scoreKnownAnswers(suite,[r,r]),/Duplicate/);
});

test('request validation requires both candidates bound to the target and unchanged size limit',()=>{
  const body={model:'model',state:{knownProfileUrl:'target',candidates:[0,1].map(i=>({
    url:`https://www.instagram.com/person${i}/`,reference:{url:'target'}}))},
    questions:Object.fromEntries([0,1].flatMap(i=>[[`candidate_${i}_same_identity`,{}],[`candidate_${i}_verdict`,{}]]))};
  validateBenchmarkRequest(body);
  const bad=structuredClone(body);bad.state.candidates[1].reference.url='control-own-reference';
  assert.throws(()=>validateBenchmarkRequest(bad));
  assert.throws(()=>validateBenchmarkRequest({...body,padding:'x'.repeat(6001)}),/ceiling/);
});
