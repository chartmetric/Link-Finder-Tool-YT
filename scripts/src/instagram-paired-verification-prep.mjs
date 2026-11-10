// PREPARATION ONLY: local frozen inputs -> immutable requests. No dispatcher.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {catalogReferences,assessInstagramCandidates,CORROBORATED_POLICY} from './musician-instagram-matching.mjs';
import {selectSavedCases,summarizeSavedControls,rerunCodeFingerprint,revisedProfile} from './instagram-saved-fix-rerun.mjs';
import {fitArtistContext,jevRequest} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC} from './instagram-ownership-rubric.mjs';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
import {pilotReservationsCents} from './instagram-pilot-budget.mjs';
import {ORIGINAL_PILOT_BUDGET_ID} from './instagram-pilot-shared-budget.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;
const json=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const write=(f,data)=>fs.writeFile(f,JSON.stringify(data,null,2),{flag:'wx'});
const sourceState = body => {
  const {verificationRules,evidenceRules,...evidence}=body.state;
  return evidence;
};
function forbidJudgments(value) {
  assertNoGradingInputs(value);
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
    if(['identityComparisonStatus','identityComparisonReasons','jevVerification'].includes(key))throw Error('Prior judgment leaked into request.');
    forbidJudgments(child);
  }
}

export function pairedRequests(target,original){
  const reference=catalogReferences(target.artist)[0];
  if(!reference)throw Error('No frozen catalog reference.');
  const profile=revisedProfile(original,target.artist);
  // For controls, compare the donor account against the target's real reference.
  profile.identityComparison.reference=structuredClone(target.profile.identityComparison.reference);
  if(profile.identityComparison.reference.url!==reference.url)throw Error('Target reference is not the frozen primary reference.');
  const requests=[];
  for(const variant of ['baseline','proposed']){
    const payload=fitArtistContext({artist:target.artist.artist,catalogReference:reference,
      profiles:[profile],artistContext:target.context,
      ...(variant==='proposed'?{ownershipRubric:CORROBORATED_RUBRIC}:{})},6000);
    // Use the same compact evidence serialization in both arms. Only application
    // question/rubric text may differ, never source evidence or omissions.
    const body=jevRequest({...payload,compactEvidence:true});
    const delivery=body.state.contextDelivery;
    if(delivery?.omittedItems||delivery?.omittedPostRecords)throw Error('Source context or matched posts would be omitted.');
    const text=JSON.stringify(body),bytes=Buffer.byteLength(text);
    if(bytes>6000)throw Error('Complete request exceeds 6000-byte cap.');
    forbidJudgments(body.state);
    requests.push({variant,body,sha256:hash(text),bytes,sourceEvidenceSha256:hash(JSON.stringify(sourceState(body)))});
  }
  assert.deepEqual(sourceState(requests[0].body),sourceState(requests[1].body),'Paired source evidence changed.');
  assert.equal(requests[0].body.model,requests[1].body.model);
  assert.notDeepEqual(requests[0].body.questions,requests[1].body.questions);
  return requests;
}

// Select by source-evidence route, never by an artist-specific answer list.
export function selectPairedTargets(cases){
  const supported=new Map(),held=new Map();
  for(const c of cases){
    const decision=assessInstagramCandidates({methodsUsed:[{method:'serper',status:'used'}],profiles:[c.profile]},c.artist,
      {policy:CORROBORATED_POLICY,mode:'offline',context:{profileId:String(c.artist.profile_id),metadata:c.context}}).candidates[0];
    const map=decision.status==='supported'?supported:held;
    const key=decision.status==='supported'?decision.route:decision.reason;
    if(!map.has(key))map.set(key,[]);
    map.get(key).push({...c,selectionStratum:key});
  }
  const complexity=c=>(c.profile.identityComparison.candidate.externalLinkEvidence?.pages??[])
    .reduce((n,p)=>n+(p.linkEvidence?.length??0),0);
  const representatives=map=>[...map].sort(([a],[b])=>compare(a,b)).map(([,items])=>
    items.sort((a,b)=>complexity(b)-complexity(a)||compare(String(a.artist.profile_id),String(b.artist.profile_id)))[0]);
  const positives=representatives(supported),uncertain=representatives(held);
  if(positives.length<3||uncertain.length<3)throw Error('Need three supported evidence routes and three held reasons; do not silently shrink coverage.');
  return [...positives.slice(0,3),...uncertain.slice(0,3)];
}

