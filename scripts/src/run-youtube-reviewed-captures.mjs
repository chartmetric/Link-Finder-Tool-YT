// Transport-only diagnostic. No ownership claims or grading/model decisions.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedCapturePlan,approveReviewedCaptures,reviewedCaptureResult,reviewedCaptureGate,
  recoverReviewedResponse} from './youtube-reviewed-test.mjs';
import {readSavedJson} from './run-youtube-saved-model-checks.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

export function reviewedCatalogCheck(plan,{query=select}={}){
  return async op=>{
    const s=plan.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist);assert.ok(s);
    const rows=await catalogReadWithOneTimeoutRetry(query,identityEligibilitySql([s]));
    assert.equal(rows.length,1);
    assertCurrentIdentityEligibility([{...s,tier:Number(rows[0].tier)}],rows);
  };
}
export async function reviewedFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed executor');
  deepFreeze(plan);assert.deepEqual(reviewedCapturePlan(plan),plan);
  assert.deepEqual(await readSavedJson(root+'/plan.json'),plan);
  const files={...plan.sourceFiles,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json')),...extras};
  for(const [name,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+name]=sha;
  const check=frozenFileVerifier(files);await check();return check;
}
export async function executeReviewedCaptures({root,plan,approval,gate,assertFrozen,credential,fetchImpl=fetch}){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  assert.deepEqual(approveReviewedCaptures(plan,approval),approval);
  assert.ok(typeof credential==='string'&&credential.length);
  await assertFrozen();
  await durableIdentityFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  const group=plan.groups[0],folder=root+'/part-1',results=[];
  await fs.mkdir(folder);await fs.mkdir(folder+'/receipts');
  await durableIdentityFile(folder+'/plan.json',JSON.stringify(group));
  let started=false;
  try{
    await gate.start(group);started=true;
    for(const op of plan.operations){
      await assertFrozen();await gate.admit(group,op);
      const response=await fetchImpl(op.request.url,{method:'GET',redirect:'error',
        signal:AbortSignal.timeout(120000),headers:{'x-api-key':credential}});
      const chunks=[];let length=0;
      if(response.body)for await(const chunk of response.body){
        length+=chunk.length;assert.ok(length<=2*1024*1024);chunks.push(chunk);
      }
      const raw=Buffer.concat(chunks),rawPath='receipts/'+digest(op.key)+'.raw';
      await durableIdentityFile(folder+'/'+rawPath,raw);
      const receipt={runId:group.id,parentId:plan.id,planSha256:digest(group),approvalSha256:digest(approval),
        operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
        kind:'metadata',request:op.request,inputSha256:op.inputSha256,status:response.status,
        capturedAt:new Date().toISOString(),rawPath,rawBodySha256:digest(raw)};
      await durableIdentityFile(folder+'/receipts/'+digest(op.key)+'.json',JSON.stringify(receipt));
      const result=reviewedCaptureResult(plan,op,receipt,raw);
      await assertFrozen();await gate.returned(group,op,receipt,raw);results.push(result);
      console.log(JSON.stringify({phase:'reviewed_channel_capture',completed:results.length,total:plan.operations.length}));
    }
    await gate.finish(group,'completed');started=false;
  }catch(error){
    if(started)await gate.finish(group,'stopped');
    throw error;
  }
  await durableIdentityFile(root+'/results.json',JSON.stringify(results,null,2));
  const summary={status:'completed',returnedCalls:results.length,metadataReservedCents:results.length*2,
    modelCalls:0,searchCalls:0,catalogWrites:0,channelClaimWrites:0,gradingLabelsRefreshed:false,
    paidRetries:0,ownershipAccepted:0,modelStageApproved:false};
  await durableIdentityFile(root+'/summary.json',JSON.stringify(summary,null,2));return summary;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-reviewed-test-captures-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await readSavedJson(root+'/plan.json');assert.equal(plan.id,id);
  let check=await reviewedFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveReviewedCaptures(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await readSavedJson(root+'/approval.json'));
  check=await reviewedFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  const pool=await connectSavedBatchPool();
  try{
    if(plan.recovery)await recoverReviewedResponse({root,plan,approval,pool,assertFrozen:check});
    const gate=reviewedCaptureGate({pool,plan,approval,owner:randomUUID(),checkCatalog:reviewedCatalogCheck(plan)});
    console.log(JSON.stringify(await executeReviewedCaptures({root,plan,approval,gate,assertFrozen:check,
      credential:process.env.SCRAPECREATORS_API_KEY})));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
