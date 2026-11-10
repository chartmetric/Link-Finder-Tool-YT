import {claimFixedPilotRun} from './instagram-pilot-shared-budget.mjs';
// Historical saved-evidence diagnostic only. Never creates claims or live links.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {MODEL,requestFor,factsOnlyDecision,parseDecision,checkPrice} from './instagram-alternate-verifier.mjs';
import {correctedProfile} from './instagram-provenance-diagnostic.mjs';
import {jevRequest} from './instagram-pilot-live-transport.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';

const benchmark='generated-artifacts/instagram-verification-benchmark-2026-11-06';
const pilot='generated-artifacts/musician-instagram-verification-pilot-2026-11-05';
const destination='generated-artifacts/instagram-broader-facts-validation-2026-11-06';
const priorOutput='generated-artifacts/instagram-facts-only-verifier-2026-11-06';
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});
const hash=x=>createHash('sha256').update(x).digest('hex');
const reserveCents=6,maxCalls=23;

export function buildCase(target,candidates,labels,key) {
  assert.equal(candidates.length,2);
  assert.equal(labels.length,2);
  assert.ok(target.reference?.url,'Missing supported catalog reference');
  const profiles=candidates.map(a=>correctedProfile(target,a));
  const original=jevRequest({artist:target.artist,catalogReference:target.reference,profiles});
  assert.ok(original.state.candidates.every(c=>c.reference.url===target.reference.url));
  const clean=factsOnlyDecision(original);
  const body=requestFor(clean);
  // Evaluator labels never reach model input.
  return {key,profileId:target.profile_id,artist:target.artist,tier:target.tier,
    labels,body,requestSha256:hash(JSON.stringify(body)),
    expectedUrls:clean.state.candidates.map(c=>c.url),
    eligible:original.state.candidates.map((c,i)=>
      profiles[i].identityComparison.status==='likely'&&
      (c.observedExactCatalogLinks.length>0||c.candidate.musicLinkPath?.status==='exact_catalog_music_identity'))};
}

export function evaluateCase(c,decisions) {
  assert.equal(decisions.length,c.labels.length);
  return decisions.map((d,i)=>({...d,label:c.labels[i],exactLinkEligible:c.eligible[i],
    diagnosticThresholdPassed:c.eligible[i]&&d.verdict==='verified'&&d.same_identity_score>=0.9,
    productionApproved:false}));
}

async function restoreDirect(metadata,files) {
  const match=files.find(f=>f.user&&instagramProfileUrl(`https://www.instagram.com/${f.user.username}/`)===metadata.url);
  assert.ok(match,`Missing raw Instagram packet for ${metadata.url}`);
  const u=match.user;
  const direct=[u.external_url,...(u.bio_links??[]).map(b=>b.url)].filter(url=>{
    try {const v=new URL(url);return v.protocol==='https:'&&!v.username&&!v.password&&!v.port;}catch{return false;}
  });
  metadata.directExternalUrls=[...new Set(direct)];
  return {file:match.file,sha256:match.sha256};
}

async function rawFiles(dir) {
  const rows=[];
  for(const n of (await fs.readdir(dir)).filter(n=>n.includes('scrapecreators_candidate'))) {
    const file=`${dir}/${n}`,text=await fs.readFile(file,'utf8'),r=JSON.parse(text);
    if(r.status===200) rows.push({file,sha256:hash(text),user:r.data.data?.user??r.data.user});
  }
  return rows;
}

