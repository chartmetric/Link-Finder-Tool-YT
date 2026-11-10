// Verification-only execution of separately approved, frozen contextual pairs.
// Importing or preflighting this module never connects to a provider/coordinator.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {contextualTestPair} from './instagram-contextual-test-prep.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {openSavedBatchGate,connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {rerunCodeFingerprint} from './instagram-saved-fix-rerun.mjs';
import {assessInstagramCandidates,CORROBORATED_POLICY,IDENTITY_CONTEXT_POLICY} from './musician-instagram-matching.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>hash(JSON.stringify(v));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const save=(dir,name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value,null,2),{flag:'wx'});
const variants=['current','fuller_metadata'];
const policies={current:CORROBORATED_POLICY,fuller_metadata:IDENTITY_CONTEXT_POLICY};

export async function preflightContextualComparison({manifestPath,batchDir}){
  const manifest=await read(manifestPath),source=await read(path.join(batchDir,'source-rows.json'));
  const original=await read(path.join(batchDir,'scope.json'));
  assert.equal(manifest.version,1,'Unknown preparation format.');
  assert.equal(manifest.preparationOnly,true);
  assert.equal(manifest.authorization.approved,false,'Preparation cannot authorize execution.');
  assert.equal(manifest.authorization.requiresNewApproval,true);
  assert.equal(manifest.authorization.existingBudgetReuseAllowed,false);
  assert.equal(manifest.authorization.conservativeCentsPerRequest,2);
  assert.equal(digest(source),manifest.sourceRowsSha256,'Saved source rows changed.');
  assert.equal(digest(original),manifest.sourceScopeSha256,'Saved source scope changed.');
  assert.ok(typeof manifest.expectedModel==='string'&&manifest.expectedModel.length>0,'Missing resolved model.');
  assert.deepEqual(manifest.policyByVariant,policies,'Unknown comparison policies.');
  assert.ok(manifest.codeHashes&&Object.keys(manifest.codeHashes).length>0,'Missing preparation code bindings.');
  for(const [name,expected] of Object.entries(manifest.codeHashes)){
    assert.ok(/^[\w-]+\.mjs$/.test(name),'Invalid code binding path.');
    assert.equal(hash(await fs.readFile(new URL(name,import.meta.url))),expected,'Prepared code changed.');
  }
  const cap=manifest.authorization.requestedMaximumSpendCents;
  assert.ok(Number.isInteger(cap)&&cap>0&&cap<=2000,'Invalid prepared ceiling.');
  assert.ok(manifest.requests.length>0&&manifest.requests.length<=1000&&manifest.requests.length*2<=cap);
  assert.ok(manifest.selection.length>0&&manifest.selection.length<=500);
  assert.equal(manifest.artists,manifest.selection.length);
  const sources=new Map(),targets=new Map(),owners=new Map(),keys=new Set(),pairs=new Map();
  for(const s of source){
    if(s.key){assert.ok(!sources.has(s.key),'Duplicate saved source key.');sources.set(s.key,s);}
    if(s.role==='candidate'&&s.url){
      if(!owners.has(s.url))owners.set(s.url,new Set());
      owners.get(s.url).add(String(s.profileId));
    }
  }
  for(const selected of manifest.selection){
    const target=source.find(s=>s.role==='candidate'&&String(s.profileId)===String(selected.profileId)&&s.url===selected.url);
    assert.ok(target&&target.status==='prepared'&&target.artist===selected.artist,'Unbound selected target.');
    assert.ok(!targets.has(String(selected.profileId)),'Duplicate selected target.');
    assert.equal(String(target.player.profile_id),String(selected.profileId));
    targets.set(String(selected.profileId),target);
  }
  const controlUrls=new Set(),controlDonors=new Set();
  for(const r of manifest.requests){
    assert.ok(/^[\w-]{1,120}$/.test(r.key)&&!keys.has(r.key),'Unsafe or duplicate request key.');
    keys.add(r.key);
    assert.ok(['candidate','control'].includes(r.role)&&variants.includes(r.variant),'Unknown role or variant.');
    const target=targets.get(String(r.profileId)),s=sources.get(r.sourceKey);
    assert.ok(target&&s&&s.status==='prepared'&&s.role===r.role,'Unbound request source.');
    assert.equal(r.artist,target.artist);
    assert.equal(r.instagramUrl,s.url);
    assert.equal(String(r.sourceProfileId),String(s.sourceProfileId??s.profileId));
    if(r.role==='candidate')assert.equal(s,target,'Candidate source is not its selected target.');
    else{
      assert.ok(!targets.has(String(r.sourceProfileId))&&!manifest.selection.some(t=>t.url===r.instagramUrl||t.artist===s.sourceArtist),
        'Control overlaps a target.');
      controlUrls.add(r.instagramUrl);controlDonors.add(String(r.sourceProfileId));
    }
    const rebuilt=contextualTestPair(target,s.profile).find(p=>p.variant===r.variant);
    assert.equal(r.sha256,rebuilt.sha256,'Frozen request differs from saved evidence.');
    assert.equal(r.rubric,rebuilt.rubric,'Frozen rubric changed.');
    assert.equal(digest(r.body),r.sha256,'Frozen request hash changed.');
    assert.equal(r.bytes,Buffer.byteLength(JSON.stringify(r.body)));
    assert.ok(r.bytes<=6000&&r.body.state.candidates.length===1,'Invalid request size or candidate count.');
    const pairKey=JSON.stringify([r.role,String(r.profileId),r.sourceKey]);
    if(!pairs.has(pairKey))pairs.set(pairKey,new Set());
    assert.ok(!pairs.get(pairKey).has(r.variant),'Duplicate comparison arm.');
    pairs.get(pairKey).add(r.variant);
  }
  for(const pair of pairs.values())assert.equal(pair.size,2,'Incomplete comparison pair.');
  for(const profileId of targets.keys())for(const role of ['candidate','control'])
    assert.equal(manifest.requests.filter(r=>String(r.profileId)===profileId&&r.role===role).length,2,'Each target needs both arms and a control.');
  assert.equal(controlUrls.size,manifest.distinctControlAccounts);
  assert.equal(controlUrls.size,targets.size,'Each target needs a distinct control account.');
  assert.equal(controlDonors.size,manifest.controlSourceArtists);
  const codeFingerprint=await rerunCodeFingerprint(),manifestSha256=digest(manifest);
  return {manifest,source,targets,owners,report:{ready:true,paidCalls:0,manifestSha256,codeFingerprint,
    expectedModel:manifest.expectedModel,requests:manifest.requests.length,maximumSpendCents:cap,
    approvalTemplate:{version:1,approved:false,manifestSha256,codeFingerprint,expectedModel:manifest.expectedModel,
      maxSpendCents:cap,budgetId:'contextual-comparison-REPLACE-WITH-NEW-APPROVAL-ID',approvalReference:''}}};
}

