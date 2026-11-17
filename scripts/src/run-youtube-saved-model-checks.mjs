import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {savedModelPlan,approveSavedModels,savedModelResult} from './youtube-saved-verification-execution.mjs';
import {savedModelGate,savedModelClaims} from './youtube-saved-model-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
export const readSavedJson=async f=>JSON.parse(await fs.readFile(f));
export async function modelQuote(fetchImpl=fetch){
  const endpoint='https://openrouter.ai/api/v1/models?output_modalities=decisions';
  const r=await fetchImpl(endpoint,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,200,'Public pricing metadata unavailable');
  const found=(await r.json()).data.filter(m=>m.id==='typesafe/jev-1.13');assert.equal(found.length,1);
  const m=found[0];return {endpoint,id:m.id,observedAt:new Date().toISOString(),
    promptUsdPerToken:m.pricing.prompt,completionUsdPerToken:m.pricing.completion,contextTokens:m.context_length};
}
export function checkModelQuote(current,frozen){
  assert.equal(current.id,frozen.id);
  assert.ok(Number(current.promptUsdPerToken)>0&&Number(current.promptUsdPerToken)<=Number(frozen.promptUsdPerToken),
    'Model input pricing increased');
  assert.equal(Number(current.completionUsdPerToken),0);assert.ok(current.contextTokens>=frozen.contextTokens);
}
export function liveSavedModelCatalog(plan,{query=select}={}){
  return async op=>{
    const selection=plan.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);assert.ok(selection);
    const rows=await catalogReadWithOneTimeoutRetry(query,identityEligibilitySql([selection]));
    assert.equal(rows.length,1,'Artist no longer currently eligible');
    const tier=Number(rows[0].tier);assert.ok([1,2,3,4,5].includes(tier));
    assertCurrentIdentityEligibility([{...selection,tier}],rows);
    const claims=savedModelClaims(op);
    const linked=await catalogLinkedYoutubeClaims(claims,query);
    assertNoNewIdentityClaims(claims,linked.map(r=>({alias:returnedYoutubeUrl(r.account_url)??'',
      channelId:returnedYoutubeUrl(r.account_url)?.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
      profileId:String(r.profile_id),cmArtist:String(r.cm_artist)})));
  };
}
export async function savedModelsFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed executor');
  deepFreeze(plan);assert.deepEqual(savedModelPlan(plan),plan);
  assert.deepEqual(await readSavedJson(root+'/plan.json'),plan);
  const files={[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json')),
    [plan.sourceProposalPath]:plan.sourceProposalFileSha256,...extras};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const check=frozenFileVerifier(files);await check();return check;
}
export function verifySavedModelSource(plan,source){
  assert.equal(digest(source),plan.sourceProposalSha256);
  assert.equal(source.executable,false);assert.equal(source.modelCallsExecuted,0);
  for(const op of plan.operations)assert.deepEqual(source.operations.find(o=>o.key===op.key),op);
}
export async function executeSavedModels({root,plan,approval,gate,credential,assertFrozen,fetchImpl=fetch,
  checkPrice=async()=>checkModelQuote(await modelQuote(),plan.pricing),
  validateApproval=approveSavedModels,parseResult=savedModelResult}){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');assert.deepEqual(validateApproval(plan,approval),approval);
  assert.ok(typeof credential==='string'&&credential.length);
  await assertFrozen();await checkPrice();
  // One shot, including pre-admission failures. Never rerun an existing launch.
  await durableIdentityFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const results=[];
  for(const group of plan.groups){
    await assertFrozen();await checkPrice();
    const folder=root+'/part-'+(group.groupIndex+1);await fs.mkdir(folder);await fs.mkdir(folder+'/receipts');
    await durableIdentityFile(folder+'/plan.json',JSON.stringify(group));
    let started=false;
    try{
      await gate.start(group);started=true;
      for(const op of group.operations){
        await assertFrozen();await gate.admit(group,op);
        const response=await fetchImpl(op.request.url,{method:'POST',redirect:'error',
          signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json'},
          body:JSON.stringify(op.request.body)});
        const chunks=[];let length=0;
        if(response.body)for await(const chunk of response.body){length+=chunk.length;assert.ok(length<=2*1024*1024);chunks.push(chunk);}
        const raw=Buffer.concat(chunks),rawPath='receipts/'+digest(op.key)+'.raw';
        await durableIdentityFile(folder+'/'+rawPath,raw);
        const receipt={runId:group.id,parentId:plan.id,planSha256:digest(group),approvalSha256:digest(approval),
          operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,kind:'model',
          request:op.request,inputSha256:op.inputSha256,status:response.status,capturedAt:new Date().toISOString(),
          rawPath,rawBodySha256:digest(raw)};
        await durableIdentityFile(folder+'/receipts/'+digest(op.key)+'.json',JSON.stringify(receipt));
        const result=parseResult(plan,op,receipt,raw);
        await assertFrozen();await gate.returned(group,op,receipt,raw);
        results.push(result);
        console.log(JSON.stringify({phase:'artist_verification',completed:results.length,total:plan.operations.length}));
      }
      await gate.finish(group,'completed');started=false;
      await durableIdentityFile(folder+'/results.json',JSON.stringify(results.slice(-group.operations.length)));
    }catch(error){
      if(started)try{await gate.finish(group,'stopped');}catch(e){throw new AggregateError([error,e],'Stopped; saved admissions remain authoritative');}
      throw error;
    }
  }
  await durableIdentityFile(root+'/results.json',JSON.stringify(results,null,2));
  const counts={};for(const r of results)counts[r.decision.status]=(counts[r.decision.status]??0)+1;
  const summary={status:'completed',returnedCalls:results.length,modelReservedCents:results.length*2,
    providerReportedUsd:results.reduce((n,r)=>n+r.modelAnswer.providerReportedUsd,0),statuses:counts,
    ownershipAccepted:0,catalogWrites:0,paidRetries:0,searchCalls:0,metadataCalls:0};
  await durableIdentityFile(root+'/summary.json',JSON.stringify(summary,null,2));return summary;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-saved-model-checks-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await readSavedJson(root+'/plan.json');assert.equal(plan.id,id);
  let check=await savedModelsFrozen(root,plan);
  const source=deepFreeze(await readSavedJson(plan.sourceProposalPath));verifySavedModelSource(plan,source);
  if(modes[0]==='--authorize-prepared'){
    checkModelQuote(await modelQuote(),plan.pricing);
    const approval=approveSavedModels(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await readSavedJson(root+'/approval.json'));
  check=await savedModelsFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  // Expensive provenance validation runs once at startup; every outgoing request
  // remains self-contained and bound to the sealed proposal and approval.
  await frozenFileVerifier(source.sourceFiles)();
  const pool=await connectSavedBatchPool();
  try{
    const gate=savedModelGate({pool,plan,source,approval,owner:randomUUID(),checkCatalog:liveSavedModelCatalog(plan)});
    console.log(JSON.stringify(await executeSavedModels({root,plan,approval,gate,
      credential:process.env.OPENROUTER_API_KEY,assertFrozen:check})));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
