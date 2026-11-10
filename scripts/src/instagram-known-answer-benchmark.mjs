// Preparation and scoring only. No HTTP client, secrets, provider or DB adapter.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const historical='generated-artifacts/instagram-broader-facts-validation-2026-11-06';
const album='generated-artifacts/instagram-catalog-album-verifier-test-2026-11-09';
const destination='generated-artifacts/instagram-known-answer-benchmark-2026-11-09';
const labelsFile='scripts/fixtures/instagram-known-answer-labels.json';
const hash=x=>createHash('sha256').update(x).digest('hex');
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});

export function validateBenchmarkRequest(body) {
  assert.ok(body.model&&body.state?.knownProfileUrl);
  assert.ok(Array.isArray(body.state.candidates)&&body.state.candidates.length===2);
  assert.ok(body.state.candidates.every(c=>c.reference?.url===body.state.knownProfileUrl));
  assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000,'Request exceeds the unchanged input ceiling.');
  for(const [i,c] of body.state.candidates.entries()) {
    const u=new URL(c.url);
    assert.equal(u.origin,'https://www.instagram.com');
    assert.match(u.pathname,/^\/[a-z0-9._]+\/$/i);
    assert.ok(body.questions[`candidate_${i}_same_identity`]);
    assert.ok(body.questions[`candidate_${i}_verdict`]);
  }
}

export function scoreKnownAnswers(suite,responses=[]) {
  const mapped=new Map();
  for(const r of responses) {
    assert.ok(suite.requests.some(q=>q.id===r.requestId),'Unknown benchmark request.');
    assert.ok(!mapped.has(r.requestId),'Duplicate benchmark result.');
    const request=suite.requests.find(q=>q.id===r.requestId);
    assert.equal(r.inputSha256,request.inputSha256,'Result is not bound to the frozen request.');
    assert.equal(r.decisions.length,request.candidates.length);
    r.decisions.forEach((d,i)=>{
      assert.equal(d.url,request.candidates[i].url);
      assert.ok(Number.isFinite(d.sameIdentityProbability)&&d.sameIdentityProbability>=0&&d.sameIdentityProbability<=1);
      assert.ok(['verified','likely','uncertain','mismatch'].includes(d.verdict));
    });
    mapped.set(r.requestId,r);
  }
  const rows=suite.requests.flatMap(q=>q.candidates.map((c,i)=>{
    const decision=mapped.get(q.id)?.decisions[i];
    const modelAccepted=decision?decision.verdict==='verified'&&decision.sameIdentityProbability>=0.9:null;
    return {...c,requestId:q.id,modelAccepted,
      modelHold:decision?!modelAccepted:null,
      exactLinkEvidenceHold:!c.savedExactLinkEligible,
      savedEvidenceAndVerifierGatePassed:decision?c.savedExactLinkEligible&&modelAccepted:null,
      outcome:!decision?'not_tested':c.category!=='known_answer'?'unscored'
        :c.expectedArtistOwned?(modelAccepted?'recognized_known_positive':'held_known_positive')
          :(modelAccepted?'wrongly_accepted_known_negative':'held_known_negative')};
  }));
  const known=rows.filter(r=>r.category==='known_answer'),tested=known.filter(r=>r.modelAccepted!==null);
  return {rows,knownAnswers:known.length,testedKnownAnswers:tested.length,
    heldKnownPositives:tested.filter(r=>r.outcome==='held_known_positive').length,
    modelMissWithExactLink:tested.filter(r=>r.expectedArtistOwned&&r.modelHold&&!r.exactLinkEvidenceHold).length,
    modelAndEvidenceHeldKnownPositives:tested.filter(r=>r.expectedArtistOwned&&r.modelHold&&r.exactLinkEvidenceHold).length,
    evidenceOnlyHeldKnownPositives:tested.filter(r=>r.expectedArtistOwned&&!r.modelHold&&r.exactLinkEvidenceHold).length,
    exactLinkHeldKnownPositives:tested.filter(r=>r.expectedArtistOwned&&r.exactLinkEvidenceHold).length,
    wronglyAcceptedKnownNegatives:tested.filter(r=>r.outcome==='wrongly_accepted_known_negative').length,
    byStratum:Object.fromEntries([...new Set(known.map(r=>r.stratum??'legacy_user_confirmed'))].map(stratum=>{
      const all=known.filter(r=>(r.stratum??'legacy_user_confirmed')===stratum);
      const seen=all.filter(r=>r.modelAccepted!==null);
      return [stratum,{cases:all.length,tested:seen.length,
        positives:seen.filter(r=>r.expectedArtistOwned).length,
        modelHeldPositives:seen.filter(r=>r.expectedArtistOwned&&!r.modelAccepted).length,
        negatives:seen.filter(r=>!r.expectedArtistOwned).length,
        modelAcceptedNegatives:seen.filter(r=>!r.expectedArtistOwned&&r.modelAccepted).length}];
    })),
    populationAccuracyClaim:false,thresholdCalibrated:false,productionApproved:false};
}

