import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBenchmark, controlFor, verificationGate } from './instagram-verification-benchmark.mjs';

test('benchmark freezes four distinct artists per tier without triggering network requests', () => {
  const cohort = [],refs = [],research = [];
  for(let tier=1;tier<=5;tier++) for(let n=0;n<4;n++) {
    const profile_id = String(tier*100+n);
    cohort.push({profile_id,cm_artist:profile_id,tier,artist:`Artist ${profile_id}`});
    const accounts = [['1','spotify',`https://open.spotify.com/artist/${profile_id.padStart(22,'0')}`,'']];
    if(n<2) accounts.push(['2','instagram',`https://www.instagram.com/artist${profile_id}/`,'']);
    else research.push({profile_id,instagram_urls:[`https://www.instagram.com/artist${profile_id}/`],
      methods_json:JSON.stringify([{method:'serper',status:'used'}])});
    refs.push({profile_id,accounts});
  }
  const selected = selectBenchmark(cohort,refs,research);
  assert.equal(selected.length,20);
  assert.equal(new Set(selected.map(a=>a.profile_id)).size,20);
  for(const tier of [1,2,3,4,5]) for(const bucket of ['catalog_benchmark','saved_candidate']) {
    assert.equal(selected.filter(a=>Number(a.tier)===tier&&a.bucket===bucket).length,2);
  }
  assert.deepEqual(selectBenchmark([...cohort].reverse(),refs,research),selected);
  assert.throws(()=>selectBenchmark(cohort,refs,[]),/Insufficient/);
});

test('negative controls rotate and never reuse the same reference or account identity', () => {
  const artists = [1,2,3].map(n=>({profile_id:String(n),artist:`Different ${n}`,
    reference:{url:`spotify${n}`},url:`instagram${n}`,referenceMetadata:{},candidateMetadata:{}}));
  assert.equal(controlFor(artists[0],artists).profile_id,'2');
  assert.equal(controlFor(artists[1],artists).profile_id,'3');
  assert.equal(controlFor(artists[2],artists).profile_id,'1');
  assert.equal(controlFor(artists[0],[artists[0]]),undefined);
});

test('diagnostic verifier gate retains exact cross-link plus verified 0.90 threshold', () => {
  const catalog = {platform:'spotify',url:'https://open.spotify.com/artist/1234567890123456789012'};
  const reference = {...catalog};
  const profile = {url:'https://www.instagram.com/rightaccount/',identityComparison:{
    status:'likely',candidate:{url:'https://www.instagram.com/rightaccount/',externalUrls:[catalog.url]}}};
  const decision = (verdict,score)=>({jevVerification:{verdict,sameIdentityProbability:score}});
  assert.equal(verificationGate(reference,catalog,profile,decision('verified',0.9)),true);
  assert.equal(verificationGate(reference,catalog,profile,decision('verified',0.81)),false);
  assert.equal(verificationGate(reference,catalog,profile,decision('likely',0.99)),false);
  assert.equal(verificationGate(reference,catalog,profile,decision('verified',1.01)),false);
  profile.identityComparison.candidate.externalUrls=[];
  assert.equal(verificationGate(reference,catalog,profile,decision('verified',0.99)),false);
});
