// Offline whole-cohort investigation. Reads archives, never credentials or HTTP.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {jevRequest,completeJevDraft,fitArtistContext,boundedArtistContext} from './instagram-pilot-live-transport.mjs';
import {catalogReferences} from './musician-instagram-matching.mjs';
import {IDENTITY_CONTEXT_RUBRIC} from './instagram-ownership-rubric.mjs';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
import {LOSSLESS_REQUEST_V4,REQUEST_BYTE_CAP,decodeLosslessState} from './instagram-lossless-request.mjs';

const encode=v=>JSON.stringify(v),clean=v=>v===undefined?undefined:JSON.parse(encode(v));
const hash=v=>createHash('sha256').update(v).digest('hex');
const bytes=v=>Buffer.byteLength(encode(v),'utf8');

export function losslessDraftFor(saved){
  const payload={artist:saved.artist,catalogReference:catalogReferences(saved.player)[0],
    profiles:[saved.profile],artistContext:saved.context,ownershipRubric:IDENTITY_CONTEXT_RUBRIC,
    requestSerialization:LOSSLESS_REQUEST_V4};
  assert.ok(payload.catalogReference,'Missing saved catalog reference.');
  assertNoGradingInputs({profile:saved.profile,context:saved.context});
  const complete=completeJevDraft(payload),body=jevRequest(payload),decoded=decodeLosslessState(body.state);
  assert.deepEqual(decoded,clean(complete.state),'Complete source state failed round trip.');
  assert.deepEqual(body.questions,complete.questions,'Typed questions changed.');
  assert.equal(body.model,complete.model,'Model changed.');
  assert.deepEqual(decoded.artistContext?.savedCatalogContext,clean(saved.context));
  if(saved.context){
    assert.deepEqual(boundedArtistContext(decoded.artistContext.savedCatalogContext),
      boundedArtistContext(saved.context),'Reconstructed v3 context differs.');
  }
  const candidate=decoded.candidates[0];
  assert.deepEqual(candidate.savedDiscoveryEvidence,clean(saved.profile.discoveryEvidence??[]));
  for(const field of ['reference','candidate']){
    const reconstructed={...candidate[field]};
    if(!Object.hasOwn(saved.profile.identityComparison[field],'musicLinkPath'))delete reconstructed.musicLinkPath;
    assert.deepEqual(reconstructed,clean(saved.profile.identityComparison[field]));
  }
  const connections=saved.profile.identityComparison.catalogConnections;
  if(connections!==undefined)assert.deepEqual(candidate.catalogConnections,clean(connections));
  const byteCount=bytes(body);
  // Exact UTF-8 bytes include the decoding instructions, dictionary, questions,
  // model and all source records. An oversized body is saved as held, not sent.
  assert.equal(new TextEncoder().encode(encode(body)).length,byteCount);
  return {body,bytes:byteCount,uncompactedBytes:bytes(complete),sha256:hash(encode(body)),
    contextEqual:true,sourceStateEqual:true,sent:false,
    status:byteCount<=REQUEST_BYTE_CAP?'fits_unsent':'held_oversized',
    hold:byteCount<=REQUEST_BYTE_CAP?'':`Complete request is ${byteCount} UTF-8 bytes; unchanged cap is ${REQUEST_BYTE_CAP}. No evidence omitted.`};
}

