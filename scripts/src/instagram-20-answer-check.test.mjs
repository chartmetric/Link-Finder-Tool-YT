import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {summarizeAnswerChecks} from './instagram-20-answer-check.mjs';
import {OWNERSHIP_RUBRIC} from './instagram-ownership-rubric.mjs';

const body={model:'fixed-model',state:{candidates:[{url:'account'}]},questions:{}};
const digest=createHash('sha256').update(JSON.stringify(body)).digest('hex');

test('frozen transport refuses altered inputs or another provider without dispatch',async()=>{
  let calls=0;
  const t=frozenJevTransport({responseDir:'unused',apiKey:'fixture',
    fetchImpl:async()=>{calls++;throw Error('Must not dispatch');}});
  await assert.rejects(t.dispatch({kind:'jev',payload:{body,inputSha256:'wrong'}}),/Changed/);
  await assert.rejects(t.dispatch({kind:'serper',payload:{body,inputSha256:digest}}),/another provider/);
  assert.equal(calls,0);
});

test('frozen transport archives exact input and billing, never auth headers; failed billing is not retried',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'frozen-jev-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;
  const transport=frozenJevTransport({responseDir:dir,apiKey:'fixture-do-not-record',
    fetchImpl:async(url,options)=>{
      calls++;assert.equal(options.redirect,'error');assert.equal(options.body,JSON.stringify(body));
      return Response.json({model:'fixed-model',usage:{cost:calls===1?0.001:0.03},answers:{
        candidate_0_same_identity:{noul:0.95},candidate_0_verdict:{choice:'verified'}}});
    }});
  const result=await transport.dispatch({kind:'jev',key:'first',payload:{body,inputSha256:digest}});
  assert.equal(result.answers[0].sameIdentityProbability,0.95);
  const text=await fs.readFile(`${dir}/first.json`,'utf8');
  assert.ok(!text.includes('fixture-do-not-record')&&!text.includes('Bearer'));
  assert.equal(JSON.parse(text).requestBodySha256,digest);
  await assert.rejects(transport.dispatch({kind:'jev',key:'second',payload:{body,inputSha256:digest}}),/billing/);
  assert.equal(calls,2);
});

test('scorecard exposes missed positives and wrong acceptances without a misleading reject-all accuracy score',()=>{
  const rows=[{expectedArtistOwned:true,modelAccepted:false,savedEvidenceAndVerifierGatePassed:false,labelKind:'user_confirmed'},
    {expectedArtistOwned:false,modelAccepted:true,labelKind:'explicit_related_entity'}];
  const result=summarizeAnswerChecks([{variant:'baseline',decisions:rows}]);
  assert.equal(result.baseline.heldKnownPositive,1);
  assert.equal(result.baseline.wronglyAcceptedKnownNegative,1);
  assert.equal(result.baseline.relatedEntityExamples,1);
  assert.equal(result[OWNERSHIP_RUBRIC].testedExamples,0);
  assert.ok(!('accuracy' in result.baseline));
});
