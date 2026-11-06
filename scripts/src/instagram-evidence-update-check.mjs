// Fixed, two-call JEV comparison on saved evidence only. Never searches or imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPilotBudget } from './instagram-pilot-budget.mjs';
import { createLiveTransport, jevRequest } from './instagram-pilot-live-transport.mjs';

const sampleDir = 'generated-artifacts/instagram-verification-benchmark-2026-11-06';
const outputDir = 'generated-artifacts/instagram-evidence-update-check-2026-11-06';
const comparisons = [
  { positive:'207595', control:'35092' }, // Aimee Carty / The Format
  { positive:'270344', control:'208216' }, // Eliah Sternhardt / Billylildove
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function readArtist(id) {
  const artist=JSON.parse(await fs.readFile(path.join(sampleDir,`${id}-metadata.json`),'utf8'));
  if(!artist.referenceMetadata || !artist.candidateMetadata || artist.profile_id!==id) {
    throw Error(`Saved identity evidence unavailable for profile ${id}.`);
  }
  return artist;
}
const manifest = {
  run_allowed:true,
  authorization:{approved:true,approvedBy:'user',maxSpendCents:4,
    source:'Two-call capped JEV validation using existing saved evidence only.',
    noSerper:true,noScrapeCreators:true,noImports:true},
  artists:comparisons.map(({positive})=>({
    profile_id:positive,cm_artist:'0',source_identity_matches:true,
    reference_preflight:{readiness:'reference_usable'},
  })),
  proposed_limits:{
    serper_requests_total:0,serper_requests_per_artist:0,
    scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
    jev_requests_total:2,jev_requests_per_artist:1,paid_http_requests_total:2,
    public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
    public_http_requests_total:0,public_music_page_requests_per_artist:1,
    global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
    jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
    automatic_retries:0,job_wall_time_minutes:5,
  },
};

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(await fs.stat(outputDir).then(()=>true,()=>false)) throw Error('Output directory already exists; this test cannot replay.');
  for(const key of ['OPENROUTER_API_KEY','SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY']) {
    if(!process.env[key]) throw Error(`Required secret is missing: ${key}`);
  }
  await fs.mkdir(outputDir,{recursive:false});
  await fs.mkdir(path.join(outputDir,'responses'));
  const artists=new Map();
  for(const pair of comparisons) for(const id of [pair.positive,pair.control]) {
    if(!artists.has(id)) artists.set(id,await readArtist(id));
  }
  const prepared=comparisons.map(({positive,control})=>({
    positive:artists.get(positive),control:artists.get(control),
  }));
  const serializedManifest={...manifest,sourceSample:sampleDir,
    sourceManifestSha256:sha256(JSON.stringify(comparisons))};
  await fs.writeFile(path.join(outputDir,'approved-scope.json'),JSON.stringify(serializedManifest,null,2),{flag:'wx'});
  const transport=createLiveTransport({
    keys:Object.fromEntries(['OPENROUTER_API_KEY','SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY'].map(k=>[k,process.env[k]])),
    responseDir:path.join(outputDir,'responses'),
  });
  const budget=await createPilotBudget({manifest,journalPath:path.join(outputDir,'admissions.jsonl'),transport,mode:'live'});
  const results=[];
  try {
    for(const {positive,control} of prepared) {
      const candidate = artist => ({url:artist.candidateMetadata.url,
        identityComparison:{status:'likely',reasons:['Saved exact catalog-link evidence; independent ownership remains unassessed.'],
          reference:artist.referenceMetadata,candidate:artist.candidateMetadata}});
      const profiles=[candidate(positive),candidate(control)];
      const payload={artist:positive.artist,catalogReference:positive.referenceMetadata,profiles};
      const byteLength=transport.inputBytes({kind:'jev',payload});
      if(byteLength>6000) throw Error(`Updated request is ${byteLength} bytes; refusing the call.`);
      const decisions=await budget.request({profileId:positive.profile_id,kind:'jev',
        key:`${positive.profile_id}:updated-evidence:jev`,payload});
      const baseline=JSON.parse(await fs.readFile(path.join(sampleDir,`${positive.profile_id}-outcome.json`),'utf8'));
      const controlBaseline=JSON.parse(await fs.readFile(path.join(sampleDir,`${positive.profile_id}-outcome.json`),'utf8'));
      const result={
        artist:positive.artist,profileId:positive.profile_id,tier:positive.tier,
        candidateUrl:positive.url,controlArtist:control.artist,controlProfileId:control.profile_id,
        controlUrl:control.url,inputBytes:byteLength,
        exactLinksSent:jevRequest(payload).state.candidates.map(p=>p.observedExactCatalogLinks),
        updatedPositiveDecision:decisions[0].jevVerification,
        priorPositiveDecision:baseline.decision,
        updatedControlDecision:decisions[1].jevVerification,
        priorControlDecision:controlBaseline.negativeControl?.decision,
        positiveStillMeetsStrictGate:decisions[0].jevVerification.verdict==='verified'
          && decisions[0].jevVerification.sameIdentityProbability>=0.9,
        controlPromoted:decisions[1].jevVerification.verdict==='verified'
          && decisions[1].jevVerification.sameIdentityProbability>=0.9,
        approvedLink:false,claimSubmitted:false,
      };
      results.push(result);
      await fs.writeFile(path.join(outputDir,`${positive.profile_id}-comparison.json`),
        JSON.stringify({...result,decisionPayload:payload},null,2),{flag:'wx'});
      console.log(JSON.stringify({artist:result.artist,updatedPositiveDecision:result.updatedPositiveDecision,
        priorPositiveDecision:result.priorPositiveDecision,updatedControlDecision:result.updatedControlDecision,
        controlPromoted:result.controlPromoted,inputBytes:byteLength}));
    }
  } finally { await budget.close(); }
  const finalBudget=budget.snapshot();
  if(finalBudget.paid!==2 || finalBudget.reservedSpendCents>4 || finalBudget.byKind.jev!==2
    || Object.keys(finalBudget.byKind).some(kind=>kind!=='jev')) {
    throw Error('Two-call, two-cent-per-call safety limits did not reconcile.');
  }
  const summary={test:'Updated verifier evidence vs saved baseline; two calls, saved inputs only.',
    results,budget:finalBudget,previousConservativeReservationUsd:1.19,
    cumulativeConservativeReservationUsd:1.19+finalBudget.reservedSpendCents/100,
    remainingOfOriginalPilotBudgetUsd:10-1.19-finalBudget.reservedSpendCents/100,
    newSerperCalls:0,newScrapeCreatorsCalls:0,claims:0,databaseWrites:0,
    fullTierRerunStarted:false,finishedAt:new Date().toISOString()};
  await fs.writeFile(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
  console.log(JSON.stringify({finished:true,budget:finalBudget,
    cumulativeConservativeReservationUsd:summary.cumulativeConservativeReservationUsd,
    remainingOfOriginalPilotBudgetUsd:summary.remainingOfOriginalPilotBudgetUsd,
    claims:0,databaseWrites:0,fullTierRerunStarted:false}));
}
