// Local preparation only. This module contains no provider dispatcher.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {catalogReferences,catalogConnectionEvidence,CORROBORATED_POLICY,IDENTITY_CONTEXT_POLICY} from './musician-instagram-matching.mjs';
import {fitArtistContext,jevRequest,boundedArtistContext} from './instagram-pilot-live-transport.mjs';
import {CORROBORATED_RUBRIC,IDENTITY_CONTEXT_RUBRIC} from './instagram-ownership-rubric.mjs';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const encode=v=>JSON.stringify(v);

export function contextualTestPair(target,original){
  assertNoGradingInputs({player:target.player,profile:original,context:target.context});
  const reference=catalogReferences(target.player)[0];
  assert.ok(reference&&reference.url===target.profile.identityComparison.reference.url,'Unbound target reference.');
  const profile=structuredClone(original);
  profile.identityComparison.reference=structuredClone(target.profile.identityComparison.reference);
  profile.identityComparison.status='uncertain';profile.identityComparison.score=0;profile.identityComparison.reasons=[];
  delete profile.jevVerification;
  profile.identityComparison.catalogConnections=catalogConnectionEvidence(profile.identityComparison.candidate,target.player);
  const requests=[];
  for(const [variant,rubric] of [['current',CORROBORATED_RUBRIC],['fuller_metadata',IDENTITY_CONTEXT_RUBRIC]]){
    const payload=fitArtistContext({artist:target.artist,catalogReference:reference,profiles:[profile],
      artistContext:target.context,ownershipRubric:rubric},6000);
    assert.ok(!payload.contextDelivery?.omittedItems&&!payload.contextDelivery?.omittedPostRecords,'Evidence would be omitted.');
    const body=jevRequest({...payload,compactEvidence:true}),text=encode(body),bytes=Buffer.byteLength(text);
    assert.ok(bytes<=6000,'Complete request exceeds 6000 bytes.');
    if(variant==='fuller_metadata'){
      const raw=body.state.artistContext?.savedCatalogContext;
      const decoded=raw?.items.map(({sourceIndex,kind,text})=>({...raw.sources[sourceIndex],kind,text}))??[];
      assert.deepEqual(JSON.parse(encode(decoded)),JSON.parse(encode(boundedArtistContext(target.context)?.items??[])));
    }
    const forbid=value=>{
      if(!value||typeof value!=='object')return;
      for(const [key,child] of Object.entries(value)){
        assert.ok(!['jevVerification','identityComparisonStatus','identityComparisonReasons'].includes(key),'Prior judgment leaked.');
        forbid(child);
      }
    };
    assertNoGradingInputs(body);forbid(body);
    requests.push({variant,rubric,body,sha256:hash(text),bytes});
  }
  return requests;
}

