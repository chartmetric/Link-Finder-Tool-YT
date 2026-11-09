// Controlled four-call diagnostic; never changes production acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {factsOnlyDecision} from './instagram-alternate-verifier.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';

const source='generated-artifacts/instagram-catalog-album-verifier-test-2026-11-09';
const output='generated-artifacts/instagram-jev-label-ablation-2026-11-09';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});

export function sourceFactsOnly(request) {
  const clean=factsOnlyDecision(request);
  for(const c of clean.state.candidates) for(const meta of [c.reference,c.candidate]) {
    for(const link of meta?.musicLinkPath?.catalogAlbumLinks??[]) delete link.status;
  }
  return clean;
}

export function answersFrom(data,count) {
  return Array.from({length:count},(_,i)=>{
    const same=data.answers?.[`candidate_${i}_same_identity`]?.noul;
    const verdict=data.answers?.[`candidate_${i}_verdict`]?.choice;
    if(!Number.isFinite(same)||same<0||same>1||!['verified','likely','uncertain','mismatch'].includes(verdict)) {
      throw Error('Incomplete or invalid typed JEV decision.');
    }
    return {sameIdentityProbability:same,verdict,
      verdictLabelConfidence:data.answers[`candidate_${i}_verdict`].confidence,
      verdictProbabilities:data.answers[`candidate_${i}_verdict`].probabilities};
  });
}

export async function prepareLabelCases() {
  const cases=[];
  for(const [profileId,artist] of [['208216','Billylildove'],['35092','The Format']]) {
    const original=await read(`${source}/${profileId}-request.json`);
    const packet=await read(`${source}/responses/${profileId}-catalog-album-verifier.json`);
    assert.equal(hash(JSON.stringify(original.request)),original.inputSha256);
    assert.equal(packet.requestBodySha256,original.inputSha256);
    assert.deepEqual(packet.decisionRequest,original.request);
    for(const [variant,body] of [['baseline',original.request],['source_facts_only',sourceFactsOnly(original.request)]]) {
      assert.deepEqual(body.questions,original.request.questions);
      assert.equal(body.model,original.request.model);
      assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000);
      assert.equal(body.state.candidates.length,2);
      assert.ok(body.state.candidates.every(c=>c.reference.url===body.state.knownProfileUrl));
      cases.push({profileId,artist,variant,body,inputSha256:hash(JSON.stringify(body)),
        historicalModel:packet.data.model,sourceInputSha256:original.inputSha256});
    }
  }
  return cases;
}

async function main() {
  const cases=await prepareLabelCases(),prior=await read(`${source}/summary.json`);
  const priorCents=Math.round(prior.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,321);assert.ok(priorCents+8<=1000);
  if(!process.argv.includes('--run-approved-comparison')) {
    console.log(JSON.stringify({calls:4,maxReservedUsd:0.08,cases:cases.map(({body,...c})=>({
      ...c,bytes:Buffer.byteLength(JSON.stringify(body))})),newSearches:0,imports:0},null,2));return;
  }
  if(!process.env.OPENROUTER_API_KEY) throw Error('Missing OPENROUTER_API_KEY.');
  await fs.mkdir(output,{recursive:false});
  await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:8,
    source:'User approved investigating whether JEV caution reflects evidence, instructions or acceptance rules.',
    priorReservedCents:321,noImports:true},
    purpose:'Controlled removal of prior internal judgments only; same evidence, questions, model and acceptance thresholds.',
    removedFields:['identityComparisonStatus','identityComparisonReasons','musicLinkPath.status',
      'musicLinkPath.ownershipAssessment','musicLinkPath.catalogAlbumLinks[].status'],
    artists:['208216','35092'].map(profile_id=>({profile_id,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:4,jev_requests_per_artist:2,paid_http_requests_total:4,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:3}};
  await save(`${output}/approved-scope.json`,manifest);
  const transport={live:true,inputBytes:({payload})=>Buffer.byteLength(JSON.stringify(payload.body)),
    dispatch:async({kind,payload,key,signal})=>{
      assert.equal(kind,'jev');
      const body=JSON.stringify(payload.body);
      assert.equal(hash(body),payload.inputSha256);
      const response=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',redirect:'error',signal,
        headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body});
      const chunks=[];let bytes=0;
      if(response.body) for await(const chunk of response.body) {
        bytes+=chunk.length;if(bytes>2000000) throw Error('Response exceeds bounded evidence limit.');chunks.push(chunk);
      }
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await save(`${output}/responses/${key.replaceAll(':','-')}.json`,{
        status:response.status,decisionRequest:payload.body,requestBodySha256:payload.inputSha256,data});
      if(!response.ok||data.error) throw Error(`JEV comparison HTTP ${response.status}; no retry.`);
      if(!Number.isFinite(data.usage?.cost)||data.usage.cost<0||data.usage.cost>0.02) throw Error('Missing or excessive reported charge.');
      return {model:data.model,cost:data.usage.cost,answers:answersFrom(data,2)};
    }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+180000;
  try {
    for(const c of cases) {
      await save(`${output}/${c.profileId}-${c.variant}-request.json`,{request:c.body,inputSha256:c.inputSha256,
        sourceInputSha256:c.sourceInputSha256});
      const response=await budget.request({profileId:c.profileId,kind:'jev',
        key:`${c.profileId}:${c.variant}`,payload:c,deadlineAt});
      const row={profileId:c.profileId,artist:c.artist,variant:c.variant,inputSha256:c.inputSha256,
        resolvedModel:response.model,historicalModel:c.historicalModel,
        reportedCostUsd:response.cost,positive:response.answers[0],control:response.answers[1],
        // Music binding is fixed and valid for positive only; no model labels
        // are reintroduced into source-facts-only request data.
        positiveGatePassed:response.answers[0].verdict==='verified'&&response.answers[0].sameIdentityProbability>=0.9,
        controlGatePassed:false,productionApproved:false};
      results.push(row);await save(`${output}/${c.profileId}-${c.variant}-result.json`,row);
      console.log(JSON.stringify(row));
      if(row.control.verdict==='verified'&&row.control.sameIdentityProbability>=0.9) {
        throw Error('Unrelated control promoted; stopping remaining calls.');
      }
      if(response.model!==c.historicalModel) throw Error('Resolved model changed; stop rather than confound comparison.');
      await new Promise(r=>setTimeout(r,1000));
    }
  }finally {
    await budget.close();const snapshot=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:snapshot,completed:results.length===4,
      cumulativeConservativeReservationUsd:(priorCents+snapshot.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-priorCents-snapshot.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,
      fullRerunStarted:false,
      limitation:'Two provisional positives and distinct-artist controls cannot calibrate population precision, recall or an acceptance threshold.'});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