async function treeHashes(dir){
  const files=[];
  const visit=async relative=>{
    for(const entry of (await fs.readdir(path.join(dir,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const name=path.join(relative,entry.name);
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile())files.push({file:name,sha256:hash(await fs.readFile(path.join(dir,name)))});
      else throw Error('Non-regular archive entry; refusing ambiguous preservation check.');
    }
  };
  await visit('');return files;
}

export async function auditLosslessRequests(batchDir,outputDir,{requestSerialization}={}){
  assert.equal(requestSerialization,LOSSLESS_REQUEST_V4,'Explicit versioned serialization option required.');
  const relative=path.relative(path.resolve(batchDir),path.resolve(outputDir));
  assert.ok(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative),
    'Write new drafts outside the frozen batch.');
  const before=await treeHashes(batchDir),inputs=new Map(before.map(x=>[x.file,x.sha256]));
  const read=async f=>JSON.parse(await fs.readFile(path.join(batchDir,f),'utf8'));
  const scope=await read('scope.json'),receipt=await read('receipt.json'),source=await read('source-rows.json');
  assert.equal(hash(encode(scope)),receipt.scopeSha256);
  assert.equal(hash(encode(source)),receipt.sourceRowsSha256);
  const oldAudit=await read('shared-rule-fix-offline/summary.json');
  for(const input of oldAudit.inputs)assert.equal(inputs.get(input.file),input.sha256,`Changed saved input: ${input.file}`);
  const results=(await fs.readFile(path.join(batchDir,'execution-paid/results.jsonl'),'utf8')).split('\n').filter(s=>s.trim()).map(JSON.parse);
  const requestMap=new Map(scope.requests.map(r=>[r.key,r])),sourceMap=new Map(source.filter(r=>r.key).map(r=>[r.key,r]));
  assert.equal(requestMap.size,scope.requests.length);assert.equal(sourceMap.size,source.filter(r=>r.key).length);
  assert.equal(results.length,oldAudit.unchangedRecordedDecisions);
  assert.equal(results.length,source.filter(r=>r.status==='prepared').length,'Prepared rows missing recorded results.');
  const rows=[],drafts=[],seen=new Set();
  for(const result of results){
    assert.ok(!seen.has(result.key),'Duplicate saved result.');seen.add(result.key);
    const saved=sourceMap.get(result.key),request=requestMap.get(result.key);
    assert.ok(saved&&request&&saved.status==='prepared','Missing saved candidate or request.');
    assert.equal(String(saved.profileId),String(request.profileId));
    assert.equal(saved.role,result.role);assert.equal(saved.role,request.role);
    assert.equal(saved.url,result.instagramUrl);
    const packet=await read(`execution-paid/responses/${result.key}.json`);
    assert.equal(packet.status,200);
    assert.equal(packet.requestBodySha256,request.sha256);
    assert.equal(hash(encode(packet.decisionRequest)),request.sha256);
    assert.equal(packet.data.model,scope.expectedModel);assert.equal(result.model,scope.expectedModel);
    assert.equal(packet.data.answers.candidate_0_same_identity.noul,result.score);
    assert.equal(packet.data.answers.candidate_0_verdict.choice,result.verdict);
    const frozenFile=`shared-rule-fix-offline/unsent-drafts/${result.key}.json`;
    const historicalHeld=!inputs.has(frozenFile);
    // Prove that the default v3 path still produces exactly the frozen bytes.
    let legacyBody,legacyHold='';
    try{
      const fitted=fitArtistContext({artist:saved.artist,catalogReference:catalogReferences(saved.player)[0],
        profiles:[saved.profile],artistContext:saved.context,ownershipRubric:IDENTITY_CONTEXT_RUBRIC},REQUEST_BYTE_CAP);
      legacyBody=jevRequest({...fitted,compactEvidence:true});
      if(bytes(legacyBody)>REQUEST_BYTE_CAP)throw Error('Complete request exceeds unchanged 6000-byte cap.');
    }catch(e){legacyHold=e.message;}
    if(historicalHeld)assert.ok(legacyHold,'Historical held case unexpectedly changed.');
    else{
      assert.equal(legacyHold,'','Frozen v3 draft no longer builds.');
      const frozen=await read(frozenFile);
      assert.equal(hash(encode(frozen.body)),frozen.sha256);
      assert.equal(bytes(frozen.body),frozen.bytes);
      assert.equal(encode(legacyBody),encode(frozen.body),'Frozen v3 request bytes changed.');
    }
    // Do not catch round-trip failures as ordinary holds. They must fail the audit.
    const draft=losslessDraftFor(saved);
    drafts.push({key:result.key,...draft});
    rows.push({key:result.key,artist:saved.artist,profileId:String(saved.profileId),role:saved.role,
      historicalV3Status:historicalHeld?'held':'fits_unsent',historicalV3Hold:legacyHold,
      originalRequestSha256:request.sha256,bytes:draft.bytes,uncompactedBytes:draft.uncompactedBytes,
      encoding:draft.body.state.encoding,
      savedBytes:draft.uncompactedBytes-draft.bytes,status:draft.status,hold:draft.hold,
      reconstructedContextEqual:true,reconstructedSourceStateEqual:true,sha256:draft.sha256,
      catalogItems:saved.context?.items?.length??0,discoveryRecords:saved.profile.discoveryEvidence?.length??0,
      recordedScore:result.score,recordedVerdict:result.verdict,freshVerification:false});
  }
  const missing=source.filter(s=>s.status!=='prepared').map(s=>({key:s.key??null,profileId:String(s.profileId),
    artist:s.artist,role:s.role,status:'held_missing_saved_evidence',reason:s.reason??'Missing saved account evidence.',
    bytes:null,reconstructedContextEqual:null,freshVerification:false}));
  const pairedFile='contextual-paired-test-prepared/prepared-manifest.json';
  let paired=null;
  if(inputs.has(pairedFile)){
    const manifest=await read(pairedFile);
    assert.equal(manifest.sourceRowsSha256,receipt.sourceRowsSha256);
    assert.equal(manifest.sourceScopeSha256,receipt.scopeSha256);
    for(const r of manifest.requests){assert.equal(hash(encode(r.body)),r.sha256);assert.equal(bytes(r.body),r.bytes);}
    const excluded=[...new Set(manifest.held.map(r=>r.key))];
    paired={frozenRequests:manifest.requests.length,exclusionOccurrences:manifest.held.length,
      distinctExcludedCases:excluded.length,excludedCases:excluded.map(key=>{
        const row=rows.find(r=>r.key===key);assert.ok(row,'Paired exclusion is outside saved cohort.');
        return {key,status:row.status,bytes:row.bytes,hold:row.hold};
      }),interpretation:'Existing paired inputs are unchanged. No new paired selection or model comparison was performed.'};
  }
  const held=rows.filter(r=>r.status==='held_oversized'),previouslyHeld=rows.filter(r=>r.historicalV3Status==='held');
  assert.equal(previouslyHeld.length,oldAudit.requestPreparationHolds);
  assert.equal(rows.length-previouslyHeld.length,oldAudit.completeUnsentDrafts);
  const after=await treeHashes(batchDir);assert.deepEqual(after,before,'Frozen batch changed during audit.');
  const codeHashes={};
  for(const name of ['instagram-lossless-request','instagram-lossless-request-audit','instagram-pilot-live-transport',
    'instagram-ownership-rubric','instagram-contextual-identity-check','instagram-contextual-test-prep','instagram-frozen-jev'])
    codeHashes[name+'.mjs']=hash(await fs.readFile(new URL('./'+name+'.mjs',import.meta.url)));
  const summary={version:LOSSLESS_REQUEST_V4,rubric:IDENTITY_CONTEXT_RUBRIC,preparationOnly:true,
    artistRecords:scope.artists.length,sourceRows:source.length,savedRequests:rows.length,
    reconstructedContextEqual:rows.length,reconstructedSourceStateEqual:rows.length,
    completeUnsentDrafts:rows.length-held.length,oversizedHolds:held.length,missingSavedEvidenceHolds:missing.length,
    historicalV3Fits:oldAudit.completeUnsentDrafts,historicalV3Holds:previouslyHeld.length,
    historicalHoldsNowFit:previouslyHeld.filter(r=>r.status==='fits_unsent').length,
    historicalHoldsStillHeld:previouslyHeld.filter(r=>r.status==='held_oversized').length,
    historicalFitsNowHeld:held.filter(r=>r.historicalV3Status==='fits_unsent').length,
    byteCounts:{minimum:Math.min(...rows.map(r=>r.bytes)),maximum:Math.max(...rows.map(r=>r.bytes)),
      totalUncompacted:rows.reduce((n,r)=>n+r.uncompactedBytes,0),totalSerialized:rows.reduce((n,r)=>n+r.bytes,0),
      smallerRequests:rows.filter(r=>r.savedBytes>0).length,
      sameEvidenceUncompactedFits:rows.filter(r=>r.uncompactedBytes<=REQUEST_BYTE_CAP).length,
      sameEvidenceFitsGained:rows.filter(r=>r.uncompactedBytes>REQUEST_BYTE_CAP&&r.bytes<=REQUEST_BYTE_CAP).length,
      sameEvidenceFitsLostToFormatOverhead:rows.filter(r=>r.uncompactedBytes<=REQUEST_BYTE_CAP&&r.bytes>REQUEST_BYTE_CAP).length},
    encodings:{plain:rows.filter(r=>r.encoding==='plain').length,tables:rows.filter(r=>r.encoding==='tables').length},
    requestByteCap:REQUEST_BYTE_CAP,pairedPreparation:paired,
    frozenFilesChecked:before.length,frozenArchiveUnchanged:true,defaultV3FrozenDraftsEqual:oldAudit.completeUnsentDrafts,
    frozenOriginalRequestHashesVerified:rows.length,
    paidCalls:0,metadataFetches:0,discoveryCalls:0,liveAcceptanceChanges:0,spendingLimitChanges:0,tokenLimitChanges:0,
    executionAllowed:false,productionApproved:false,accuracyCalibrated:false,
    recommendation:'Not sufficient to unblock the original oversized holds. Keep experimental and offline-only; do not authorize live use or substitute reduced evidence.',
    interpretation:'Structural compaction only; exact source round trip is not proof that a model interprets the tables correctly. The complete-source contract also retains all saved discovery records and untruncated source metadata, unlike bounded v3 summaries. Old model answers are historical only and are not answers to these drafts. Oversized and missing-evidence cases remain held. No spending approval is inherited.',
    originalAuditSha256:inputs.get('shared-rule-fix-offline/summary.json'),codeHashes,inputs:before};
  await fs.mkdir(outputDir,{recursive:false});
  const write=(file,data)=>fs.writeFile(path.join(outputDir,file),data,{flag:'wx'});
  await write('summary.json',JSON.stringify(summary,null,2));
  await write('request-audit.jsonl',[...rows,...missing].map(encode).join('\n')+'\n');
  await write('unsent-drafts.jsonl',drafts.map(encode).join('\n')+'\n');
  await write('held-cases.json',JSON.stringify([...held,...missing],null,2));
  await write('report.md',`# Lossless saved-evidence request investigation\n\n`+
    `- ${scope.artists.length} artists; ${rows.length} saved requests checked without network calls.\n`+
    `- Exact reconstructed context and source-state equality: ${rows.length}/${rows.length}.\n`+
    `- Complete drafts at or below 6,000 UTF-8 bytes: ${rows.length-held.length}; oversized holds: ${held.length}.\n`+
    `- Original ${previouslyHeld.length} v3 holds: ${summary.historicalHoldsNowFit} now fit; ${summary.historicalHoldsStillHeld} still held.\n`+
    `- Previously fitting v3 cases now held under the complete-source contract: ${summary.historicalFitsNowHeld}.\n`+
    `- Missing saved evidence: ${missing.length} additional held source rows (not counted as fitting requests).\n`+
    `- Byte range: ${summary.byteCounts.minimum}–${summary.byteCounts.maximum}. Full dictionaries and decoding instructions count toward the cap.\n`+
    `- Same complete evidence without the versioned format fits in ${summary.byteCounts.sameEvidenceUncompactedFits} cases; `+
    `compaction gains ${summary.byteCounts.sameEvidenceFitsGained} fitting requests and format overhead loses ${summary.byteCounts.sameEvidenceFitsLostToFormatOverhead}.\n`+
    `- ${before.length} frozen files unchanged; ${oldAudit.completeUnsentDrafts} default v3 draft bodies exactly reproduce their saved bytes.\n\n`+
    `${summary.interpretation}\n\n${summary.recommendation}\n\n`+
    `Every measured request, including oversized cases, is in unsent-drafts.jsonl. `+
    `request-audit.jsonl contains per-case counts, hashes and holds. held-cases.json lists all unresolved cases.\n`);
  return summary;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [batch,output,flag]=process.argv.slice(2);
  if(!batch||!output||flag!=='--lossless-v4')throw Error('Usage: lossless-request-audit <frozen-batch> <new-output> --lossless-v4');
  const summary=await auditLosslessRequests(batch,output,{requestSerialization:LOSSLESS_REQUEST_V4});
  console.log(JSON.stringify({...summary,inputs:undefined},null,2));
}