function approvedScope(prepared,approval){
  const {manifest,report,targets}=prepared;
  assert.equal(approval.version,1);
  assert.equal(approval.approved,true,'Separate explicit approval required.');
  for(const key of ['manifestSha256','codeFingerprint','expectedModel'])assert.equal(approval[key],report[key],`Approval ${key} changed.`);
  assert.equal(approval.maxSpendCents,report.maximumSpendCents,'Approval ceiling must match exactly.');
  assert.ok(/^contextual-comparison-[a-zA-Z0-9-]{8,100}$/.test(approval.budgetId)&&!approval.budgetId.includes('REPLACE'),
    'New comparison budget identity required.');
  assert.ok(typeof approval.approvalReference==='string'&&approval.approvalReference.trim(),'Missing separate approval reference.');
  return {authorization:{...approval},artists:[...targets.values()].map(t=>t.player),
    savedEvidenceOnly:true,liveLinkWrites:false,automaticRetries:0,
    requests:manifest.requests.map(r=>({...r,kind:'jev'}))};
}

const fields=['key','artist','profileId','role','variant','instagramUrl','sourceKey','sourceProfileId',
  'score','verdict','verdictLabelConfidence','verdictProbabilities','researchSupport','sharedHandleHold',
  'reason','route','providerReportedCostUsd','model','modelMatches','requestSha256','metadataActuallySupplied',
  'completeRequest','freshResponse','liveLinkChanged'];
