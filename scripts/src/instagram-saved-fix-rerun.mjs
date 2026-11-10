// Verification-only diagnostic on frozen saved evidence. Never performs discovery,
// profile fetches, imports, claims or catalog writes. Paid mode is explicit.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {catalogConnectionEvidence,hasCatalogCrossLink,assessInstagramCandidates,instagramProfileUrl,referenceUrl} from './musician-instagram-matching.mjs';
import {artistContextFromPacket} from './instagram-artist-metadata-overlay.mjs';
import {fitArtistContext,jevRequest,createLiveTransport} from './instagram-pilot-live-transport.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {connectPilotCoordinator} from './instagram-pilot-shared-budget.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(file,data)=>fs.writeFile(file,JSON.stringify(data,null,2),{flag:'wx'});
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const fold=value=>String(value).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const id=value=>value==null?'':String(value).trim();
const compare=(a,b)=>a<b?-1:a>b?1:0;
const accountUrl=(value,platform)=>{
  const known=instagramProfileUrl(value)??referenceUrl(value,platform);
  if(known)return known;
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password)return null;
    u.hostname=u.hostname.replace(/^www\./,'');
    u.pathname=u.pathname.replace(/\/+$/,'')||'/';
    return u.href;
  }catch{return null;}
};
const identityKeys=item=>[
  id(item.artist?.profile_id)&&`profile:${id(item.artist.profile_id)}`,
  id(item.artist?.cm_artist)&&`cm:${id(item.artist.cm_artist)}`,
  ...(item.artist?.account_ids??[]).filter(x=>id(x)).map(x=>`account:${id(x)}`),
  ...(item.artist?.accounts??[]).flatMap(a=>[
    id(a.account_id)&&`account:${id(a.account_id)}`,
    accountUrl(a.account_url,a.platform)&&`url:${accountUrl(a.account_url,a.platform)}`,
  ]),
  accountUrl(item.profile?.identityComparison?.reference?.url,item.profile?.identityComparison?.reference?.platform)
    &&`url:${accountUrl(item.profile.identityComparison.reference.url,item.profile.identityComparison.reference.platform)}`,
].filter(Boolean);
const readable=item=>{
  const p=item.profile,c=p?.identityComparison,url=instagramProfileUrl(p?.url);
  return id(item.artist?.profile_id)&&fold(item.artist?.artist??'')&&url
    &&instagramProfileUrl(c?.candidate?.url)===url&&c?.reference?.url&&c.reference.platform;
};
const stableItemKey=item=>JSON.stringify([id(item.artist?.profile_id),id(item.artist?.cm_artist),
  item.artist?.artist,item.archive??'',item.profile,item.context,item.artist]);

export async function rerunCodeFingerprint(){
  const dir=path.dirname(fileURLToPath(import.meta.url));
  const files=(await fs.readdir(dir)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).sort();
  const entries=[];
  for(const file of files)entries.push([file,hash(await fs.readFile(path.join(dir,file)))]);
  return hash(JSON.stringify(entries));
}

export function revisedProfile(original,artist){
  const p=structuredClone(original),c=p.identityComparison;
  p.url=instagramProfileUrl(p.url);
  if(!p.url||!c||instagramProfileUrl(c.candidate?.url)!==p.url)throw Error('Saved candidate is not identity-bound.');
  const reference={platform:c.reference.platform,url:c.reference.url};
  const connections=catalogConnectionEvidence(c.candidate,artist);
  const linked=hasCatalogCrossLink(c.reference,c.candidate,p.url,reference)||connections.length>0;
  c.status=linked?'likely':'uncertain';c.score=linked?60:0;
  c.reasons=[linked?'Exact catalog account cross-link':'No exact cross-link'];
  delete c.catalogConnections;
  if(connections.length)c.catalogConnections=connections;
  delete p.jevVerification;
  return p;
}

