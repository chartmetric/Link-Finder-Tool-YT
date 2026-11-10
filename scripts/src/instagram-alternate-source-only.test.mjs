import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requestFor,sourceOnlyRequestFor,factsOnlyDecision} from './instagram-alternate-verifier.mjs';
import {sourceFactsOnly} from './instagram-jev-label-ablation.mjs';
import {answerCheckVariants} from './instagram-20-answer-check.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {withoutWorkflowJudgments} from './instagram-source-only-decision.mjs';
import {OWNERSHIP_RUBRIC} from './instagram-ownership-rubric.mjs';

const fixture=JSON.parse(await fs.readFile(
  new URL('../fixtures/instagram-alternate-request-input.json',import.meta.url),'utf8'));
const original=fixture.request;
const hash=body=>createHash('sha256').update(JSON.stringify(body)).digest('hex');
const userInput=body=>JSON.parse(body.messages[1].content);

test('synthetic historical baseline and old ablations remain pinned, including deliberate field omissions',()=>{
  assert.equal(fixture.fixtureKind,'synthetic_not_a_historical_capture');
  const before=JSON.stringify(original);
  assert.equal(hash(requestFor(original)),'0c96560bd1628ba13bb46fa017f3688aead9e4afaa654ac6e3080361125e421d');
  assert.equal(hash(requestFor(factsOnlyDecision(original))),'37ef43d4dcfe65c518a44163ce9064338f168eb199c8c6b3f4c1f86eaff4b8da');
  assert.equal(hash(sourceFactsOnly(original)),'15c36c93b4bc5825b38921a89d1778a9b68c5b0f5207d40fc41310bf1cf9aaf6');
  assert.deepEqual(userInput(requestFor(original)),{state:original.state,questions:original.questions});
  assert.equal(JSON.stringify(original),before);
});

const builders=[
  ['alternate source-only',raw=>userInput(sourceOnlyRequestFor(raw))],
  ['20-answer baseline',raw=>answerCheckVariants(raw)[0][1]],
  ['20-answer ownership rubric',raw=>answerCheckVariants(raw)[1][1]],
];
for(const [name,build] of builders) {
  test(`${name}: changing or deleting every prior workflow label cannot change the input`,()=>{
    const before=structuredClone(original),body=build(original);
    const changed=structuredClone(original);
    changed.state.candidates.forEach(c=>{
      c.identityComparisonStatus='verified';
      c.identityComparisonReasons=['OPPOSITE_PRIOR_WORKFLOW_JUDGMENT'];
    });
    assert.deepEqual(build(changed),body);
    changed.state.candidates.forEach(c=>{
      delete c.identityComparisonStatus;
      delete c.identityComparisonReasons;
    });
    assert.deepEqual(build(changed),body);
    assert.doesNotMatch(JSON.stringify(body),/PRIOR_WORKFLOW|identityComparisonStatus|identityComparisonReasons/);
    // Assert all other state, not just selected fields: both candidates,
    // reference metadata, unresolved links, path status, unassessed ownership,
    // album binding statuses/reasons/rows, provenance and source text survive.
    assert.deepEqual(body.state,changed.state);
    assert.deepEqual(original,before);
    assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000);
  });
}

test('new builders keep baseline questions and alternate options; rubric varies questions only',()=>{
  const clean=withoutWorkflowJudgments(original);
  assert.deepEqual(withoutWorkflowJudgments(clean),clean);
  assert.deepEqual(sourceOnlyRequestFor(original),requestFor(clean));
  const variants=answerCheckVariants(original);
  assert.deepEqual(variants.map(([v])=>v),['baseline',OWNERSHIP_RUBRIC]);
  assert.deepEqual(variants[0][1],clean);
  assert.deepEqual(variants[1][1].state,clean.state);
  assert.equal(variants[1][1].model,clean.model);
  assert.notDeepEqual(variants[1][1].questions,clean.questions);
});

test('frozen transport preserves labeled history and new source-only inputs exactly, with no post-hash cleanup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'alternate-source-only-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const observed=[];
  const transport=frozenJevTransport({responseDir:dir,apiKey:'offline-fixture-only',
    fetchImpl:async(url,options)=>{
      observed.push(options.body);
      return Response.json({model:original.model,usage:{cost:0},answers:Object.fromEntries(
        [0,1].flatMap(i=>[[`candidate_${i}_same_identity`,{noul:0.5}],
          [`candidate_${i}_verdict`,{choice:'uncertain'}]]))});
    }});
  const cases=[['frozen-history',original],...answerCheckVariants(original)];
  for(const [key,body] of cases) {
    const inputSha256=hash(body),before=JSON.stringify(body);
    const payload={body,inputSha256};
    assert.equal(transport.inputBytes({payload}),Buffer.byteLength(before));
    await transport.dispatch({kind:'jev',key,payload});
    const saved=JSON.parse(await fs.readFile(`${dir}/${key}.json`,'utf8'));
    assert.equal(observed.at(-1),before);
    assert.equal(JSON.stringify(saved.decisionRequest),before);
    assert.equal(saved.requestBodySha256,inputSha256);
    assert.equal(hash(saved.decisionRequest),inputSha256);
    assert.equal(JSON.stringify(body),before);
  }
  assert.match(observed[0],/PRIOR_WORKFLOW_POSITIVE/);
  assert.doesNotMatch(observed[1],/PRIOR_WORKFLOW_POSITIVE/);
  assert.notEqual(hash(original),hash(cases[1][1]));
  // A hash of labeled history cannot authorize its cleaned replacement.
  await assert.rejects(transport.dispatch({kind:'jev',key:'wrong-binding',
    payload:{body:cases[1][1],inputSha256:hash(original)}}),/Changed/);
  const oversized=structuredClone(original);oversized.state.artist='x'.repeat(6001);
  await assert.rejects(transport.dispatch({kind:'jev',key:'oversized',
    payload:{body:oversized,inputSha256:hash(oversized)}}),/oversized/);
  assert.equal(observed.length,cases.length);
  assert.deepEqual(await fs.readdir(dir),cases.map(([key])=>`${key}.json`).sort());
});