async function prepare() {
  const cases=[],sources=[];
  const raw=await rawFiles(`${benchmark}/responses`);
  const artists=[];
  for(const n of (await fs.readdir(benchmark)).filter(n=>n.endsWith('-metadata.json')).sort()) {
    const file=`${benchmark}/${n}`,text=await fs.readFile(file,'utf8'),a=JSON.parse(text);
    sources.push({file,sha256:hash(text)},await restoreDirect(a.candidateMetadata,raw));
    artists.push(a);
  }
  assert.equal(artists.length,18);
  for(let i=0;i<artists.length;i++) {
    const target=artists[i],control=artists[(i+1)%artists.length];
    assert.notEqual(target.reference.url,control.reference.url);
    cases.push(buildCase(target,[target,control],
      [target.bucket==='catalog_benchmark'?'provisional_catalog_positive':'unadjudicated_saved_candidate',
        'rotated_distinct_catalog_control'],`benchmark-${target.profile_id}`));
  }
  const resultsFile=`${pilot}/live-updated-remaining-989/results.jsonl`;
  const resultsText=await fs.readFile(resultsFile,'utf8');
  sources.push({file:resultsFile,sha256:hash(resultsText)});
  const results=resultsText.trim().split('\n').map(JSON.parse);
  const pilotRaw=await rawFiles(`${pilot}/live-updated-remaining-989/responses`);
  async function challenge(id) {
    const row=results.find(r=>r.profileId===id);
    const evidence=row.partialEvidence??row.rawResult;
    const profiles=evidence.profiles.filter(p=>p.identityComparison?.candidate);
    assert.ok(profiles.length>=2);
    const r=profiles[0].identityComparison.reference;
    const target={profile_id:id,artist:r.displayName,reference:{platform:r.platform,url:r.url},referenceMetadata:r};
    const candidates=[];
    for(const p of profiles) {
      const metadata=structuredClone(p.identityComparison.candidate);
      sources.push(await restoreDirect(metadata,pilotRaw));
      candidates.push({candidateMetadata:metadata});
    }
    return {target,candidates};
  }
  const frank=await challenge('302463'),gula=await challenge('249317');
  const shenge=await challenge('281761');
  const ginRow=results.find(r=>r.profileId==='209186');
  const ginProfiles=ginRow.rawResult.profiles.filter(p=>p.identityComparison?.candidate);
  const ginRef=ginProfiles[0].identityComparison.reference;
  const gin={profile_id:'209186',artist:'Gin_Beatz',reference:{platform:ginRef.platform,url:ginRef.url},referenceMetadata:ginRef};
  const ginCandidate={candidateMetadata:structuredClone(ginProfiles[0].identityComparison.candidate)};
  sources.push(await restoreDirect(ginCandidate.candidateMetadata,pilotRaw));
  const snapshotFile=`${pilot}/source-snapshots.json`;
  const snapshotText=await fs.readFile(snapshotFile,'utf8');
  sources.push({file:snapshotFile,sha256:hash(snapshotText)});
  const snapshots=JSON.parse(snapshotText);
  const saved=(id,url)=>JSON.parse(snapshots.find(a=>a.profile_id===id).result_json).profiles
    .find(p=>instagramProfileUrl(p.url)===url);
  function snippetCandidate(id,url) {
    const p=saved(id,url);
    assert.ok(p,'Missing saved search evidence');
    // Search snippets are not scraped biography. Keep explicit source typing.
    return {candidateMetadata:{platform:'instagram',url,externalUrls:[]},
      searchEvidence:{sourceType:'saved_serper_snippet',sourceUrl:p.url,title:p.title,snippet:p.snippet}};
  }
  function withSnippet(c,index,source) {
    c.body.messages[1].content=JSON.stringify((()=>{
      const content=JSON.parse(c.body.messages[1].content);
      content.state.candidates[index].candidate.searchEvidence=source.searchEvidence;
      return content;
    })());
    c.requestSha256=hash(JSON.stringify(c.body));
    return c;
  }
  const wrong=snippetCandidate('302463','https://www.instagram.com/belloo_official/');
  cases.push(withSnippet(buildCase(frank.target,[frank.candidates[0],wrong],
    ['user_confirmed_positive','user_reported_wrong_person'],'regression-frankelly-wrong'),1,wrong));
  cases.push(buildCase(frank.target,[frank.candidates[0],frank.candidates[1]],
    ['user_confirmed_positive','associated_cymbal_brand'],'regression-frankelly-associated'));
  const festival=snippetCandidate('249317','https://www.instagram.com/gulagulafestival/');
  cases.push(withSnippet(buildCase(gula.target,[festival,gula.candidates[0]],
    ['user_reported_wrong_festival','unadjudicated_saved_candidate'],'regression-gula-festival'),0,festival));
  cases.push(buildCase(shenge.target,[shenge.candidates[0],shenge.candidates[1]],
    ['user_confirmed_positive','associated_venue'],'regression-shenge'));
  cases.push(buildCase(gin,[ginCandidate,artists[0]],
    ['unadjudicated_saved_candidate','rotated_distinct_catalog_control'],'regression-gin'));
  const manifest=await read(`${pilot}/manifest.json`);
  const rooby=manifest.artists.find(a=>a.profile_id==='3861995');
  assert.equal(rooby.reference_preflight.readiness,'no_active_supported_reference');
  assert.equal(rooby.reference_preflight.references.length,0);
  const blocked=[{profileId:rooby.profile_id,artist:rooby.artist,
    candidateUrl:'https://www.instagram.com/elgremioink/',
    candidateSource:'User-reported label association; no fresh metadata requested',
    reason:'No usable catalog music reference. Held before model dispatch.',
    productionApproved:false,diagnosticThresholdPassed:false,modelTested:false}];
  assert.equal(cases.length,maxCalls);
  assert.equal(new Set(cases.map(c=>c.key)).size,cases.length);
  return {cases,blocked,sources};
}