export function selectSavedCases(pool,limit=20){
  if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Approved comparison allows at most 20 target artists.');
  const ranked=pool.filter(x=>readable(x)&&x.profile.jevVerification
    &&x.profile.jevVerification.verdict!=='mismatch').sort((a,b)=>
      a.priority-b.priority||b.profile.jevVerification.sameIdentityProbability-a.profile.jevVerification.sameIdentityProbability
      ||compare(a.artist.artist,b.artist.artist)||compare(a.profile.url,b.profile.url)
      ||compare(stableItemKey(a),stableItemKey(b)));
  const targets=[],seen=new Set();
  for(const item of ranked){
    if(seen.has(id(item.artist.profile_id)))continue;
    targets.push(item);seen.add(id(item.artist.profile_id));
    if(targets.length===limit)break;
  }
  // Reserve all selected catalog identities before assigning any controls.
  // Include aliases/other observations sharing those identities, conservatively.
  const targetKeys=new Set(targets.flatMap(identityKeys)),targetRecords=new Set(targets);
  for(let changed=true;changed;){
    changed=false;
    for(const item of pool){
      if(targetRecords.has(item)||!identityKeys(item).some(key=>targetKeys.has(key)))continue;
      targetRecords.add(item);identityKeys(item).forEach(key=>targetKeys.add(key));changed=true;
    }
  }
  const targetUrls=new Set([...targetRecords].map(x=>instagramProfileUrl(x.profile?.url)).filter(Boolean));
  const targetNames=new Set([...targetRecords].map(x=>fold(x.artist?.artist??'')).filter(Boolean));
  const groups=new Map();
  for(const item of pool){
    const url=instagramProfileUrl(item.profile?.url);
    if(!url)continue;
    if(!groups.has(url))groups.set(url,[]);
    groups.get(url).push(item);
  }
  const controls=[...groups].filter(([url,items])=>!targetUrls.has(url)
    &&items.some(readable)&&items.every(other=>
      !identityKeys(other).some(key=>targetKeys.has(key))
      &&!targetNames.has(fold(other.artist?.artist??''))
      &&[...targetRecords].every(target=>{
        const candidate=other.profile?.identityComparison?.candidate;
        const reference=target.profile?.identityComparison?.reference;
        return !candidate||!reference||(!catalogConnectionEvidence(candidate,target.artist).length
          &&!hasCatalogCrossLink(reference,candidate,url,{platform:reference.platform,url:reference.url}));
      })))
    .sort(([a],[b])=>compare(a,b))
    .map(([,items])=>items.filter(readable).sort((a,b)=>compare(stableItemKey(a),stableItemKey(b)))[0]);
  // Use each distinct normalized saved account once before balanced reuse.
  // No suitable account is not a reason to silently remove a target.
  return targets.map((item,index)=>{
    const control=controls.length?controls[index%controls.length]:null;
    return {...item,control:control?{artist:control.artist.artist,profileId:control.artist.profile_id,
      profile:control.profile,kind:'cross_artist_synthetic_challenge',ownershipLabel:null}:null};
  });
}

export function summarizeSavedControls(cases,results=[]){
  const assigned=cases.filter(c=>c.control);
  const accounts=new Set(assigned.map(c=>instagramProfileUrl(c.control.profile.url)).filter(Boolean));
  const evaluated=results.filter(r=>r.variant==='control'&&r.status==='evaluated');
  const evaluatedAccounts=new Set(evaluated.map(r=>instagramProfileUrl(r.instagramUrl)).filter(Boolean));
  return {
    kind:'cross_artist_synthetic_challenge',ownershipLabelsAssigned:0,
    independentlySourceReviewedNegativeLabels:0,accuracyScored:false,calibratedFalsePositiveRate:null,
    targetArtists:new Set(cases.map(c=>id(c.artist.profile_id))).size,
    assignedComparisons:assigned.length,unassignedTargets:cases.length-assigned.length,
    distinctControlAccounts:accounts.size,reusedComparisons:assigned.length-accounts.size,
    distinctAccountShortfall:cases.length-accounts.size,
    diversityStatus:assigned.length===cases.length&&accounts.size===cases.length&&cases.length>0
      ?'distinct_account_per_target':'insufficient_control_diversity',
    evaluatedComparisons:evaluated.length,distinctEvaluatedControlAccounts:evaluatedAccounts.size,
    distinctEvaluatedTargetArtists:new Set(evaluated.map(r=>id(r.profileId))).size,
    distinctEvaluatedPairs:new Set(evaluated.map(r=>JSON.stringify([id(r.profileId),
      instagramProfileUrl(r.instagramUrl)]))).size,
    evaluatedDiversityStatus:!evaluated.length?'not_evaluated'
      :evaluatedAccounts.size===cases.length&&new Set(evaluated.map(r=>id(r.profileId))).size===cases.length
        ?'distinct_account_per_target':'insufficient_control_diversity',
    evaluatedGatePasses:evaluated.filter(r=>r.gatePassed===true).length,
    note:'Distinct saved account URLs are not independent ownership labels or independent samples. '
      +'Reuse and missing controls limit coverage. Synthetic gate passes require investigation, not false-positive scoring. '
      +'Accuracy scoring requires the separately approved benchmark policy and independently source-reviewed labels.',
  };
}