export async function prepareContextualTest(batchDir,outputDir){
  const read=async name=>JSON.parse(await fs.readFile(path.join(batchDir,name),'utf8'));
  const scope=await read('scope.json'),receipt=await read('receipt.json'),source=await read('source-rows.json');
  assert.equal(hash(encode(scope)),receipt.scopeSha256);assert.equal(hash(encode(source)),receipt.sourceRowsSha256);
  const audit=await read('shared-rule-fix-offline/summary.json');
  for(const [name,expected] of Object.entries(audit.codeHashes))
    assert.equal(hash(await fs.readFile(new URL('./'+name,import.meta.url))),expected,'Offline audit code changed.');
  const resultBytes=await fs.readFile(path.join(batchDir,'execution-paid/results.jsonl'));
  assert.equal(hash(resultBytes),audit.inputs.find(i=>i.file==='execution-paid/results.jsonl')?.sha256);
  const results=new Map(resultBytes.toString('utf8').split('\n').filter(s=>s.trim()).map(s=>{const r=JSON.parse(s);return[r.key,r];}));
  const ordered=source.filter(s=>s.role==='candidate'&&s.status==='prepared'&&s.context?.items?.length&&
    ['likely','verified'].includes(results.get(s.key)?.verdict)).sort((a,b)=>a.key.localeCompare(b.key));
  const picked=[],held=[],seen=new Set(),urls=new Set();
  const buckets=[
    ['name_or_alias',s=>results.get(s.key)?.reason==='account_self_identification_missing'],
    ['label_affiliation',s=>results.get(s.key)?.reason==='related_entity_or_fan'],
    ['remaining_ownership_evidence',s=>results.get(s.key)?.reason==='insufficient_distinctive_ownership_corroboration'],
  ];
  for(const [bucket,match] of [...buckets,['additional_saved_evidence',()=>true]]){
    let selected=0;
    for(const s of ordered){
      if(picked.length===6)break;
      if(seen.has(String(s.profileId))||urls.has(s.url)||!match(s)||selected===2)continue;
      try{
        const pair=contextualTestPair(s,s.profile);
        picked.push({source:s,bucket,pair});seen.add(String(s.profileId));urls.add(s.url);selected++;
      }catch(e){held.push({key:s.key,reason:e.message});}
    }
  }
  assert.equal(picked.length,6,'Not enough distinct, complete artists. No reduced test was silently substituted.');
  const controlPool=source.filter(s=>s.role==='control'&&s.status==='prepared'&&!seen.has(String(s.sourceProfileId))
    &&!urls.has(s.url)&&!picked.some(t=>t.source.artist===s.sourceArtist)).sort((a,b)=>a.key.localeCompare(b.key));
  const controls=[],controlUrls=new Set(),donors=new Set();
  // First cover distinct donor artists; then fill from distinct accounts.
  for(const requireNewDonor of [true,false]){
    for(const s of controlPool){
      if(controls.length===6)break;
      if(controlUrls.has(s.url)||(requireNewDonor&&donors.has(String(s.sourceProfileId))))continue;
      const target=picked[controls.length].source;
      if(catalogReferences(target.player).some(r=>r.url===s.url))continue;
      try{controls.push({source:s,target,pair:contextualTestPair(target,s.profile)});
        controlUrls.add(s.url);donors.add(String(s.sourceProfileId));
      }catch(e){held.push({key:s.key,reason:e.message});}
    }
  }
  assert.equal(controls.length,6,'Not enough distinct, complete comparison accounts.');
  const requests=[];
  for(const [role,items] of [['candidate',picked],['control',controls]]){
    for(const [index,item] of items.entries()){
      const target=item.target??item.source;
      for(const r of item.pair)requests.push({...r,key:`${role}-${index+1}-${r.variant}`,
        profileId:String(target.profileId),artist:target.artist,instagramUrl:item.source.url,role,
        sourceKey:item.source.key,sourceProfileId:item.source.sourceProfileId??item.source.profileId});
    }
  }
  const manifest={version:1,preparationOnly:true,authorization:{approved:false,requiresNewApproval:true,
    requestedMaximumSpendCents:48,conservativeCentsPerRequest:2,existingBudgetReuseAllowed:false},
    sourceScopeSha256:receipt.scopeSha256,sourceRowsSha256:receipt.sourceRowsSha256,
    auditSha256:hash(encode(audit)),codeHashes:{...audit.codeHashes,
      'instagram-contextual-test-prep.mjs':hash(await fs.readFile(fileURLToPath(import.meta.url)))},
    expectedModel:scope.expectedModel,requests,artists:6,distinctControlAccounts:6,controlSourceArtists:donors.size,
    policyByVariant:{current:CORROBORATED_POLICY,fuller_metadata:IDENTITY_CONTEXT_POLICY},
    comparison:'Fresh current-v2 versus fuller-metadata/v3 requests. Both metadata delivery and rubric change; this does not isolate a single change. Neither arm is an archived response replay.',
    selection:picked.map(t=>({profileId:String(t.source.profileId),artist:t.source.artist,url:t.source.url,bucket:t.bucket})),
    held,controlsAreReviewedLabels:false,
    safeguards:{newPaidCalls:0,discoveryCalls:0,metadataFetches:0,liveLinkWrites:0,automaticRetries:0,
      productionApproved:false,requestByteCap:6000,concurrency:1,stopOnModelChange:true,stopOnControlSupport:true,
      executionRequiresSeparateApproval:true,executionRequiresDurableNonReplayableAdmission:true}};
  assert.equal(requests.length,24);
  await fs.mkdir(outputDir,{recursive:false});
  await fs.writeFile(path.join(outputDir,'prepared-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  const summary={artists:6,distinctControlAccounts:6,controlSourceArtists:donors.size,requests:24,
    maximumSpendUsd:0.48,paidCalls:0,executionAllowed:false,manifestSha256:hash(encode(manifest)),
    selection:manifest.selection,excludedOversizedOrIncompleteCases:held.length};
  await fs.writeFile(path.join(outputDir,'preparation-summary.json'),JSON.stringify(summary,null,2),{flag:'wx'});
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [batch,output]=process.argv.slice(2);
  if(!batch||!output)throw Error('Usage: contextual-test-prep <frozen-batch> <new-output>');
  console.log(JSON.stringify(await prepareContextualTest(batch,output),null,2));
}
