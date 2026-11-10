// 20 documented artist/account decisions, two fixed policies, no discovery/imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {instagramProfileUrl,referenceUrl} from './musician-instagram-matching.mjs';
import {correctedProfile} from './instagram-provenance-diagnostic.mjs';
import {sourceFactsOnly} from './instagram-jev-label-ablation.mjs';
import {OWNERSHIP_RUBRIC,withOwnershipRubric} from './instagram-ownership-rubric.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';

const output='generated-artifacts/instagram-20-answer-check-2026-11-09';
const research='generated-artifacts/instagram-reference-label-audit-2026-11-09-ready';
const benchmark='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const pilot='generated-artifacts/musician-instagram-verification-pilot-2026-11-05';
const hash=x=>createHash('sha256').update(x).digest('hex');
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const accepted=d=>d.verdict==='verified'&&d.sameIdentityProbability>=0.9;

export function summarizeAnswerChecks(results) {
  return Object.fromEntries(['baseline',OWNERSHIP_RUBRIC].map(variant=>{
    const rows=results.filter(r=>r.variant===variant).flatMap(r=>r.decisions);
    const positive=rows.filter(r=>r.expectedArtistOwned),negative=rows.filter(r=>!r.expectedArtistOwned);
    return [variant,{testedExamples:rows.length,knownPositiveExamples:positive.length,
      acceptedKnownPositive:positive.filter(r=>r.modelAccepted).length,
      heldKnownPositive:positive.filter(r=>!r.modelAccepted).length,
      knownNegativeExamples:negative.length,wronglyAcceptedKnownNegative:negative.filter(r=>r.modelAccepted).length,
      relatedEntityExamples:negative.filter(r=>r.labelKind==='explicit_related_entity').length,
      knownPositivePassingSavedEvidenceGate:positive.filter(r=>r.savedEvidenceAndVerifierGatePassed).length}];
  }));
}