const cell=v=>'"'+(typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'')).replaceAll('"','""')+'"';
async function exportFindings(outputDir,rows){
  await fs.writeFile(path.join(outputDir,'artist-instagram-findings.csv'),'\ufeff'+[fields,...rows.map(r=>fields.map(f=>r[f]))]
    .map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
}
async function assessResponse(r,response,prepared){
  const target=prepared.targets.get(String(r.profileId)),s=prepared.source.find(s=>s.key===r.sourceKey);
  const p=structuredClone(s.profile);
  p.identityComparison.reference=structuredClone(target.profile.identityComparison.reference);
  p.identityComparison.status='uncertain';p.jevVerification=response.answers[0];
  delete p.identityComparison.catalogConnections;
  const assessed=assessInstagramCandidates({methodsUsed:[{method:'serper',status:'used'}],profiles:[p]},target.player,
    {policy:prepared.manifest.policyByVariant[r.variant],mode:'offline',context:{profileId:r.profileId,metadata:target.context}});
  const rawSupport=assessed.simulationUrls.length>0;
  const shared=r.role==='candidate'&&(prepared.owners.get(r.instagramUrl)?.size??0)>1;
  return {rawSupport,researchSupport:rawSupport&&!shared,sharedHandleHold:shared,
    reason:shared?'shared_candidate_requires_ownership_review':assessed.candidates[0]?.reason,
    route:assessed.candidates[0]?.route};
}

// Tests inject BOTH the pool and the transport; neither has a live default here.
export async function executeContextualComparison({manifestPath,batchDir,approvalPath,outputDir,pool,transport,
  fingerprint=rerunCodeFingerprint}){
  const prepared=await preflightContextualComparison({manifestPath,batchDir});
  const approval=await read(approvalPath),scope=approvedScope(prepared,approval),scopeSha256=digest(scope);
  assert.ok(pool&&transport?.live===true,'Explicit coordinator and transport required.');
  // New directory only: never overwrite or resume any completed/partial archive.
  await fs.mkdir(outputDir,{recursive:false});
  await fs.mkdir(path.join(outputDir,'responses'));
  const rows=[],started=Date.now();
  let gate,journal,stopReason=null,stage='initialization',closeFailed=false;
  try{
    await save(outputDir,'approval.json',{scope,scopeSha256,approval,preflight:prepared.report,at:new Date().toISOString()});
    journal=await fs.open(path.join(outputDir,'results.jsonl'),'wx');
    // Only insert this new approval. Never update/reset an existing or pilot budget.
    await pool.query('INSERT INTO instagram_saved_batch_budgets (id,scope_sha256,cap_cents) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING',
      [scope.authorization.budgetId,scopeSha256,scope.authorization.maxSpendCents]);
    gate=await openSavedBatchGate({pool,scope,scopeSha256,journalPath:path.join(outputDir,'admissions.jsonl'),transport});
    const requests=[...scope.requests].sort((a,b)=>(a.role==='control'?0:1)-(b.role==='control'?0:1));
    for(const r of requests){
      stage='code_or_deadline_check';
      assert.ok(Date.now()-started<15*60*1000,'Deadline reached; no resume.');
      assert.equal(await fingerprint(),approval.codeFingerprint,'Code changed; no further dispatch.');
      stage='dispatch_or_response_uncertain';
      const response=await gate.request(r.key);
      // Archive every returned response BEFORE model/decision/acceptance checks.
      const answer=response.answers?.[0]??{};
      const row={...Object.fromEntries(['key','artist','profileId','role','variant','instagramUrl','sourceKey','sourceProfileId'].map(k=>[k,r[k]])),
        score:answer.sameIdentityProbability,verdict:answer.verdict,verdictLabelConfidence:answer.verdictLabelConfidence,
        verdictProbabilities:answer.verdictProbabilities,model:response.model,modelMatches:response.model===approval.expectedModel,
        providerReportedCostUsd:response.cost,requestSha256:r.sha256,metadataActuallySupplied:r.body.state.artistContext??null,
        completeRequest:r.body,freshResponse:response,liveLinkChanged:false};
      rows.push(row);
      stage='response_persistence';
      await save(outputDir,`response-${r.key}.json`,{key:r.key,requestSha256:r.sha256,response});
      try{
        stage='model_changed';
        if(!row.modelMatches)throw Error('Resolved model changed.');
        stage='invalid_fresh_answer';
        assert.equal(response.answers.length,1);
        assert.ok(Number.isFinite(row.score)&&row.score>=0&&row.score<=1&&['verified','likely','uncertain','mismatch'].includes(row.verdict));
        stage='offline_assessment';
        Object.assign(row,await assessResponse(r,response,prepared));
      }finally{
        const responseStage=stage;
        stage='result_persistence';
        await journal.write(JSON.stringify(row)+'\n');await journal.sync();
        stage=responseStage;
      }
      stage='control_promoted';
      if(r.role==='control'&&(row.rawSupport||row.score>=0.9))throw Error('Control supported or high-scoring.');
    }
  }catch{
    stopReason=stage;gate?.stop();
  }finally{
    try{await gate?.close();}catch{closeFailed=true;}
    try{await journal?.close();}catch{closeFailed=true;}
  }
  if(closeFailed)stopReason??='journal_close_failed';
  const summary={status:stopReason?'stopped':'completed',stopReason,plannedRequests:scope.requests.length,
    completedResponses:rows.length,maximumSpendCents:approval.maxSpendCents,budget:gate?.snapshot()??null,
    providerReportedCostUsd:rows.reduce((n,r)=>n+(r.providerReportedCostUsd??0),0),
    currentSupportedArtists:rows.filter(r=>r.role==='candidate'&&r.variant==='current'&&r.researchSupport).length,
    fullerMetadataSupportedArtists:rows.filter(r=>r.role==='candidate'&&r.variant==='fuller_metadata'&&r.researchSupport).length,
    supportedControlComparisons:rows.filter(r=>r.role==='control'&&r.researchSupport).length,
    accuracyCalibrated:false,comparison:prepared.manifest.comparison,
    newSearches:0,newMetadataFetches:0,liveLinkChanges:0,originalScoresChanged:false,automaticRetries:0,
    originalPilotModified:false,noAutomaticResume:true};
  // Independent final exports: one failed write must not prevent the others.
  const writes=await Promise.allSettled([save(outputDir,'summary.json',summary),
    save(outputDir,'findings.json',rows),exportFindings(outputDir,rows)]);
  if(writes.some(w=>w.status==='rejected'))throw Error('Partial archive persistence failed; reservations remain consumed. Do not retry.');
  return summary;
}

async function main(){
  const [mode,manifestPath,batchDir,approvalPath,outputDir,...extra]=process.argv.slice(2);
  if(extra.length||!manifestPath||!batchDir||!['--preflight','--run-approved'].includes(mode)
    ||(mode==='--run-approved'&&(!approvalPath||!outputDir))
    ||(mode==='--preflight'&&(approvalPath||outputDir)))
    throw Error('Usage: contextual-test-run --preflight <prepared-manifest> <saved-batch> OR --run-approved <prepared-manifest> <saved-batch> <separate-approval> <new-output-dir>');
  const prepared=await preflightContextualComparison({manifestPath,batchDir});
  if(mode==='--preflight'){console.log(JSON.stringify(prepared.report,null,2));return;}
  // Validate approval before even opening a coordinator connection.
  approvedScope(prepared,await read(approvalPath));
  const transport=frozenJevTransport({responseDir:path.join(outputDir,'responses'),apiKey:process.env.OPENROUTER_API_KEY});
  const pool=await connectSavedBatchPool();
  try{
    const summary=await executeContextualComparison({manifestPath,batchDir,approvalPath,outputDir,pool,transport});
    console.log(JSON.stringify(summary,null,2));if(summary.status!=='completed')process.exitCode=1;
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(()=>{console.error('Comparison refused or archive failed. No automatic retry; review local evidence and durable admissions.');process.exitCode=1;});