export async function prepareSavedFixRerun({directories,auditFile,outputDir,priorReservedCents}){
  if(!Number.isInteger(priorReservedCents)||priorReservedCents<0||priorReservedCents+100>1000)
    throw Error('The approved $1 run must fit the unchanged shared $10 pilot ceiling.');
  const audit=await read(auditFile),pool=[],inputs=[];
  for(const dir of directories){
    const manifestText=await fs.readFile(path.join(dir,'approved-manifest.json'),'utf8');
    const resultsText=await fs.readFile(path.join(dir,'results.jsonl'),'utf8');
    const overlayText=await fs.readFile(path.join(dir,'artist-context-evidence.json'),'utf8');
    const manifest=JSON.parse(manifestText),overlay=JSON.parse(overlayText);
    inputs.push({directory:dir,manifestSha256:hash(manifestText),resultsSha256:hash(resultsText),overlaySha256:hash(overlayText)});
    for(const result of resultsText.split('\n').filter(Boolean).map(JSON.parse)){
      const artist=manifest.artists.find(a=>String(a.profile_id)===String(result.profileId));
      const packet=overlay.packets.find(p=>String(p.profileId)===String(result.profileId));
      if(!artist||!packet||String(packet.cmArtist)!==String(artist.cm_artist))throw Error('Frozen metadata identity mismatch.');
      const context=artistContextFromPacket(packet);
      for(const profile of (result.rawResult??result.partialEvidence)?.profiles??[]){
        if(!profile.identityComparison||!profile.jevVerification)continue;
        const finding=audit.rows.find(r=>r.profile_id===String(result.profileId)&&r.instagram_link===profile.url);
        if(!finding)throw Error('Saved candidate is absent from the completed audit.');
        const priority=finding.priority==='Review unused supporting evidence'?0
          :finding.priority==='Review missing link-path evidence'?1:2;
        pool.push({artist,profile,context,priority,archive:dir});
      }
    }
  }
  const cases=selectSavedCases(pool);
  if(!cases.length)throw Error('No readable saved candidates eligible for comparison.');
  const controlCoverage=summarizeSavedControls(cases);
  const maxCalls=cases.length+controlCoverage.assignedComparisons;
  const manifest={run_allowed:false,authorization:{approved:true,approvedBy:'user',maxSpendCents:100,
    priorReservedCents,runId:'saved-verification-fixes-approved-usd1-20261110',noImports:true,
    source:'User explicitly approved a verification-only rerun capped at $1, up to 20 previously found candidates and unrelated controls.'},
    purpose:'Diagnostic comparison with archived decisions; not full attribution correction or import authorization.',
    artists:cases.map(c=>({profile_id:String(c.artist.profile_id),source_identity_matches:true,
      reference_preflight:{readiness:'reference_usable'}})),
    selection:{claimsAllowed:false,experimentalAcceptanceEnabled:false,fullTierRerun:false,controlCoverage},
    proposed_limits:{serper_requests_total:0,serper_requests_per_artist:0,scrapecreators_requests_total:0,
      instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,jev_requests_total:maxCalls,
      jev_requests_per_artist:2,paid_http_requests_total:maxCalls,public_spotify_oembed_requests_total:0,
      public_official_or_linkhub_page_requests_total:0,public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:25,job_wall_time_minutes:15,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,automatic_retries:0}};
  await fs.mkdir(outputDir,{recursive:false});
  const scope={manifest,cases,inputs,controlCoverage,preparedAt:new Date().toISOString(),paidCalls:0,
    missingMetadata:'Audit entries without readable saved identity metadata are not substituted or fetched.',
    prerequisites:['Both requested fixes merged; combined offline validation passes before run.']};
  await save(path.join(outputDir,'prepared-scope.json'),scope);
  await save(path.join(outputDir,'prepared-scope-receipt.json'),{sha256:hash(JSON.stringify(scope))});
  return {artists:cases.length,maxCalls,worstCaseReservedUsd:maxCalls*0.02,controlCoverage,
    cappedAtUsd:1,unusedSupportCases:cases.filter(c=>c.priority===0).length,paidCalls:0,outputDir};
}