async function prepare(){
  const sources=[];
  const archive=async file=>{const text=await fs.readFile(file,'utf8');sources.push({file,sha256:hash(text)});return JSON.parse(text);};
  const pool=new Map(),targets=new Map(),positiveProofs=new Map();
  const rawNames=await fs.readdir(`${benchmark}/responses`);
  async function load(id){
    const a=await archive(`${benchmark}/${id}-metadata.json`);
    const name=rawNames.find(n=>n.startsWith(`${id}-scrapecreators_candidate-`));assert.ok(name);
    const packet=await archive(`${benchmark}/responses/${name}`);assert.equal(packet.status,200);
    const u=packet.data.data?.user??packet.data.user;
    assert.equal(instagramProfileUrl(`https://www.instagram.com/${u.username}/`),a.candidateMetadata.url);
    a.candidateMetadata.directExternalUrls=[...new Set([u.external_url,...(u.bio_links??[]).map(b=>b.url)].filter(x=>{
      try{const v=new URL(x);return v.protocol==='https:'&&!v.username&&!v.password&&!v.port;}catch{return false;}
    }))];return a;
  }
  for(const id of ['207595','226788','35092']){
    const a=await load(id),proof=await archive(`${research}/direct-html-links-${id}.json`);
    assert.ok(proof.links.some(u=>instagramProfileUrl(u)===a.candidateMetadata.url));
    assert.ok(proof.links.some(u=>referenceUrl(u,'spotify')===a.reference.url));
    positiveProofs.set(id,{kind:'official_site_exact_instagram_and_spotify_links',sourceUrl:proof.url,
      checkedAt:proof.at,bodySha256:proof.bodySha256,independentOfVerifier:true});
    targets.set(id,a);pool.set(id,a);
  }
  const labels=await archive('scripts/fixtures/instagram-known-answer-labels.json');
  const manifest=await archive(`${pilot}/manifest.json`);
  const rowsText=await fs.readFile(`${pilot}/live-updated-remaining-989/results.jsonl`,'utf8');
  sources.push({file:`${pilot}/live-updated-remaining-989/results.jsonl`,sha256:hash(rowsText)});
  const rows=rowsText.trim().split('\n').map(JSON.parse),rawPilotNames=await fs.readdir(`${pilot}/live-updated-remaining-989/responses`);
  for(const id of ['302463','281761']){
    const label=labels.labels.find(l=>l.profileId===id&&l.expectedArtistOwned);
    const r=rows.find(r=>r.profileId===id),p=(r.partialEvidence??r.rawResult).profiles.find(p=>instagramProfileUrl(p.url)===label.url);
    const rawMeta=structuredClone(p.identityComparison.candidate);
    let matched;
    for(const n of rawPilotNames.filter(n=>n.startsWith(`${id}-`)&&n.includes('scrapecreators_candidate'))){
      const file=`${pilot}/live-updated-remaining-989/responses/${n}`,packet=await read(file);
      const u=packet.data?.data?.user??packet.data?.user;
      if(packet.status===200&&u&&instagramProfileUrl(`https://www.instagram.com/${u.username}/`)===label.url){
        await archive(file);matched=u;break;
      }
    }
    assert.ok(matched,'Missing original response-bound Instagram metadata.');
    rawMeta.directExternalUrls=[...new Set([matched.external_url,...(matched.bio_links??[]).map(b=>b.url)].filter(x=>{
      try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port;}catch{return false;}
    }))];
    const ref=p.identityComparison.reference,a={profile_id:id,artist:manifest.artists.find(a=>a.profile_id===id).artist,
      reference:{platform:ref.platform,url:ref.url},referenceMetadata:ref,candidateMetadata:rawMeta};
    targets.set(id,a);pool.set(id,a);
    positiveProofs.set(id,{kind:'user_confirmed_regression',provenance:label.provenance,independentlyRechecked:false});
  }
  const core=await archive('generated-artifacts/instagram-known-answer-benchmark-2026-11-09/requests/regression-frankelly-wrong.json');
  const wrong=core.request.state.candidates[1].candidate;
  assert.equal(wrong.url,labels.labels.find(l=>l.expectedArtistOwned===false).url);
  pool.set('wrong-bello',{candidateMetadata:wrong});
  const associated=await archive('generated-artifacts/instagram-known-answer-benchmark-2026-11-09/requests/regression-frankelly-associated.json');
  pool.set('brand',{candidateMetadata:associated.request.state.candidates[1].candidate});
  const brandProof=await archive(`${research}/direct-html-links-302463.json`);
  assert.match(brandProof.title,/cymbals/i);
  assert.ok(brandProof.links.some(u=>instagramProfileUrl(u)==='https://www.instagram.com/goldenlegendscymbals/'));
  const festival=await archive('generated-artifacts/instagram-known-answer-benchmark-2026-11-09/requests/regression-gula-festival.json');
  pool.set('festival',{candidateMetadata:festival.request.state.candidates[0].candidate});
  const festivalProof=await archive(`${research}/site-249317.json`);
  assert.match(festivalProof.markdown,/Gula Gula Festival/);
  assert.match(festivalProof.markdown,/https:\/\/www\.instagram\.com\/gulagulafestival/);
  const fan=await load('283662');
  assert.match(fan.candidateMetadata.bio,/Fanpage|Fanclub/i);pool.set('fan',fan);
  const relatedProofs={
    brand:{kind:'explicit_related_entity',sourceUrl:brandProof.url,role:'cymbal manufacturer',bodySha256:brandProof.bodySha256},
    festival:{kind:'explicit_related_entity',sourceUrl:festivalProof.url,role:'festival event promoter'},
    fan:{kind:'explicit_related_entity',source:'response-bound saved Instagram biography',role:'explicit fan page for another artist'},
    'wrong-bello':{kind:'user_confirmed_negative',provenance:labels.labels.find(l=>!l.expectedArtistOwned).provenance},
  };
  const groups=[
    ['302463',['302463','wrong-bello','brand','festival']],
    ['281761',['281761','brand','fan','226788']],
    ['207595',['207595','fan','35092','brand']],
    ['226788',['226788','207595','festival','302463']],
    ['35092',['35092','226788','fan','281761']],
  ];
  const examples=[],requests=[];
  for(const[id,keys]of groups){
    const target=targets.get(id);
    for(let j=0;j<4;j+=2){
      const pair=keys.slice(j,j+2).map(key=>pool.get(key));assert.ok(pair.every(Boolean));
      const raw=jevRequest({artist:target.artist,catalogReference:target.reference,profiles:pair.map(c=>correctedProfile(target,c))});
      pair.forEach((p,i)=>{if(p.candidateMetadata.searchEvidence)raw.state.candidates[i].candidate.searchEvidence=p.candidateMetadata.searchEvidence;});
      const baseline=sourceFactsOnly(raw);
      const pairLabels=pair.map((p,i)=>{
        const key=keys[j+i],positive=key===id;
        const proof=positive?positiveProofs.get(id):relatedProofs[key]??{
          kind:'different_documented_artist',actualArtist:targets.get(key).artist,
          actualMusicReference:targets.get(key).reference.url,ownerEvidence:positiveProofs.get(key)};
        if(!positive&&targets.has(key))assert.notEqual(target.reference.url,targets.get(key).reference.url);
        const comparison=correctedProfile(target,p).identityComparison;
        const e={id:`${id}:${p.candidateMetadata.url}`,profileId:id,artist:target.artist,url:p.candidateMetadata.url,
          expectedArtistOwned:positive,labelKind:proof.kind,labelEvidence:proof,
          savedExactLinkEligible:comparison.status==='likely',
          evidenceQuality:p.candidateMetadata.searchEvidence?'saved_search_snippet':'saved_profile_metadata'};
        examples.push(e);return e;
      });
      for(const variant of ['baseline',OWNERSHIP_RUBRIC]){
        const body=variant==='baseline'?baseline:withOwnershipRubric(baseline);
        assert.deepEqual(body.state,baseline.state);
        assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000,`Over limit: ${id}/${j}/${variant}`);
        requests.push({id:`${id}-${j/2}-${variant}`,profileId:id,variant,body,inputSha256:hash(JSON.stringify(body)),examples:pairLabels});
      }
    }
  }
  assert.equal(examples.length,20);assert.equal(new Set(examples.map(e=>e.id)).size,20);assert.equal(requests.length,20);
  const previous=await archive(`${research}/summary.json`);
  return {sources,examples,requests,previous};
}