export async function prepareKnownAnswerBenchmark() {
  const sources=[];
  async function archived(file) {
    const text=await fs.readFile(file,'utf8');sources.push({file,sha256:hash(text)});return JSON.parse(text);
  }
  const labels=await archived(labelsFile);
  const scope=await archived(`${historical}/approved-scope.json`);
  const modelSource=await archived(`${album}/208216-request.json`);
  const requests=[],goldSeen=new Set();
  const specs=[
    ['regression-frankelly-wrong','core','302463'],
    ['regression-shenge','core','281761'],
    ['regression-frankelly-associated','related_entity_challenge','302463'],
    ['regression-gula-festival','related_entity_challenge','249317'],
    ['regression-gin','unadjudicated','209186'],
  ];
  const roles=new Map([
    ['https://www.instagram.com/goldenlegendscymbals/','associated cymbal brand'],
    ['https://www.instagram.com/musas_shisanyama/','associated venue'],
    ['https://www.instagram.com/gulagulafestival/','festival'],
  ]);
  for(const [id,group,profileId] of specs) {
    const packet=await archived(`${historical}/${id}-request.json`);
    assert.equal(packet.requestSha256,hash(JSON.stringify(packet.request)));
    const content=JSON.parse(packet.request.messages[1].content);
    const body={model:modelSource.request.model,state:content.state,questions:content.questions};
    validateBenchmarkRequest(body);
    const saved=scope.cases.find(c=>c.key===id);
    assert.ok(saved);assert.deepEqual(saved.expectedUrls,body.state.candidates.map(c=>c.url));
    const candidates=body.state.candidates.map((c,i)=>{
      const truth=labels.labels.find(l=>l.profileId===profileId&&l.url===c.url);
      const category=group==='core'&&truth?'known_answer'
        :roles.has(c.url)?'related_entity_challenge':'unadjudicated';
      if(category==='known_answer') {
        const k=`${profileId}:${c.url}`;assert.ok(!goldSeen.has(k));goldSeen.add(k);
      }
      return {profileId,url:c.url,category,
        expectedArtistOwned:category==='known_answer'?truth.expectedArtistOwned:null,
        labelProvenance:category==='known_answer'?truth.provenance:null,
        observedRelatedRole:roles.get(c.url)??null,
        evidenceQuality:c.candidate.searchEvidence?'saved_search_snippet_only':'saved_profile_metadata',
        savedExactLinkEligible:saved.eligible[i],
        note:truth&&category!=='known_answer'?'Repeated known positive retained as an unscored comparison; do not inflate totals.':null};
    });
    requests.push({id,group,profileId,body,inputSha256:hash(JSON.stringify(body)),candidates});
  }
  assert.equal(goldSeen.size,labels.labels.length);
  for(const [profileId,artist] of [['208216','Billylildove'],['35092','The Format']]) {
    const p=await archived(`${album}/${profileId}-request.json`);
    assert.equal(p.inputSha256,hash(JSON.stringify(p.request)));validateBenchmarkRequest(p.request);
    requests.push({id:`unadjudicated-album-${profileId}`,group:'unadjudicated',profileId,artist,
      body:p.request,inputSha256:p.inputSha256,candidates:p.request.state.candidates.map((c,i)=>({
        profileId,url:c.url,category:'unadjudicated',expectedArtistOwned:null,
        savedExactLinkEligible:i===0,evidenceQuality:'saved_profile_and_catalog_metadata'}))});
  }
  const prior=await archived('generated-artifacts/instagram-jev-label-ablation-2026-11-09/summary.json');
  const suite={run_allowed:false,preparationOnly:true,sourceEvidenceIsHistorical:true,
    labelStandard:'User-confirmed corrections, not independently rechecked current account ownership.',
    threshold:{verdict:'verified',minimumIdentityProbability:0.9,unchanged:true},
    limits:{paidCallsAllowedNow:0,newSearchesAllowedNow:0,importsAllowedNow:0,automaticRetries:0},
    futureCoreTestProposal:{requiresSeparateApproval:true,requests:2,maxReservationUsd:0.04,
      maxInputBytesPerRequest:6000,scope:'Three user-confirmed answers plus one unscored venue challenge.'},
    blocked:[{profileId:'3861995',artist:'Rooby Jeantal',url:'https://www.instagram.com/elgremioink/',
      reason:'No usable catalog music reference; label association is not an adjudicated artist-owned identity.',
      modelReady:false,scored:false}],
    absenceAssertions:labels.absenceAssertions,sources,requests:requests.map(({body,...r})=>r),
    budget:{newReservedUsd:0,cumulativeConservativeReservationUsd:prior.cumulativeConservativeReservationUsd,
      remainingOriginalBudgetUsd:prior.remainingOriginalBudgetUsd},
    limitation:'A small convenience regression set. Related entities, catalog-linked and unadjudicated accounts are not gold answers. No population precision, recall, confidence calibration or full-rerun readiness claim.'};
  const initial=scoreKnownAnswers(suite);
  await fs.mkdir(destination,{recursive:false});
  await fs.mkdir(`${destination}/requests`);
  await save(`${destination}/benchmark.json`,suite);
  for(const r of requests) await save(`${destination}/requests/${r.id}.json`,{request:r.body,inputSha256:r.inputSha256});
  await save(`${destination}/offline-scorecard.json`,initial);
  console.log(JSON.stringify({prepared:true,knownAnswers:initial.knownAnswers,
    knownPositive:initial.rows.filter(r=>r.category==='known_answer'&&r.expectedArtistOwned).length,
    knownNegative:initial.rows.filter(r=>r.category==='known_answer'&&!r.expectedArtistOwned).length,
    relatedEntityChallenges:initial.rows.filter(r=>r.category==='related_entity_challenge').length,
    unadjudicated:initial.rows.filter(r=>r.category==='unadjudicated').length,
    testedKnownAnswers:initial.testedKnownAnswers,paidCalls:0,imports:0,
    requests:requests.map(r=>({id:r.id,group:r.group,bytes:Buffer.byteLength(JSON.stringify(r.body))})),
    remainingBudgetUsd:suite.budget.remainingOriginalBudgetUsd},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--independent')) {
    const {prepareOwnershipBenchmark}=await import('./instagram-ownership-benchmark.mjs');
    const flag=process.argv.find(a=>a.startsWith('--output='));
    const asOf=process.argv.find(a=>a.startsWith('--as-of='));
    const review=process.argv.find(a=>a.startsWith('--review-file='));
    await prepareOwnershipBenchmark({destination:flag?.slice('--output='.length),
      asOf:asOf?.slice('--as-of='.length),reviewFile:review?.slice('--review-file='.length)});
  } else await prepareKnownAnswerBenchmark();
}
