// Three frozen-input evidence checks; no search, policy change, claims or imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {instagramProfileUrl,referenceUrl} from './musician-instagram-matching.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';

const source='generated-artifacts/instagram-20-answer-check-2026-11-09';
const research='generated-artifacts/instagram-reference-label-audit-2026-11-09-ready';
const output='generated-artifacts/instagram-official-site-evidence-check-2026-11-09';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});

export function addWebsiteEvidence(request,proof) {
  const sourceUrl=new URL(proof.url);
  assert.ok(sourceUrl.protocol==='https:'&&!sourceUrl.username&&!sourceUrl.password&&!sourceUrl.port);
  assert.equal(proof.status,200);
  assert.match(proof.bodySha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(proof.at)));
  assert.ok(Array.isArray(proof.links)&&proof.links.length<=10);
  assert.ok(proof.links.some(u=>referenceUrl(u,'spotify')===request.state.knownProfileUrl),
    'Website snapshot does not contain the target music ID.');
  assert.ok(proof.links.some(u=>instagramProfileUrl(u)),'No safe direct Instagram account link.');
  for(const value of proof.links) {
    const u=new URL(value);
    assert.ok(u.protocol==='https:'&&!u.username&&!u.password&&!u.port,'Unsafe observed website link.');
  }
  const out=structuredClone(request);
  // These are actual source-page facts, shared by all candidate assessments.
  // Do not reclassify them as Spotify profile links or add expected answers.
  out.state.websiteEvidence=[{sourceKind:'website_html_links',sourceUrl:proof.url,
    pageTitle:proof.title,checkedAt:proof.at,bodySha256:proof.bodySha256,links:proof.links}];
  assert.ok(Buffer.byteLength(JSON.stringify(out))<=6000,'Augmented request exceeds unchanged ceiling.');
  return out;
}

async function main(){
  const previous=await read(`${source}/summary.json`),scope=await read(`${source}/approved-scope.json`);
  const priorCents=Math.round(previous.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,393);assert.ok(priorCents+6<=1000);
  const prepared=[];
  for(const id of ['207595','226788','35092']){
    const base=await read(`${source}/${id}-0-baseline-request.json`);
    const historical=previous.results.find(r=>r.id===`${id}-0-baseline`);
    assert.equal(hash(JSON.stringify(base.request)),historical.inputSha256);
    assert.equal(base.inputSha256,historical.inputSha256);
    const proofFile=`${research}/direct-html-links-${id}.json`,proofText=await fs.readFile(proofFile,'utf8');
    assert.equal(hash(proofText),scope.sources.find(s=>s.file===proofFile)?.sha256);
    const body=addWebsiteEvidence(base.request,JSON.parse(proofText));
    assert.deepEqual(body.questions,base.request.questions);assert.equal(body.model,base.request.model);
    prepared.push({profileId:id,body,inputSha256:hash(JSON.stringify(body)),
      baseline:historical,proofFile,proofSha256:hash(proofText)});
  }
  if(!process.argv.includes('--run-approved-test')){
    console.log(JSON.stringify({calls:3,maxReservedUsd:0.06,defaultQuestionsUnchanged:true,
      requests:prepared.map(c=>({id:c.profileId,bytes:Buffer.byteLength(JSON.stringify(c.body))})),
      searches:0,imports:0},null,2));return;
  }
  const transport=frozenJevTransport({responseDir:`${output}/responses`,apiKey:process.env.OPENROUTER_API_KEY});
  await fs.mkdir(output,{recursive:false});await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:6,
    source:'User approved the three-call official-site evidence check with no imports.',
    priorReservedCents:393,noImports:true},experimentalChange:'Actual saved website facts only; default questions/model/threshold unchanged.',
    sourceMetadataHistorical:true,newGradingLabelsSent:false,
    sourceInputs:prepared.map(c=>({profileId:c.profileId,inputSha256:c.inputSha256,
      baselineInputSha256:c.baseline.inputSha256,proofFile:c.proofFile,proofSha256:c.proofSha256})),
    artists:prepared.map(c=>({profile_id:c.profileId,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:3,jev_requests_per_artist:1,paid_http_requests_total:3,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,global_concurrent_provider_requests:1,
      per_request_timeout_seconds:20,jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:3}};
  await save(`${output}/approved-scope.json`,manifest);
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+180000;
  try{
    for(const c of prepared){
      await save(`${output}/${c.profileId}-request.json`,{request:c.body,inputSha256:c.inputSha256});
      const response=await budget.request({profileId:c.profileId,kind:'jev',key:`${c.profileId}:website-evidence`,
        payload:{body:c.body,inputSha256:c.inputSha256},deadlineAt});
      const row={profileId:c.profileId,inputSha256:c.inputSha256,model:response.model,reportedCostUsd:response.cost,
        decisions:response.answers.map((d,i)=>{
          const original=c.baseline.decisions[i],passed=d.verdict==='verified'&&d.sameIdentityProbability>=0.9;
          return {url:original.url,...d,expectedArtistOwned:original.expectedArtistOwned,
            baselineVerdict:original.verdict,baselineScore:original.sameIdentityProbability,
            baselineModelAccepted:original.modelAccepted,modelAccepted:passed,
            historicalExactLinkEligible:original.savedExactLinkEligible,
            historicalEvidenceAndVerifierGatePassed:original.savedExactLinkEligible&&passed,
            productionApproved:false};
        })};
      results.push(row);await save(`${output}/${c.profileId}-result.json`,row);console.log(JSON.stringify(row));
      if(response.model!==c.baseline.model)throw Error('Resolved model changed; stop further calls.');
      if(row.decisions.some(d=>!d.expectedArtistOwned&&d.modelAccepted))throw Error('Wrong account accepted; stop further calls.');
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{
    await budget.close();const b=budget.snapshot(),decisions=results.flatMap(r=>r.decisions);
    await save(`${output}/summary.json`,{results,budget:b,completed:results.length===3,
      correctAccountsTested:decisions.filter(d=>d.expectedArtistOwned).length,
      correctAccountsPassingModel:decisions.filter(d=>d.expectedArtistOwned&&d.modelAccepted).length,
      wrongAccountsPassingModel:decisions.filter(d=>!d.expectedArtistOwned&&d.modelAccepted).length,
      cumulativeConservativeReservationUsd:(priorCents+b.reservedSpendCents)/100,
      remainingOriginalBudgetUsd:(1000-priorCents-b.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,
      defaultPolicyChanged:false,fullRerunStarted:false,productionApproved:false,
      limitation:'Small evidence-availability diagnostic. Grading reference sources are now deliberately supplied as observations, not independent held-out accuracy or threshold calibration. Existing application evidence gates were not extended.'});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