export async function preparePairedVerification({sourceDir,budgetFile,outputDir}){
  const inputs=[];
  const read=async f=>{
    const bytes=await fs.readFile(f);inputs.push({file:f,sha256:hash(bytes)});return JSON.parse(bytes);
  };
  const source=await read(path.join(sourceDir,'prepared-scope.json'));
  const budget=await read(budgetFile);
  if(budget.budgetId!==ORIGINAL_PILOT_BUDGET_ID||budget.maxSpendCents!==1000
    ||!Number.isSafeInteger(budget.reservedSpendCents)||budget.reservedSpendCents<0
    ||!Number.isFinite(Date.parse(budget.observedAt)))throw Error('A valid observed shared ceiling is required; no guessed checkpoint.');
  const candidates=[],models=new Set(),draftChecks=[];
  for(const c of source.cases){
    const packet=await read(path.join(sourceDir,'responses',`${c.artist.profile_id}-candidate.json`));
    if(packet.status!==200||String(packet.profileId)!==String(c.artist.profile_id)
      ||hash(JSON.stringify(packet.decisionRequest))!==packet.requestBodySha256
      ||packet.decisionRequest.state.artist!==c.artist.artist
      ||packet.decisionRequest.state.candidates[0].url!==c.profile.url)throw Error('Frozen historical response binding failed.');
    models.add(packet.data.model);
    const next=structuredClone(c);
    next.profile.identityComparison.reference=structuredClone(packet.decisionRequest.state.candidates[0].reference);
    next.profile.jevVerification={verdict:packet.data.answers.candidate_0_verdict.choice,
      sameIdentityProbability:packet.data.answers.candidate_0_same_identity.noul};
    try{
      const pair=pairedRequests(next,next.profile);
      draftChecks.push({profileId:String(c.artist.profile_id),artist:c.artist.artist,complete:true,
        baselineBytes:pair[0].bytes,proposedBytes:pair[1].bytes,omittedItems:0,omittedPosts:0});
      candidates.push(next);
    }catch(e){draftChecks.push({profileId:String(c.artist.profile_id),artist:c.artist.artist,complete:false,hold:e.message});}
  }
  if(models.size!==1||typeof [...models][0]!=='string')throw Error('Historical resolved model is mixed or unavailable.');
  const targets=selectPairedTargets(candidates);
  const pool=[];
  for(const input of source.inputs??[]){
    const manifestFile=path.join(input.directory,'approved-manifest.json'),resultsFile=path.join(input.directory,'results.jsonl');
    const manifestBytes=await fs.readFile(manifestFile),resultBytes=await fs.readFile(resultsFile);
    if(hash(manifestBytes)!==input.manifestSha256||hash(resultBytes)!==input.resultsSha256)throw Error('Frozen source archive changed.');
    inputs.push({file:manifestFile,sha256:hash(manifestBytes)},{file:resultsFile,sha256:hash(resultBytes)});
    const manifest=JSON.parse(manifestBytes),artists=new Map(manifest.artists.map(a=>[String(a.profile_id),a]));
    for(const record of resultBytes.toString('utf8').split('\n').filter(s=>s.trim()).map(s=>JSON.parse(s))){
      const artist=artists.get(String(record.profileId));
      if(!artist)throw Error('Unbound control donor.');
      for(const profile of (record.rawResult??record.partialEvidence)?.profiles??[]){
        if(!profile.identityComparison)continue;
        // A donor must fit with EVERY target's evidence, without deletion.
        try{for(const target of targets)pairedRequests(target,profile);}
        catch{continue;}
        pool.push({artist,profile,context:artist.metadata_context,priority:10000,archive:input.directory});
      }
    }
  }
  const cases=selectSavedCases([...targets.map((c,i)=>({...c,priority:i})),...pool],6);
  assert.deepEqual(cases.map(c=>String(c.artist.profile_id)),targets.map(c=>String(c.artist.profile_id)));
  const controls=summarizeSavedControls(cases);
  if(controls.distinctControlAccounts!==6||controls.reusedComparisons||controls.unassignedTargets)throw Error('Six distinct eligible saved controls are required; no reuse or collection fallback.');
  const requests=[];
  for(const [index,c] of cases.entries())for(const [kind,profile] of [['candidate',c.profile],['control',c.control.profile]]){
    for(const pair of pairedRequests(c,profile)){
      const key=`${String(index+1).padStart(2,'0')}-${kind}-${pair.variant}`;
      requests.push({...pair,key,kind,profileId:String(c.artist.profile_id),artist:c.artist.artist,
        accountUrl:profile.url,requestFile:`requests/${key}.json`});
    }
  }
  const maxSpendCents=requests.length*pilotReservationsCents.jev;
  if(requests.length!==24||maxSpendCents!==48||budget.reservedSpendCents+maxSpendCents>budget.maxSpendCents)throw Error('Paired scope exceeds unchanged shared ceiling.');
  const manifest={schema:'paired-artist-verification-preparation-v1',run_allowed:false,
    authorization:{approved:false,preparationOnly:true,maxSpendCents,priorReservedCents:budget.reservedSpendCents,
      budgetId:budget.budgetId,observationTime:budget.observedAt,executionApprovalRequired:true},
    expectedResolvedModel:[...models][0],proposedRubric:CORROBORATED_RUBRIC,researchPolicy:CORROBORATED_POLICY,
    sourceCodeSha256:await rerunCodeFingerprint(),inputs,draftChecks,
    targetArtists:6,distinctTargetAccounts:6,controlCoverage:controls,
    independentOwnershipLabelsAssigned:0,heldOutAccuracyClaim:false,thresholdCalibrated:false,
    requests:requests.map(({body,...r})=>r),
    plannedHttpRequests:24,uniqueArtistAccountComparisons:12,modelConditionsPerComparison:2,
    controlHttpRequests:12,uniqueControlPairs:6,intentionalControlArmRepeats:6,
    priorPilotReservedCents:budget.reservedSpendCents,proposedReservedCents:maxSpendCents,
    remainingPilotCentsAfterProposedReservation:budget.maxSpendCents-budget.reservedSpendCents-maxSpendCents,
    selection:cases.map(c=>({profileId:String(c.artist.profile_id),artist:c.artist.artist,
      instagramUrl:c.profile.url,stratum:c.selectionStratum,controlUrl:c.control.profile.url,
      controlSourceArtist:c.control.artist,controlKind:c.control.kind,ownershipLabel:null})),
    safeguards:{newPaidCalls:0,discoveryCalls:0,metadataFetches:0,publicPageFetches:0,catalogWrites:0,
      claimsAllowed:false,productionApproved:false,automaticRetries:0,concurrency:1,
      requestByteCap:6000,timeoutSeconds:25,maximumResponseBytes:2000000,
      ledgerSeedOrResetAllowed:false,sharedCheckpointMustStillMatchAtExecution:true,
      stopOnModelChange:true,stopOnAnyControlSupport:true,stopOnUncertainAdmission:true,
      historicalReplayCountsAsNewModelCall:false},
    executionPrerequisites:['Separate user approval bound to this manifest digest and $0.48 conservative cap.',
      'Execution must use the existing shared transactional pilot admission guard with this unchanged checkpoint.',
      'Send frozen request bytes only; no evidence rebuilding, provider fallback, fetching, retries or resume.',
      'Stop and retain reservations on model mismatch, malformed responses, control promotion or uncertain provider outcomes.',
      'Use exact-match fresh response receipts; cached historical results are not new evaluations.'],
  };
  // Exclusive creation: a prior prepared scope or partially written output cannot be overwritten.
  await fs.mkdir(outputDir,{recursive:false});
  await fs.mkdir(path.join(outputDir,'requests'));
  for(const r of requests)await fs.writeFile(path.join(outputDir,r.requestFile),JSON.stringify(r.body),{flag:'wx'});
  await write(path.join(outputDir,'prepared-manifest.json'),manifest);
  await write(path.join(outputDir,'preparation-receipt.json'),{manifestSha256:hash(JSON.stringify(manifest)),paidCalls:0,executionAllowed:false});
  return {outputDir,manifestSha256:hash(JSON.stringify(manifest)),targets:6,distinctControls:6,
    requests:24,maximumConservativeReservationUsd:0.48,completeCandidateDrafts:draftChecks.filter(d=>d.complete).length,
    heldCandidateDrafts:draftChecks.filter(d=>!d.complete).length,sharedObservedReservedCents:budget.reservedSpendCents,
    paidCalls:0,executionAllowed:false,selection:manifest.selection};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [sourceDir,budgetFile,outputDir]=process.argv.slice(2);
  if(!sourceDir||!budgetFile||!outputDir)throw Error('Usage: paired-verification-prep <frozen-source-dir> <observed-budget.json> <new-output-dir>');
  console.log(JSON.stringify(await preparePairedVerification({sourceDir,budgetFile,outputDir}),null,2));
}
