import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestFor,parseDecision,checkPrice,MODEL,factsOnlyDecision} from './instagram-alternate-verifier.mjs';

test('facts-only ablation removes prior judgments without changing source facts, criteria or archives',()=>{
  const path={status:'exact_catalog_music_identity',ownershipAssessment:'unassessed',
    sourceUrl:'https://linktr.ee/example',pages:[{sourceUrl:'https://linktr.ee/example',
      musicTargets:['https://open.spotify.com/album/AAAAAAAAAAAAAAAAAAAAAA']}]};
  const decision={state:{artist:'Example',knownProfileUrl:'spotify',candidates:[
    {url:'instagram',identityComparisonStatus:'likely',identityComparisonReasons:['Ownership unassessed'],
      observedExactCatalogLinks:[{source:'instagram_profile_bio_link',targetUrl:'spotify'}],
      reference:{url:'spotify'},candidate:{displayName:'Example',bio:'Musician',
        externalUrls:['https://linktr.ee/example'],musicLinkPath:path}},
  ]},questions:{same:{instructions:'Require artist ownership',criteria:{true:'Same artist',false:'Different artist'}}}};
  const original=structuredClone(decision);
  const clean=factsOnlyDecision(decision);
  const item=clean.state.candidates[0];
  assert.equal(Object.hasOwn(item,'identityComparisonStatus'),false);
  assert.equal(Object.hasOwn(item,'identityComparisonReasons'),false);
  assert.deepEqual(item.candidate.musicLinkPath,{sourceUrl:path.sourceUrl,pages:path.pages});
  assert.deepEqual(item.observedExactCatalogLinks,original.state.candidates[0].observedExactCatalogLinks);
  assert.deepEqual(item.candidate.externalUrls,original.state.candidates[0].candidate.externalUrls);
  assert.deepEqual(clean.questions,original.questions);
  assert.deepEqual(decision,original);
  assert.deepEqual(factsOnlyDecision(clean),clean);
  const body=requestFor(clean),baseline=requestFor(decision);
  assert.deepEqual(body.messages[0],baseline.messages[0]);
  assert.deepEqual(body.response_format,baseline.response_format);
});

test('alternate verifier preserves exact evidence and question content without benchmark labels',()=>{
  const decision={state:{artist:'Example',candidates:[{url:'https://www.instagram.com/example/'}]},
    questions:{identity:{instructions:'Require exact ownership.'}}};
  const body=requestFor(decision);
  assert.deepEqual(JSON.parse(body.messages[1].content),decision);
  assert.equal(body.model,MODEL);
  assert.equal(body.max_tokens,8192);
  assert.equal(body.provider.allow_fallbacks,false);
  assert.equal(body.response_format.json_schema.strict,true);
});
test('pricing and size checks fail closed before any admission',()=>{
  const model={id:MODEL,supported_parameters:['structured_outputs'],pricing:{prompt:'0.000001',completion:'0.000005'}};
  assert.ok(checkPrice(model,6000)<0.06);
  assert.throws(()=>checkPrice(model,12001),/reservation/);
  assert.throws(()=>checkPrice({...model,pricing:{prompt:'0.1',completion:'0.2'}},6000),/pricing/);
  assert.throws(()=>checkPrice({...model,id:'different'},6000),/unavailable/);
});
test('malformed, reordered, out-of-range and truncated replies never become decisions',()=>{
  const good={choices:[{finish_reason:'stop',message:{content:JSON.stringify({candidates:[
    {url:'a',verdict:'verified',same_identity_score:0.98,reason:'Exact artist link'},
    {url:'b',verdict:'mismatch',same_identity_score:0.01,reason:'Different artist'},
  ]})}}]};
  assert.equal(parseDecision(good,['a','b']).length,2);
  assert.throws(()=>parseDecision(good,['b','a']),/Invalid/);
  assert.throws(()=>parseDecision({...good,choices:[{...good.choices[0],finish_reason:'length'}]},['a','b']),/Incomplete/);
  const bad=structuredClone(good);
  const content=JSON.parse(bad.choices[0].message.content);
  content.candidates[0].same_identity_score=1.2;
  bad.choices[0].message.content=JSON.stringify(content);
  assert.throws(()=>parseDecision(bad,['a','b']),/Invalid/);
});
