import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestFor,parseDecision,checkPrice,MODEL} from './instagram-alternate-verifier.mjs';

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
