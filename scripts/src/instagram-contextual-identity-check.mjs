// Frozen evidence + original recorded answers only. No providers or writes to
// original archives. New-rubric request drafts are never sent.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assessInstagramCandidates,CORROBORATED_POLICY,IDENTITY_CONTEXT_POLICY,catalogReferences} from './musician-instagram-matching.mjs';
import {fitArtistContext,jevRequest,boundedArtistContext} from './instagram-pilot-live-transport.mjs';
import {IDENTITY_CONTEXT_RUBRIC} from './instagram-ownership-rubric.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const cell=value=>{
  const text=String(value??'');
  return '"'+(/^\s*[=+@-]/u.test(text)?"'"+text:text).replaceAll('"','""')+'"';
};
const csv=rows=>{
  const columns=Object.keys(rows[0]??{});
  return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
};
export async function checkContextualIdentity(batchDir,outputDir){
  const inputs=[];
  const read=async f=>{const b=await fs.readFile(path.join(batchDir,f));inputs.push({file:f,sha256:hash(b)});return JSON.parse(b);};
  const scope=await read('scope.json'),receipt=await read('receipt.json'),source=await read('source-rows.json');
  assert.equal(hash(JSON.stringify(scope)),receipt.scopeSha256);
  assert.equal(hash(JSON.stringify(source)),receipt.sourceRowsSha256);
  const lines=await fs.readFile(path.join(batchDir,'execution-paid/results.jsonl'));
  inputs.push({file:'execution-paid/results.jsonl',sha256:hash(lines)});
  const results=lines.toString('utf8').split('\n').filter(s=>s.trim()).map(JSON.parse);
  const originals=await read('execution-paid/artist-outcomes.json');
  const requestMap=new Map(scope.requests.map(r=>[r.key,r])),sources=new Map(source.filter(r=>r.key).map(r=>[r.key,r]));
  const roster=new Map(scope.artists.map(a=>[String(a.profile_id),a])),seen=new Set();
  const candidateOwners=new Map();
  for(const r of source.filter(r=>r.role==='candidate'&&r.url)){
    if(!candidateOwners.has(r.url))candidateOwners.set(r.url,new Set());
    candidateOwners.get(r.url).add(String(r.profileId));
  }
  const rows=[],drafts=[],changes={},draftHolds={};
  for(const result of results){
    const r=requestMap.get(result.key),saved=sources.get(result.key);
    assert.ok(r&&saved,'Missing saved evidence.');
    assert.ok(!seen.has(result.key),'Duplicate archived answer.');seen.add(result.key);
    assert.equal(String(r.profileId),String(saved.profileId));assert.equal(r.role,saved.role);assert.equal(result.role,saved.role);
    assert.deepEqual(saved.player,roster.get(String(saved.profileId)),'Saved catalog artist changed.');
    const packet=await read(`execution-paid/responses/${result.key}.json`);
    assert.equal(packet.status,200);assert.equal(hash(JSON.stringify(packet.decisionRequest)),r.sha256);
    assert.equal(packet.requestBodySha256,r.sha256);
    assert.equal(packet.data.model,result.model);assert.equal(packet.data.model,scope.expectedModel);
    assert.equal(packet.data.answers.candidate_0_same_identity.noul,result.score);
    assert.equal(packet.data.answers.candidate_0_verdict.choice,result.verdict);
    assert.equal(packet.decisionRequest.state.artist,saved.artist);
    assert.equal(packet.decisionRequest.state.candidates[0].url,result.instagramUrl);
    const p=structuredClone(saved.profile);
    p.jevVerification={verdict:result.verdict,sameIdentityProbability:result.score};
    const raw={methodsUsed:[{method:'serper',status:'used'}],profiles:[p]};
    const context={profileId:String(saved.profileId),metadata:saved.context};
    const before=assessInstagramCandidates(raw,saved.player,{policy:CORROBORATED_POLICY,mode:'offline',context});
    const after=assessInstagramCandidates(raw,saved.player,{policy:IDENTITY_CONTEXT_POLICY,mode:'offline',context});
    const shared=result.role==='candidate'&&(candidateOwners.get(result.instagramUrl)?.size??0)>1;
    const beforeSupport=before.simulationUrls.length>0&&!shared,afterSupport=after.simulationUrls.length>0&&!shared;
    assert.equal(beforeSupport,result.researchPolicySupport,'Historical policy changed; comparison is not reproducible.');
    const a=after.candidates[0],reason=shared?'shared_candidate_requires_ownership_review':a.reason;
    const change=`${result.role}:${beforeSupport?'supported':'held'}->${afterSupport?'supported':'held'}`;
    changes[change]=(changes[change]??0)+1;
    let draftBytes=null,draftSha=null,draftHold='',catalogItems=0;
    try{
      const fitted=fitArtistContext({artist:saved.artist,catalogReference:catalogReferences(saved.player)[0],
        profiles:[p],artistContext:saved.context,ownershipRubric:IDENTITY_CONTEXT_RUBRIC},6000);
      const body=jevRequest({...fitted,compactEvidence:true}),bytes=Buffer.byteLength(JSON.stringify(body));
      if(bytes>6000)throw Error('Complete request exceeds unchanged 6000-byte cap.');
      const context=body.state.artistContext?.savedCatalogContext;
      const decoded=context?.items.map(({sourceIndex,kind,text})=>({...context.sources[sourceIndex],kind,text}))??[];
      const original=boundedArtistContext(saved.context)?.items??[];
      assert.deepEqual(JSON.parse(JSON.stringify(decoded)),JSON.parse(JSON.stringify(original)),
        'Raw saved context changed or disappeared.');
      catalogItems=decoded.length;draftBytes=bytes;draftSha=hash(JSON.stringify(body));
      drafts.push({key:result.key,body,sha256:draftSha,bytes,sent:false});
    }catch(e){draftHold=e.message;draftHolds[draftHold]=(draftHolds[draftHold]??0)+1;}
    rows.push({'Artist':saved.artist,'Profile ID':String(saved.profileId),'Role':result.role,'Instagram':result.instagramUrl,
      'Recorded model score':result.score,'Recorded model verdict':result.verdict,'Previous research support':beforeSupport,
      'New offline policy support':afterSupport,'Previous reason':result.reason,'New reason':reason,'New evidence route':a.route,
      'New source evidence':JSON.stringify(a.evidence??[]),'Shared-handle hold':shared,
      'Complete new request bytes':draftBytes,'Complete raw context items in unsent draft':catalogItems,
      'Unsent draft SHA256':draftSha,'New request preparation hold':draftHold,
      'Original request SHA256':r.sha256,'New paid calls':0,'Live link changes':0});
  }
  for(const r of source.filter(r=>r.status!=='prepared'))rows.push({'Artist':r.artist,'Profile ID':String(r.profileId),
    'Role':r.role,'Instagram':r.url??'','Recorded model score':'','Recorded model verdict':'',
    'Previous research support':false,'New offline policy support':false,'Previous reason':r.reason,
    'New reason':r.reason,'New evidence route':'uninspected','New source evidence':'[]',
    'Shared-handle hold':false,'Complete new request bytes':null,'Complete raw context items in unsent draft':0,
    'Unsent draft SHA256':null,'New request preparation hold':'Missing prior account evidence; not replaced or fetched.',
    'Original request SHA256':null,'New paid calls':0,'Live link changes':0});
  const artists=originals.map(a=>{
    const rr=rows.filter(r=>r.Role==='candidate'&&r['Profile ID']===String(a.profileId));
    const supported=rr.filter(r=>r['New offline policy support']);
    return {'Artist':a.artist,'Profile ID':String(a.profileId),'Previous outcome':a.status,
      'New offline outcome':supported.length?'supported_for_review':a.status==='supported_for_review'?'needs_review':a.status,
      'Previously supported Instagram':a.supportedUrls.join('; '),
      'New offline supported Instagram':supported.map(r=>r.Instagram).join('; '),
      'Supported candidates with complete unsent drafts':supported.filter(r=>!r['New request preparation hold']).length,
      'Newly supported in offline replay':a.status!=='supported_for_review'&&supported.length>0,
      'Fresh verification performed':false,'Live links changed':false};
  });
  const codeHashes={};
  for(const name of ['instagram-contextual-identity-check','instagram-corroborated-policy','musician-instagram-matching',
    'instagram-ownership-rubric','instagram-pilot-live-transport','instagram-context-signals','instagram-post-signals']){
    codeHashes[name+'.mjs']=hash(await fs.readFile(new URL('./'+name+'.mjs',import.meta.url)));
  }
  const summary={policy:IDENTITY_CONTEXT_POLICY,rubric:IDENTITY_CONTEXT_RUBRIC,artistRecords:artists.length,
    originalSupportedArtists:originals.filter(a=>a.status==='supported_for_review').length,
    offlineSupportedArtists:artists.filter(a=>a['New offline supported Instagram']).length,
    newlySupportedArtists:artists.filter(a=>a['Newly supported in offline replay']).length,
    regressedArtists:artists.filter(a=>a['Previous outcome']==='supported_for_review'&&!a['New offline supported Instagram']).length,
    controls:rows.filter(r=>r.Role==='control').length,
    offlineSupportedControls:rows.filter(r=>r.Role==='control'&&r['New offline policy support']).length,
    unchangedRecordedDecisions:results.length,changes,
    completeUnsentDrafts:drafts.length,requestPreparationHolds:results.length-drafts.length,draftHolds,
    newPaidCalls:0,liveLinkChanges:0,productionApproved:false,accuracyCalibrated:false,
    interpretation:'Counterfactual policy replay of original model outputs, not fresh verification. New rubric/raw-context inputs are unsent drafts; old answers cannot be attributed to them. Missing saved evidence is still held. Controls are synthetic cross-artist comparisons, not reviewed ownership labels.',
    codeHashes,inputs};
  await fs.mkdir(outputDir,{recursive:false});await fs.mkdir(path.join(outputDir,'unsent-drafts'));
  for(const d of drafts)await fs.writeFile(path.join(outputDir,'unsent-drafts',d.key+'.json'),JSON.stringify(d),{flag:'wx'});
  for(const [file,data] of [['summary.json',JSON.stringify(summary,null,2)],['candidate-impact.csv',csv(rows)],['latest-500-artists.csv',csv(artists)]])
    await fs.writeFile(path.join(outputDir,file),data,{flag:'wx'});
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [batch,output]=process.argv.slice(2);
  if(!batch||!output)throw Error('Usage: contextual-identity-check <saved-batch> <new-output>');
  const result=await checkContextualIdentity(batch,output);
  console.log(JSON.stringify({...result,inputs:`${result.inputs.length} frozen input hashes`},null,2));
}