export async function runSavedFixRerun(outputDir){
  const scope=await read(path.join(outputDir,'prepared-scope.json'));
  const receipt=await read(path.join(outputDir,'prepared-scope-receipt.json'));
  if(hash(JSON.stringify(scope))!==receipt.sha256)throw Error('Frozen scope changed.');
  // These receipts are written only after checking the task merge states and
  // running the combined offline suite. They are not model-quality approval.
  const validation=await read(path.join(outputDir,'merged-validation.json'));
  if(validation.task144!=='MERGED'||validation.task145!=='MERGED'||validation.offlineTestsPassed!==true)
    throw Error('Both merged fixes and combined offline validation are required.');
  if(validation.codeSha256!==await rerunCodeFingerprint())throw Error('Code changed since combined validation; no paid dispatch.');
  const manifest=structuredClone(scope.manifest);
  if(scope.cases.length>20||manifest.authorization.maxSpendCents!==100)throw Error('Unexpected approved scope.');
  manifest.run_allowed=true;
  const requests=[];
  for(const c of scope.cases){
    const make=original=>{
      const source=structuredClone(original);
      source.identityComparison.reference=structuredClone(c.profile.identityComparison.reference);
      const p=revisedProfile(source,c.artist);
      const reference={platform:p.identityComparison.reference.platform,url:p.identityComparison.reference.url};
      const linked=hasCatalogCrossLink(p.identityComparison.reference,p.identityComparison.candidate,p.url,reference)
        ||catalogConnectionEvidence(p.identityComparison.candidate,c.artist).length>0;
      p.identityComparison.status=linked?'likely':'uncertain';
      return fitArtistContext({artist:c.artist.artist,catalogReference:reference,profiles:[p],artistContext:c.context},6000);
    };
    for(const [variant,original]of [['candidate',c.profile],...(c.control?[['control',c.control.profile]]:[])]){
      try{
        const payload=make(original),body=jevRequest(payload);
        if(Buffer.byteLength(JSON.stringify(body))>6000)throw Error('Request exceeds byte cap.');
        requests.push({c,variant,payload,requestSha256:hash(JSON.stringify(body))});
      }catch(error){requests.push({c,variant,held:error.message});}
    }
  }
  await fs.mkdir(path.join(outputDir,'responses'));
  await save(path.join(outputDir,'approved-manifest.json'),manifest);
  const keys=Object.fromEntries(['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'].map(k=>[k,process.env[k]]));
  const base=createLiveTransport({keys,responseDir:path.join(outputDir,'responses')});
  const transport={...base,dispatch:request=>{
    if(request.kind!=='jev')throw Error('Only verification is approved.');
    return base.dispatch(request);
  }};
  // The shared coordinator refuses a missing/stale checkpoint, exhausted cap or
  // reused run identity before any provider call.
  let coordinator,budget;const results=[];
  const deadlineAt=Date.now()+15*60000;
  try{
    coordinator=await connectPilotCoordinator();
    const checkpoint=await coordinator.snapshot();
    if(checkpoint.reservedSpendCents!==manifest.authorization.priorReservedCents)throw Error('Shared checkpoint changed since preparation.');
    budget=await createPilotBudget({manifest,transport,mode:'live',
      journalPath:path.join(outputDir,'admissions.jsonl'),sharedCoordinator:coordinator});
    for(const request of requests){
      const {c,variant}=request;
      const row={artist:c.artist.artist,profileId:String(c.artist.profile_id),variant,
        instagramUrl:variant==='candidate'?c.profile.url:c.control.profile.url,
        oldVerdict:variant==='candidate'?c.profile.jevVerification.verdict:null,
        oldScore:variant==='candidate'?c.profile.jevVerification.sameIdentityProbability:null,
        ...(variant==='control'?{controlKind:'cross_artist_synthetic_challenge',ownershipLabel:null}:{})};
      if(request.held){results.push({...row,status:'held_before_dispatch',reason:request.held});continue;}
      if(budget.snapshot().stopped)break;
      const key=`${c.artist.profile_id}:${variant}`;
      await save(path.join(outputDir,`${c.artist.profile_id}-${variant}-request.json`),
        {request:jevRequest(request.payload),sha256:request.requestSha256});
      try{
        const decisions=await budget.request({profileId:c.artist.profile_id,kind:'jev',key,payload:request.payload,deadlineAt});
        const p={...request.payload.profiles[0],jevVerification:decisions[0].jevVerification};
        const gate=assessInstagramCandidates({methodsUsed:[{method:'serper',status:'used'}],profiles:[p]},c.artist);
        results.push({...row,status:'evaluated',decision:decisions[0].jevVerification,gatePassed:gate.urls.includes(p.url),
          gateReason:gate.candidates[0].reason,contextDelivery:request.payload.contextDelivery});
        console.log(JSON.stringify(results.at(-1)));
        if(variant==='control'&&(gate.urls.length||decisions[0].jevVerification.sameIdentityProbability>=0.9))
          budget.stop('Synthetic cross-artist challenge was promoted or high-scoring; stop for investigation, not ownership grading.');
      }catch(error){
        results.push({...row,status:'unresolved',reason:error.message});
        budget.stop('Comparison call failed; no retries or uncertain replays.');
      }
    }
  }finally{
    if(budget)await budget.close();else await coordinator?.close();
    await save(path.join(outputDir,'summary.json'),{results,budget:budget?.snapshot()??null,
      controlCoverage:summarizeSavedControls(scope.cases,results),
      newSearches:0,newMetadataCalls:0,claims:0,catalogWrites:0,safeForImport:false,
      note:'Historical before/after diagnostic, not a controlled population accuracy estimate. Shared budget bookkeeping is not a catalog write.'});
  }
  return {completed:results.length,results,budget:budget.snapshot()};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--run-approved'&&process.argv[3]){
    console.log(JSON.stringify(await runSavedFixRerun(process.argv[3])));
  }else throw Error('Use exported offline preparation, then --run-approved <prepared-directory>.');
}
