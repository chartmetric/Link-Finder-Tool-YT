// Capped test of generic criteria. No discovery, claims or default-policy change.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {OWNERSHIP_RUBRIC,withOwnershipRubric} from './instagram-ownership-rubric.mjs';
import {validateBenchmarkRequest} from './instagram-known-answer-benchmark.mjs';
import {answersFrom} from './instagram-jev-label-ablation.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';

const source='generated-artifacts/instagram-known-answer-benchmark-2026-11-09';
const output='generated-artifacts/instagram-ownership-rubric-check-2026-11-09';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});
const hash=x=>createHash('sha256').update(x).digest('hex');

async function main() {
  const suite=await read(`${source}/benchmark.json`);
  const prior=await read('generated-artifacts/instagram-known-answer-live-test-2026-11-09/summary.json');
  const priorCents=Math.round(prior.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,333);assert.ok(priorCents+10<=1000);
  const expectedModel=prior.results[0].resolvedModel;
  const specs=[
    ['regression-frankelly-wrong','baseline'],
    ['regression-frankelly-wrong',OWNERSHIP_RUBRIC],
    ['regression-shenge',OWNERSHIP_RUBRIC],
    ['regression-frankelly-associated',OWNERSHIP_RUBRIC],
    ['regression-gula-festival',OWNERSHIP_RUBRIC],
  ];
  const prepared=[];
  for(const [id,variant] of specs) {
    const r=suite.requests.find(r=>r.id===id);assert.ok(r);
    const p=await read(`${source}/requests/${id}.json`);
    assert.equal(hash(JSON.stringify(p.request)),r.inputSha256);
    const body=variant==='baseline'?p.request:withOwnershipRubric(p.request);
    validateBenchmarkRequest(body);
    assert.deepEqual(body.state,p.request.state);
    assert.equal(body.model,p.request.model);
    prepared.push({...r,variant,body,inputSha256:hash(JSON.stringify(body)),sourceInputSha256:r.inputSha256});
  }
  if(!process.argv.includes('--run-approved-check')) {
    console.log(JSON.stringify({calls:5,maxReservedUsd:0.10,cases:prepared.map(c=>({
      id:c.id,variant:c.variant,bytes:Buffer.byteLength(JSON.stringify(c.body))})),imports:0},null,2));return;
  }
  if(!process.env.OPENROUTER_API_KEY) throw Error('Missing OPENROUTER_API_KEY.');
  await fs.mkdir(output,{recursive:false});
  await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:10,
    source:'User approved a general evidence-evaluation adjustment and testing against correct and misleading saved accounts.',
    priorReservedCents:333,noImports:true},ownershipRubric:OWNERSHIP_RUBRIC,
    defaultPolicyChanged:false,sourceEvidenceIsHistorical:true,expectedModel,
    cases:prepared.map(({body,candidates,...c})=>c),
    artists:[...new Set(prepared.map(c=>c.profileId))].map(profile_id=>({
      profile_id,source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:5,jev_requests_per_artist:3,paid_http_requests_total:5,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:3}};
  await save(`${output}/approved-scope.json`,manifest);
  const transport={live:true,inputBytes:({payload})=>Buffer.byteLength(JSON.stringify(payload.body)),
    dispatch:async({kind,payload,key,signal})=>{
      assert.equal(kind,'jev');
      const body=JSON.stringify(payload.body);assert.equal(hash(body),payload.inputSha256);
      const response=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body});
      const chunks=[];let bytes=0;
      if(response.body) for await(const chunk of response.body) {
        bytes+=chunk.length;if(bytes>2000000) throw Error('Oversized response; no retry.');chunks.push(chunk);
      }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await save(`${output}/responses/${key.replaceAll(':','-')}.json`,{
        status:response.status,decisionRequest:payload.body,requestBodySha256:payload.inputSha256,data});
      if(!response.ok||data.error) throw Error(`JEV HTTP ${response.status}; no retry.`);
      assert.ok(Number.isFinite(data.usage?.cost)&&data.usage.cost>=0&&data.usage.cost<=0.02);
      return {model:data.model,cost:data.usage.cost,answers:answersFrom(data,2)};
    }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+180000;
  try {
    for(const c of prepared) {
      const key=`${c.profileId}:${c.id}:${c.variant}`;
      await save(`${output}/${c.id}-${c.variant}-request.json`,{request:c.body,inputSha256:c.inputSha256});
      const response=await budget.request({profileId:c.profileId,kind:'jev',key,
        payload:{body:c.body,inputSha256:c.inputSha256},deadlineAt});
      const row={id:c.id,variant:c.variant,inputSha256:c.inputSha256,resolvedModel:response.model,
        reportedCostUsd:response.cost,decisions:response.answers.map((d,i)=>{
          const a=c.candidates[i],modelAccepted=d.verdict==='verified'&&d.sameIdentityProbability>=0.9;
          return {...a,...d,modelAccepted,
            savedEvidenceAndVerifierGatePassed:a.savedExactLinkEligible&&modelAccepted};
        })};
      results.push(row);await save(`${output}/${c.id}-${c.variant}-result.json`,row);
      console.log(JSON.stringify({id:row.id,variant:row.variant,decisions:row.decisions.map(d=>({
        url:d.url,score:d.sameIdentityProbability,verdict:d.verdict,modelAccepted:d.modelAccepted,
        evidenceAndVerifierGate:d.savedEvidenceAndVerifierGatePassed}))}));
      if(row.decisions.some(d=>d.modelAccepted&&(d.expectedArtistOwned===false||d.observedRelatedRole))) {
        throw Error('Wrong or related-entity control promoted; stop remaining calls.');
      }
      if(response.model!==expectedModel) throw Error('Model changed; stop rather than confound comparison.');
      await new Promise(r=>setTimeout(r,1000));
    }
  }finally {
    await budget.close();const snapshot=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:snapshot,completed:results.length===5,
      cumulativeConservativeReservationUsd:(priorCents+snapshot.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-priorCents-snapshot.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,
      fullRerunStarted:false,defaultPolicyChanged:false,productionApproved:false,
      limitation:'Development regressions, not held-out population validation. Related-entity roles are challenges, not independently rechecked gold labels.'});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