async function main() {
  const prepared=await prepare();
  const prior=await read(`${priorOutput}/summary.json`);
  const priorCents=Math.round(prior.cumulativeConservativeReservationUsd*100);
  assert.equal(priorCents,179);
  assert.ok(priorCents+maxCalls*reserveCents<=1000);
  if(!process.argv.includes('--run-approved-test')) {
    console.log(JSON.stringify({calls:prepared.cases.length,maxReservationUsd:1.38,
      caseBytes:prepared.cases.map(c=>({key:c.key,bytes:Buffer.byteLength(JSON.stringify(c.body))})),
      blocked:prepared.blocked},null,2));return;
  }
  if(!process.env.OPENROUTER_API_KEY) throw Error('Missing OPENROUTER_API_KEY');
  const catalog=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(20000)});
  assert.ok(catalog.ok,'Model catalogue unavailable');
  const model=(await catalog.json()).data.find(m=>m.id===MODEL);
  for(const c of prepared.cases) checkPrice(model,Buffer.byteLength(JSON.stringify(c.body)));
  await fs.mkdir(destination,{recursive:false});
  await fs.mkdir(`${destination}/responses`);
  await save(`${destination}/approved-scope.json`,{authorization:'User approved broader saved-evidence validation including wrong-person, label and festival regressions.',
    model,maxCalls,maxNewReservedUsd:1.38,priorReservedUsd:1.79,
    noNewSearches:true,noNewMetadata:true,noClaims:true,noDatabaseWrites:true,
    automaticRetries:0,concurrency:1,spacingMs:1000,
    limitation:'Historical convenience sample, provisional catalog positives; no population accuracy or JEV equivalence claim.',
    cases:prepared.cases.map(({body,...c})=>c),sources:prepared.sources,blocked:prepared.blocked});
  const journal=await fs.open(`${destination}/admissions.jsonl`,'wx');
  let shared;
  const append=async r=>{await journal.write(JSON.stringify({...r,at:new Date().toISOString()})+'\n');await journal.sync();};
  const results=[];let admitted=0;
  try {
    shared=await claimFixedPilotRun({runId:path.basename(destination),priorReservedCents:priorCents,maxSpendCents:maxCalls*reserveCents});
    for(const c of prepared.cases) {
      const body=JSON.stringify(c.body);
      assert.equal(hash(body),c.requestSha256);
      assert.ok(admitted<maxCalls);
      checkPrice(model,Buffer.byteLength(body));
      await save(`${destination}/${c.key}-request.json`,{request:c.body,requestSha256:c.requestSha256});
      await shared.reserve({key:c.key,cents:reserveCents,profileId:c.profileId,kind:'alternate_verifier'});
      await append({phase:'admitted',key:c.key,reserveCents,requestSha256:c.requestSha256});
      admitted++;
      try {
        const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),
          headers:{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`,'Content-Type':'application/json'},body});
        const text=await response.text();
        if(Buffer.byteLength(text)>2000000) throw Error('Oversized response; stop');
        const data=JSON.parse(text);
        await save(`${destination}/responses/${c.key}.json`,{status:response.status,data});
        if(!response.ok||data.error) throw Error(`Verifier failed HTTP ${response.status}; no retry`);
        const cost=data.usage?.cost;
        if(!Number.isFinite(cost)||cost<0||cost>reserveCents/100) throw Error('Missing/excessive charge; no retry');
        const candidates=evaluateCase(c,parseDecision(data,c.expectedUrls));
        const result={key:c.key,artist:c.artist,profileId:c.profileId,tier:c.tier,
          resolvedModel:data.model,reportedCostUsd:cost,candidates};
        await save(`${destination}/${c.key}-result.json`,result);
        await append({phase:'returned',key:c.key,reportedCostUsd:cost});
        results.push(result);
        // Never print provider free text: it can repeat private contact data.
        console.log(JSON.stringify({...result,candidates:candidates.map(({reason,...d})=>d)}));
        if(candidates.some(d=>['user_reported_wrong_person','user_reported_wrong_festival','associated_cymbal_brand','associated_venue']
          .includes(d.label)&&(d.diagnosticThresholdPassed||(d.verdict==='verified'&&d.same_identity_score>=0.9)))) {
          throw Error('Known related/wrong entity promoted; stop further paid checks');
        }
      }catch(error){await append({phase:'stopped_no_retry',key:c.key,message:error.message});throw error;}
      await new Promise(r=>setTimeout(r,1000));
    }
  }finally{
    await journal.close();
    let sharedBudget;
    try { sharedBudget=await shared?.snapshot(); } finally { await shared?.close(); }
    await save(`${destination}/summary.json`,{completed:results.length===maxCalls,admitted,results,
      blocked:prepared.blocked,conservativeNewReservationUsd:admitted*reserveCents/100,
      sharedBudget,coordinationWrites:true,
      cumulativeConservativeReservationUsd:sharedBudget?sharedBudget.reservedSpendCents/100:null,
      remainingOriginalBudgetUsd:sharedBudget?(sharedBudget.maxSpendCents-sharedBudget.reservedSpendCents)/100:null,
      reportedCostUsd:results.reduce((s,r)=>s+r.reportedCostUsd,0),
      newSearches:0,newMetadataCalls:0,claims:0,databaseWrites:0,fullRerunStarted:false});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();