async function main(){
  const p=await prepare();
  if(!process.argv.includes('--run-approved-check')){
    console.log(JSON.stringify({examples:p.examples.length,positive:p.examples.filter(e=>e.expectedArtistOwned).length,
      negative:p.examples.filter(e=>!e.expectedArtistOwned).length,requests:p.requests.length,maxNewReservationUsd:0.40,
      requestsBytes:p.requests.map(r=>({id:r.id,bytes:Buffer.byteLength(JSON.stringify(r.body))}))},null,2));return;
  }
  await fs.mkdir(output,{recursive:false});await fs.mkdir(`${output}/responses`);
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:40,
    priorReservedCents:Math.round(p.previous.cumulativeConservativeReservationUsd*100),
    runId:'instagram-20-answer-check-2026-11-09',
    source:'User approved assembling 20 known-answer examples and comparing current and revised verification rules. Overall turn cap $0.50 including $0.10 reference research.',
    noImports:true},sources:p.sources,examples:p.examples,
    design:{artistAccountPairs:20,distinctTargetArtists:5,correctExamples:5,incorrectExamples:15,
      sourceMetadataHistorical:true,officialSiteLabelsHeldOutOfInputs:true,evaluatorLabelsNotSent:true,
      selection:'Development regression/convenience sample; shared owners and controls, not independent population samples.',
      noThresholdCalibration:true,defaultPolicyChanged:false},
    artists:[...new Set(p.requests.map(r=>r.profileId))].map(profile_id=>({profile_id,source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:20,jev_requests_per_artist:4,paid_http_requests_total:20,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,global_concurrent_provider_requests:1,
      per_request_timeout_seconds:20,jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:10}};
  await save(`${output}/approved-scope.json`,manifest);
  await save(`${output}/example-labels.json`,p.examples);
  for(const r of p.requests)await save(`${output}/${r.id}-request.json`,{request:r.body,inputSha256:r.inputSha256});
  const transport=frozenJevTransport({responseDir:`${output}/responses`,apiKey:process.env.OPENROUTER_API_KEY});
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[],deadlineAt=Date.now()+600000;
  try{
    for(const r of p.requests){
      const out=await budget.request({profileId:r.profileId,kind:'jev',key:r.id,
        payload:{body:r.body,inputSha256:r.inputSha256},deadlineAt});
      const row={id:r.id,variant:r.variant,inputSha256:r.inputSha256,model:out.model,reportedCostUsd:out.cost,
        decisions:out.answers.map((d,i)=>({...r.examples[i],...d,modelAccepted:accepted(d),
          savedEvidenceAndVerifierGatePassed:r.examples[i].savedExactLinkEligible&&accepted(d)}))};
      results.push(row);await save(`${output}/${r.id}-result.json`,row);
      console.log(JSON.stringify({id:r.id,decisions:row.decisions.map(d=>({url:d.url,expected:d.expectedArtistOwned,
        score:d.sameIdentityProbability,verdict:d.verdict,accepted:d.modelAccepted}))}));
      if(out.model!=='typesafe/jev-1.13-20260917')throw Error('Resolved model changed; stop comparison.');
      if(row.decisions.some(d=>!d.expectedArtistOwned&&d.modelAccepted))throw Error('Known wrong account accepted; stop remaining calls.');
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{
    await budget.close();const b=budget.snapshot();
    await save(`${output}/summary.json`,{results,byVariant:summarizeAnswerChecks(results),budget:b,
      completed:results.length===20,cumulativeConservativeReservationUsd:b.sharedBudget.reservedSpendCents/100,
      remainingOriginalBudgetUsd:(b.sharedBudget.maxSpendCents-b.sharedBudget.reservedSpendCents)/100,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),newSearches:0,newMetadataCalls:0,
      newPublicRequests:0,newDatabaseQueries:0,claims:0,databaseWrites:0,coordinationWrites:true,defaultPolicyChanged:false,
      fullRerunStarted:false,populationAccuracyClaim:false});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
