// Fixed reference-label research, not blind artist discovery. No retries/imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createPilotBudget} from './instagram-pilot-budget.mjs';

const output='generated-artifacts/instagram-reference-label-audit-2026-11-09-ready';
const queries=[
  ['207595','Aimee Carty official website Instagram'],
  ['270344','Eliah Sternhardt official website Instagram'],
  ['226788','ERNEST official website country music Instagram'],
  ['35092','The Format band official website Instagram'],
  ['216490','JUNHEE official website Instagram'],
  ['226422','VALE duo official website Instagram'],
  ['5643','J Cole official website Instagram'],
  ['205493','RnBoi official website Instagram'],
  ['249317','Gula Gula Festival official website instagram gulagulafestival'],
  ['302463','Golden Legends Cymbals official website Instagram'],
];
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});
async function main(){
  const prior=JSON.parse(await fs.readFile('generated-artifacts/instagram-ownership-rubric-check-2026-11-09/summary.json','utf8'));
  assert.equal(prior.cumulativeConservativeReservationUsd,3.43);
  if(!process.argv.includes('--run-approved-audit')) {
    console.log(JSON.stringify({queries,maxReserveUsd:0.10,noImports:true}));return;
  }
  if(!process.env.SERPERDEV_API_KEY) throw Error('Missing SERPERDEV_API_KEY.');
  await fs.mkdir(output,{recursive:false});
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:10,
    source:'User approved assembling independently sourced known-answer examples and comparing verification rules; total new ceiling $0.50 including research and comparison.',
    priorReservedCents:343,noImports:true},
    artists:queries.map(([profile_id])=>({profile_id,source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:10,serper_requests_per_artist:1,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:0,jev_requests_per_artist:0,paid_http_requests_total:10,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:5},queries};
  await save(`${output}/approved-scope.json`,manifest);
  const transport={live:true,dispatch:async({kind,payload,key,signal})=>{
    assert.equal(kind,'serper');
    const r=await fetch('https://google.serper.dev/search',{method:'POST',redirect:'error',signal,
      headers:{'X-API-KEY':process.env.SERPERDEV_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({q:payload.query,num:5})});
    const text=await r.text();assert.ok(text.length<=1000000);const data=JSON.parse(text);
    await save(`${output}/${key}.json`,{at:new Date().toISOString(),status:r.status,query:payload.query,data});
    if(!r.ok||data.error||!Array.isArray(data.organic)) throw Error(`Reference research failed (HTTP ${r.status}); no retry.`);
    return data;
  }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[];
  try{
    for(const[profileId,query]of queries){
      const data=await budget.request({profileId,kind:'serper',key:`reference-${profileId}`,payload:{query},deadlineAt:Date.now()+25000});
      const row={profileId,query,results:data.organic.map(({title,link,snippet})=>({title,link,snippet}))};
      results.push(row);console.log(JSON.stringify(row));
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{
    await budget.close();const s=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:s,completed:results.length===queries.length,
      cumulativeConservativeReservationUsd:3.43+s.reservedSpendCents/100,
      remainingOriginalBudgetUsd:6.57-s.reservedSpendCents/100,claims:0,databaseWrites:0});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
