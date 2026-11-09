// Two authorized calls on frozen requests. No discovery, imports or retries.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {answersFrom} from './instagram-jev-label-ablation.mjs';
import {scoreKnownAnswers,validateBenchmarkRequest} from './instagram-known-answer-benchmark.mjs';

const source='generated-artifacts/instagram-known-answer-benchmark-2026-11-09';
const output='generated-artifacts/instagram-known-answer-live-test-2026-11-09';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});

async function main() {
  const suite=await read(`${source}/benchmark.json`);
  assert.equal(suite.run_allowed,false); // Preparation is immutable, not authorization.
  const core=suite.requests.filter(r=>r.group==='core');
  assert.deepEqual(core.map(r=>r.id),['regression-frankelly-wrong','regression-shenge']);
  const prepared=[];
  for(const c of core) {
    const p=await read(`${source}/requests/${c.id}.json`);
    validateBenchmarkRequest(p.request);
    assert.equal(hash(JSON.stringify(p.request)),c.inputSha256);
    assert.equal(p.inputSha256,c.inputSha256);
    // Only the frozen request, never evaluator labels, is sent to JEV.
    prepared.push({...c,request:p.request});
  }
  const prior=await read('generated-artifacts/instagram-jev-label-ablation-2026-11-09/summary.json');
  const priorCents=Math.round(prior.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,329);assert.ok(priorCents+4<=1000);
  const expectedModel=prior.results[0].resolvedModel;
  if(!process.argv.includes('--run-approved-test')) {
    console.log(JSON.stringify({calls:2,maxReservedUsd:0.04,expectedModel,
      requests:prepared.map(c=>({id:c.id,bytes:Buffer.byteLength(JSON.stringify(c.request)),inputSha256:c.inputSha256})),
      imports:0,newSearches:0},null,2));return;
  }
  if(!process.env.OPENROUTER_API_KEY) throw Error('Missing OPENROUTER_API_KEY.');
  await fs.mkdir(output,{recursive:false}); // Existing admission can never be replayed.
  await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:4,
    source:'User approved running the prepared two-call known-answer core test.',
    priorReservedCents:329,noImports:true},benchmarkFile:`${source}/benchmark.json`,
    benchmarkSha256:hash(JSON.stringify(suite)),expectedModel,
    frozenRequests:core.map(c=>({id:c.id,inputSha256:c.inputSha256})),
    artists:core.map(c=>({profile_id:c.profileId,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:2,jev_requests_per_artist:1,paid_http_requests_total:2,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:2}};
  await save(`${output}/approved-scope.json`,manifest);
  const transport={live:true,inputBytes:({payload})=>Buffer.byteLength(JSON.stringify(payload.request)),
    dispatch:async({kind,payload,key,signal})=>{
      assert.equal(kind,'jev');
      const body=JSON.stringify(payload.request);assert.equal(hash(body),payload.inputSha256);
      const response=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body});
      const chunks=[];let bytes=0;
      if(response.body) for await(const chunk of response.body) {
        bytes+=chunk.length;if(bytes>2000000) throw Error('Oversized response; no retry.');chunks.push(chunk);
      }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await save(`${output}/responses/${key.replaceAll(':','-')}.json`,
        {status:response.status,decisionRequest:payload.request,requestBodySha256:payload.inputSha256,data});
      if(!response.ok||data.error) throw Error(`JEV HTTP ${response.status}; no retry.`);
      if(!Number.isFinite(data.usage?.cost)||data.usage.cost<0||data.usage.cost>0.02) throw Error('Missing or excessive reported charge.');
      return {model:data.model,cost:data.usage.cost,answers:answersFrom(data,payload.request.state.candidates.length)};
    }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+120000;
  try {
    for(const c of prepared) {
      await save(`${output}/${c.id}-request.json`,{request:c.request,inputSha256:c.inputSha256});
      const response=await budget.request({profileId:c.profileId,kind:'jev',key:`${c.profileId}:known-answer`,
        payload:{request:c.request,inputSha256:c.inputSha256},deadlineAt});
      const row={requestId:c.id,inputSha256:c.inputSha256,resolvedModel:response.model,
        reportedCostUsd:response.cost,decisions:response.answers.map((d,i)=>({...d,url:c.candidates[i].url}))};
      results.push(row);await save(`${output}/${c.id}-result.json`,row);
      console.log(JSON.stringify(row));
      if(response.model!==expectedModel) throw Error('Resolved model changed; stop further calls.');
      if(scoreKnownAnswers(suite,results).wronglyAcceptedKnownNegatives) throw Error('Known wrong account accepted; stop further calls.');
      await new Promise(r=>setTimeout(r,1000));
    }
  }finally {
    await budget.close();const snapshot=budget.snapshot();
    const scorecard=scoreKnownAnswers(suite,results);
    await save(`${output}/scorecard.json`,scorecard);
    await save(`${output}/summary.json`,{results,budget:snapshot,completed:results.length===2,
      testedKnownAnswers:scorecard.testedKnownAnswers,heldKnownPositives:scorecard.heldKnownPositives,
      wronglyAcceptedKnownNegatives:scorecard.wronglyAcceptedKnownNegatives,
      cumulativeConservativeReservationUsd:(priorCents+snapshot.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-priorCents-snapshot.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,
      fullRerunStarted:false,productionApproved:false,
      limitation:'User-confirmed historical regressions, not independently rechecked current ownership or population accuracy.'});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
