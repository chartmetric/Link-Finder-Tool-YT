import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {createYoutubeBudget,continueYoutubeBudget,youtubeBudgetGate} from './youtube-ownership-budget.mjs';
import {loadReturnedYoutubeReceipts,reuseReturnedYoutubeRequest,saveYoutubeArtifact} from './youtube-ownership-recovery.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision,youtubeOwnershipTransport} from './youtube-ownership-transport.mjs';
import {evidenceDigest,youtubeOwnershipUrl,youtubeVerificationInput,reviewYoutubeBatch} from './youtube-ownership-policy.mjs';

const root='generated-artifacts/youtube-no-link-20-usd2';
const directory=root+'/ownership-check-execution';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=(name,value)=>fs.writeFile(directory+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
const knownErrors=new Set(['provider_funding_failure','provider_authentication_or_access_failure',
  'provider_rate_limit','unexpected_provider_redirect','unreadable_provider_response','provider_protocol_failure']);

export function approvedYoutubeRecords(plan,approval,inputs,overlay){
  return approval.scope.map(target=>{
    const saved=inputs.filter(i=>i.profileId===target.profile_id),p=overlay.packets.find(p=>p.profileId===target.profile_id);
    assert.ok(p);assert.equal(p.cmArtist,target.cm_artist);
    const artist=saved[0]?.state.artist??{profileId:p.profileId,cmArtist:p.cmArtist,name:p.artist,catalogProfile:p.catalogProfile};
    assert.equal(artist.name,p.artist);
    return {artist,searchStatus:saved.length?'candidates_found':'no_match',
      candidates:saved.map(input=>{
        const t=plan.targets.find(t=>t.profileId===target.profile_id&&t.channelUrl===youtubeOwnershipUrl(input.url));
        assert.ok(t);assert.equal(t.savedInputSha256,input.inputSha256);
        const s=input.state.candidate.searchEvidence;
        const candidate={url:input.url,title:s.title,snippet:s.snippet,sourceUrl:s.sourceUrl};
        assert.equal(youtubeVerificationInput(artist,candidate).inputSha256,input.inputSha256);
        return candidate;
      })};
  });
}
export async function collectYoutubeOwnership({plan,records,request,onCapture,onAnswer,onHold,progress,freezeModel}){
  const captures=new Map(),failures=new Map();
  for(const target of plan.metadataRequests){
    const packet=await request({key:target.key,kind:'metadata'},{method:'GET',url:target.requestUrl});
    const capture=normalizeYoutubeChannel(packet,target.channelUrl);
    if(capture)captures.set(target.channelUrl,capture);
    else failures.set(target.channelUrl,packet.status===200?'unbound_provider_channel_identity':
      'channel_details_unavailable_http_'+packet.status);
    await onCapture(target,packet,capture);
    await progress({phase:'channel_details',processed:captures.size+failures.size,total:plan.metadataRequests.length,
      usableCaptures:captures.size});
  }
  for(const record of records)for(const candidate of record.candidates){
    const url=youtubeOwnershipUrl(candidate.url);
    candidate.capture=captures.get(url)??null;
    candidate.captureIssue=failures.get(url)??null;
  }
  // Assess reuse after all channel IDs and aliases are known, before any model
  // positives. Search-only strings cannot establish alias equivalence.
  const baseline=reviewYoutubeBatch(records);
  let checked=0,heldOversized=0;
  for(const record of baseline)for(const {candidate,decision} of record.candidates){
    if(decision.status!=='needs_identity_check')continue;
    const input=youtubeVerificationInput(record.artist,candidate);
    const prepared=youtubeDecisionRequest(input,plan);
    const key='youtube-model-'+evidenceDigest([record.artist.profileId,youtubeOwnershipUrl(candidate.url)]);
    if(!prepared.ready){
      candidate.modelIssue='model_request_exceeds_approved_byte_limit';
      heldOversized++;
      await onHold({key,profileId:record.artist.profileId,url:candidate.url,inputSha256:input.inputSha256,
        requestSha256:prepared.inputSha256,bytes:prepared.bytes,maximumBytes:plan.model.maxRequestBytes,
        reason:candidate.modelIssue,request:prepared.request});
      continue;
    }
    await freezeModel(key,prepared.inputSha256);
    await onHold({key,profileId:record.artist.profileId,url:candidate.url,inputSha256:input.inputSha256,
      requestSha256:prepared.inputSha256,bytes:prepared.bytes,readyForDispatch:true,request:prepared.request});
    const packet=await request({key,kind:'model'},prepared.request);
    candidate.recordedAnswer=parseYoutubeDecision(packet,input,plan,prepared.inputSha256);
    await onAnswer(key,candidate.recordedAnswer);
    checked++;
    await progress({phase:'ownership_checks',processed:checked,heldOversized,total:plan.targets.length});
  }
  const reviewed=reviewYoutubeBatch(baseline.map(r=>({
    artist:r.artist,searchStatus:r.searchStatus,candidates:r.candidates.map(c=>c.candidate)})));
  for(const r of reviewed)for(const c of r.candidates){
    if(c.candidate.modelIssue)c.decision.reason=c.candidate.modelIssue;
    if(c.candidate.captureIssue)c.decision.reason=c.candidate.captureIssue;
  }
  return {reviewed,metadataCalls:captures.size+failures.size,modelCalls:checked,
    usableCaptures:captures.size,unavailableOrUnboundCaptures:failures.size,heldOversized};
}
function findingsCsv(reviewed){
  const rows=reviewed.flatMap(r=>r.candidates.length?r.candidates.map(({candidate,decision})=>({
    artist:r.artist.name,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,
    artistOutcome:r.outcome,candidateUrl:candidate.url,...decision,
    searchTitle:candidate.title,searchSnippet:candidate.snippet,
    metadataActuallyUsed:youtubeVerificationInput(r.artist,candidate).state,
    recordedModelAnswer:candidate.recordedAnswer??null,
  })):[{artist:r.artist.name,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,
    artistOutcome:r.outcome,status:r.outcome,reason:'Completed search returned no channel candidate; not proof of account absence.',
    reviewSuggestion:false,verified:false,liveLinkAccepted:false,metadataActuallyUsed:r.artist}]);
  const columns=[...new Set(rows.flatMap(Object.keys))];
  const cell=v=>{let s=v&&typeof v==='object'?JSON.stringify(v):String(v??'');
    if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
}
export async function runApprovedYoutubeCheck(live=false){
  const stored=await read(root+'/ownership-check-preparation/plan.json');
  const {planSha256,...plan}=stored;
  assert.equal(evidenceDigest(plan),planSha256);
  const {planSha256:unused,...onDisk}=stored;assert.equal(evidenceDigest(onDisk),planSha256);
  const approval=await read(root+'/approval.json'),summary=await read(root+'/summary.json');
  const inputs=await read(root+'/ownership-review-ready/verification-inputs.json');
  const overlay=await read(root+'/ownership-review-ready/catalog-evidence.json');
  for(const [name,value] of Object.entries({approval,summary,verificationInputs:inputs,catalogEvidence:overlay}))
    assert.equal(evidenceDigest(value),plan.sourceFiles[name+'Sha256']);
  assert.equal(plan.runAllowed,false);assert.equal(plan.approvalRequired,true);
  assert.equal(plan.spending.maximumNewReservationCents,136);
  assert.equal(plan.spending.maximumCombinedReservationCents,176);
  const records=approvedYoutubeRecords(plan,approval,inputs,overlay);
  for(const input of inputs){
    const {policy,rules,state,inputSha256}=input;
    assert.equal(evidenceDigest({policy,rules,state}),inputSha256);
  }
  const ownFiles=['scripts/src/run-youtube-ownership-check.mjs','scripts/src/youtube-ownership-budget.mjs',
    'scripts/src/youtube-ownership-recovery.mjs',
    'scripts/src/youtube-ownership-transport.mjs','scripts/src/youtube-discovery-test.mjs'];
  const fingerprints={...plan.codeFingerprints};
  for(const file of ownFiles)fingerprints[file]=evidenceDigest(await fs.readFile(file,'utf8'));
  const assertFrozen=async()=>{
    for(const [file,sha] of Object.entries(fingerprints))assert.equal(evidenceDigest(await fs.readFile(file,'utf8')),sha);
    assert.equal(evidenceDigest(await read(root+'/ownership-check-preparation/plan.json')),evidenceDigest(stored));
    assert.equal(evidenceDigest(await read(root+'/ownership-review-ready/verification-inputs.json')),plan.sourceFiles.verificationInputsSha256);
  };
  await assertFrozen();
  // Reconcile each prior search receipt against the frozen exact cohort and
  // candidates, not just a historical dollar summary.
  const journal=(await fs.readFile(root+'/admissions.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(journal.length,20);assert.equal(new Set(journal.map(j=>j.profileId)).size,20);
  for(const j of journal){
    const target=approval.scope.find(t=>t.profile_id===j.profileId);assert.ok(target);
    assert.equal(j.reservedCents,2);assert.equal(j.request.q,`${target.artist} artist official YouTube channel`);
    const packet=await read(root+'/response-'+j.profileId+'.json');
    assert.equal(packet.status,200);assert.deepEqual(packet.request,j.request);
    const found=youtubeSearchCandidates(packet.body);
    const expected=inputs.filter(i=>i.profileId===j.profileId);
    assert.equal(found.length,expected.length);
    for(const c of found){
      const i=expected.find(i=>youtubeOwnershipUrl(i.url)===youtubeOwnershipUrl(c.url));
      assert.ok(i);assert.equal(i.state.candidate.searchEvidence.title,c.title);
      assert.equal(i.state.candidate.searchEvidence.snippet,c.snippet);
    }
  }
  if(!live){
    console.log(JSON.stringify({ready:true,artists:records.length,counts:plan.counts,maximumAdditionalUsd:1.36,paidCalls:0}));
    return;
  }
  assert.ok(process.argv.includes('--additional-cap-cents=136'));
  assert.ok(process.argv.includes('--plan-sha256='+planSha256));
  assert.ok(process.env.SCRAPECREATORS_API_KEY&&process.env.OPENROUTER_API_KEY,'Missing provider credential.');
  const owner=randomUUID(),id=approval.id+'-ownership-v1';
  const continuing=process.argv.includes('--continue-approved');
  const authorization={approved:true,approvedBy:'User explicitly approved the $1.36 YouTube ownership check.',
    approvedScope:'34 channel lookups and up to 34 identity checks for the saved 16 artists; no new searches.',
    approvedAdditionalCents:136,preservedPriorCents:40,maximumCombinedCents:176,parentMaximumCents:200,
    parentId:approval.id,planSha256,codeFingerprints:fingerprints,at:new Date().toISOString(),
    ...(continuing?{continuationOfExistingApproval:true,
      reason:'Accept the observed dated resolution of the requested model alias; reuse every saved response and continue only untouched requests.'}:{})};
  const pool=await connectSavedBatchPool();
  let gate=null,started=false;
  try{
    if(!continuing){
      await fs.mkdir(directory,{recursive:false});
      for(const dir of ['receipts','channel-captures','model-inputs','channel-answers'])await fs.mkdir(directory+'/'+dir);
    }
    const authorizationFile=continuing?'continuation-authorization.json':'authorization.json';
    const authorizationHash=evidenceDigest(authorization);
    const allowed=new Map(plan.metadataRequests.map(t=>[t.key,{kind:'metadata',
      inputSha256:evidenceDigest({method:'GET',url:t.requestUrl})}]));
    for(const t of plan.targets)allowed.set('youtube-model-'+evidenceDigest([t.profileId,t.channelUrl]),{kind:'model',inputSha256:null});
    let recovered={packets:new Map(),receipts:new Map()};
    if(continuing){
      const prior=await read(directory+'/authorization.json');
      assert.equal(prior.planSha256,planSha256);
      assert.equal(prior.approvedAdditionalCents,136);assert.equal(prior.parentMaximumCents,200);
      recovered=await loadReturnedYoutubeReceipts(directory,allowed);
      await save(authorizationFile,authorization);
      await continueYoutubeBudget({pool,id,parentId:approval.id,owner,planHash:planSha256,
        priorAuthorizationHash:evidenceDigest(prior),authorizationHash,receipts:recovered.receipts});
    }else{
      await save(authorizationFile,authorization);
      await createYoutubeBudget({pool,id,parentId:approval.id,owner,planHash:planSha256,authorizationHash});
    }
    gate=youtubeBudgetGate({pool,id,parentId:approval.id,owner,planHash:planSha256,authorizationHash,allowed});started=true;
    const transport=youtubeOwnershipTransport({gate,archiveDir:directory,assertFrozen:async()=>{
      await assertFrozen();assert.equal(evidenceDigest(await read(directory+'/'+authorizationFile)),authorizationHash);
    },credentials:{scrapecreators:process.env.SCRAPECREATORS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY}});
    const write=(name,value)=>saveYoutubeArtifact(directory,name,value,{allowExisting:continuing});
    const request=reuseReturnedYoutubeRequest(recovered.packets,transport);
    const result=await collectYoutubeOwnership({plan,records,request,
      onCapture:async(t,packet,capture)=>write('channel-captures/'+evidenceDigest(t.channelUrl)+'.json',
        {channelUrl:t.channelUrl,receiptSha256:evidenceDigest(packet),capture}),
      onAnswer:async(key,answer)=>write('channel-answers/'+evidenceDigest(key)+'.json',answer),
      onHold:async packet=>write('model-inputs/'+evidenceDigest(packet.key)+'.json',packet),
      freezeModel:async(key,sha)=>{const expected=allowed.get(key);assert.equal(expected?.kind,'model');
        assert.equal(expected.inputSha256,null);expected.inputSha256=sha;},
      progress:async p=>{
        console.log(JSON.stringify(p));
        await fs.writeFile(directory+'/progress.json',JSON.stringify({...p,at:new Date().toISOString(),budget:await gate.stats()}));
      }});
    await save('artist-outcomes.json',result.reviewed);
    await fs.writeFile(directory+'/youtube-ownership-findings.csv',findingsCsv(result.reviewed),{flag:'wx'});
    const statuses=result.reviewed.flatMap(r=>r.candidates.map(c=>c.decision.status));
    await gate.close('completed');
    const report={status:'completed',artists:records.length,artistsWithCandidates:16,candidates:plan.targets.length,
      metadataCalls:result.metadataCalls,modelCalls:result.modelCalls,
      usableCaptures:result.usableCaptures,unavailableOrUnboundCaptures:result.unavailableOrUnboundCaptures,
      reusedSavedReceipts:recovered.receipts.size,
      heldOversized:result.heldOversized,
      artistsWithLikelyChannels:result.reviewed.filter(r=>r.candidates.some(c=>c.decision.reviewSuggestion)).length,
      completedNoChannelResult:result.reviewed.filter(r=>r.outcome==='completed_no_channel_result').length,
      candidateStates:statuses.reduce((out,s)=>(out[s]=(out[s]??0)+1,out),{}),
      budget:await gate.stats(),newSearches:0,catalogWrites:0,originalResultsChanged:false,instagramChanges:false};
    await save('summary.json',report);console.log(JSON.stringify(report,null,2));
  }catch(e){
    if(started){
      await gate.close('stopped');
      await save(continuing?'continuation-stopped.json':'stopped.json',{reason:knownErrors.has(e.message)?e.message:
        'Execution stopped on an uncertain request, invalid evidence or safety check; no automatic retry.',
        budget:await gate.stats(),reservationsPreserved:true});
    }
    throw Error(knownErrors.has(e.message)?e.message:'YouTube ownership check stopped safely; inspect the saved receipts and spending records without retrying.');
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  await runApprovedYoutubeCheck(process.argv.includes('--run-approved'));
