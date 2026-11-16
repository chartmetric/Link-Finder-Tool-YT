// Separate execution supplement. Never changes a preparation plan or source archive.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {identityConflict} from './youtube-identity-conflict-hold.mjs';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityArchivePath,identityJson} from './youtube-video-identity-source.mjs';
import {validateVideoIdentityPlan,assertVideoIdentityApproval} from './youtube-video-identity-plan.mjs';
import {normalizeYoutubeChannel,parseYoutubeDecision} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture,youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';

export const IDENTITY_EXECUTION_POLICY='exact-video-identity-execution-v1';
export const IDENTITY_PARENT='full-tiers-1-5-no-youtube-uncapped';
export async function archiveBytes(root,name){
  identityArchivePath(name);
  let current=path.resolve(root);
  assert.ok((await fs.lstat(current)).isDirectory());
  // Check ancestors as well as leaf paths. A sealed runtime must not read through
  // a symlinked generated-artifacts directory.
  for(let p=current;p!==path.dirname(p);p=path.dirname(p))
    assert.equal((await fs.lstat(p)).isSymbolicLink(),false,'Symlink archive ancestor');
  for(const part of name.split('/')){
    current=path.join(current,part);
    assert.equal((await fs.lstat(current)).isSymbolicLink(),false,'Symlink archive input');
  }
  return fs.readFile(current);
}
export async function durableIdentityFile(file,bytes){
  const f=await fs.open(file,'wx');
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
  const directory=await fs.open(path.dirname(file),'r');
  try{await directory.sync();}finally{await directory.close();}
}
export function assertExecutionManifest(plan,approval,manifest){
  assertVideoIdentityApproval(plan,approval);
  assert.equal(manifest.policy,IDENTITY_EXECUTION_POLICY);
  assert.equal(manifest.id,plan.id);
  assert.equal(manifest.planSha256,digest(plan));
  assert.equal(manifest.approvalSha256,digest(approval));
  assert.equal(manifest.parentId,IDENTITY_PARENT);
  assert.ok(Number.isFinite(Date.parse(manifest.preparedAt)));
  assert.ok(Object.keys(manifest.runtimeFiles).length);
  for(const [name,hash] of Object.entries(manifest.runtimeFiles)){
    identityArchivePath(name);assert.ok(name.startsWith('execution/runtime/'));
    assert.match(hash,/^[a-f0-9]{64}$/);
  }
}
export function approveIdentityExecution(plan,approval,manifest,{planSha256,executionSha256,capCents,approvedAt}){
  assertExecutionManifest(plan,approval,manifest);
  assert.equal(planSha256,digest(plan),'Fresh exact-plan execution approval required');
  assert.equal(executionSha256,digest(manifest),'Exact executor approval required');
  assert.equal(capCents,plan.maximumSpendCents,'Exact stage cap required');
  assert.ok(Number.isFinite(Date.parse(approvedAt)));
  assert.ok(Date.parse(approvedAt)>=Date.parse(manifest.preparedAt));
  return {policy:IDENTITY_EXECUTION_POLICY,id:plan.id,stage:plan.stage,planSha256,executionSha256,
    preparationApprovalSha256:digest(approval),operationAllocationsSha256:digest(plan.operations),
    capCents,approvedAt,explicitApproval:true,executionEnabled:true,
    scope:'only_exact_frozen_requests_no_retries_no_substitution'};
}
export function assertIdentityExecutionApproval(plan,approval,manifest,executionApproval){
  assert.deepEqual(approveIdentityExecution(plan,approval,manifest,executionApproval),executionApproval);
}
export function identityCapturePlan(plan){return plan.stage==='channel_captures'?plan:plan.capturePlan;}
// Include deferred alternatives and provider-observed aliases. Those aliases are
// cautionary claims, not proof of artist ownership or permission to dispatch.
export function identityClaims(plan){
  const claims=[];
  for(const s of plan.selections)for(const a of s.alternatives){
    const aliases=[a.url,...a.observations.flatMap(o=>(o.providerAliases??[]).map(v=>
      v.raw?.startsWith('http://')?'https://'+v.raw.slice(7):v.raw))];
    if(a.selected&&plan.stage==='identity_models'){
      const capture=plan.assessments.find(x=>x.profileId===s.profileId)?.candidate.capture;
      if(capture)aliases.push(...boundYoutubeCapture(a.url,capture).aliases);
    }
    for(const alias of new Set(aliases.map(youtubeOwnershipUrl).filter(Boolean)))
      claims.push({alias,channelId:a.channelId,profileId:s.profileId,cmArtist:s.cmArtist});
  }
  return claims;
}
export function assertNoNewIdentityClaims(expected,observed){
  assert.ok(Array.isArray(observed),'Missing shared-channel claim results');
  for(const claim of observed){
    assert.equal(typeof claim.alias,'string');
    const relevant=expected.filter(e=>e.alias.toLowerCase()===claim.alias.toLowerCase()
      ||(claim.channelId&&e.channelId===claim.channelId));
    if(!relevant.length)continue;
    if(!relevant.some(e=>e.profileId===String(claim.profileId)
      &&e.cmArtist===String(claim.cmArtist)))throw identityConflict([claim]);
  }
}
export function validateIdentityResponse(plan,op,receipt,raw){
  assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
  assert.equal(receipt.status,200,'Provider failed; preserve bytes without replay');
  const data=identityJson(raw);assert.ok(!data.error);
  const packet={at:receipt.capturedAt,status:receipt.status,kind:op.kind,operationKey:op.key,
    request:op.request,inputSha256:op.inputSha256,data};
  if(op.kind==='metadata'){
    assert.equal(data.success,true);
    assert.ok(Number.isInteger(data.credits_charged)&&data.credits_charged>=0&&data.credits_charged<=1,
      'Unknown/increased channel billing');
    const url=plan.selections.find(s=>s.profileId===op.profileId).alternatives[0].url;
    const capture=normalizeYoutubeChannel(packet,url);
    assert.ok(capture&&capture.body.channelId===op.channelId,'Returned channel identity changed');
    return boundYoutubeCapture(url,capture).aliases.map(alias=>({
      alias,channelId:op.channelId,profileId:op.profileId,cmArtist:op.cmArtist}));
  }
  assert.equal(op.kind,'model');
  const assessment=plan.assessments.find(a=>a.profileId===op.profileId&&a.channelId===op.channelId);
  parseYoutubeDecision(packet,assessment.prepared.input,{model:plan.model},op.inputSha256);
  return [];
}
export async function executeVideoIdentity({plan,approval,manifest,executionApproval,root,gate,
  assertFrozen,credentials,fetchImpl=fetch}){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only executor');
  assertIdentityExecutionApproval(plan,approval,manifest,executionApproval);
  validateVideoIdentityPlan(plan);
  const credential=plan.stage==='channel_captures'?credentials.scrapecreators:credentials.openrouter;
  if(plan.maximumCalls)assert.ok(typeof credential==='string'&&credential.length,'Provider credential required');
  await assertFrozen();
  try{
    await fs.lstat(root+'/returns.json');
    assert.fail('An existing return archive cannot be executed again');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  // Exclusive creation rejects previous partial output, including pre-admission
  // crashes. There is deliberately no resume, recovery or retry mode.
  await fs.mkdir(root+'/receipts');
  const rootDirectory=await fs.open(root,'r');
  try{await rootDirectory.sync();}finally{await rootDirectory.close();}
  const receipts=[];let started=false;
  try{
    await gate.start();started=true;
    for(const op of plan.operations){
      await assertFrozen();
      await gate.admit(op);
      // A committed reservation survives every possible failure from here.
      const response=await fetchImpl(op.request.url,{method:op.request.method,redirect:'error',
        signal:AbortSignal.timeout(120000),
        headers:op.kind==='metadata'?{'x-api-key':credential}:
          {Authorization:'Bearer '+credential,'Content-Type':'application/json'},
        ...(op.request.body?{body:JSON.stringify(op.request.body)}:{})});
      const chunks=[];let length=0;
      if(response.body)for await(const chunk of response.body){
        length+=chunk.length;
        assert.ok(length<=2*1024*1024,'Oversized response; admission remains uncertain');
        chunks.push(chunk);
      }
      const raw=Buffer.concat(chunks),rawPath='receipts/'+digest(op.key)+'.raw';
      await durableIdentityFile(root+'/'+rawPath,raw);
      const receipt={runId:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
        operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
        kind:op.kind,request:op.request,inputSha256:op.inputSha256,status:response.status,
        capturedAt:new Date().toISOString(),rawPath,rawBodySha256:digest(raw)};
      const bytes=Buffer.from(JSON.stringify(receipt));
      await durableIdentityFile(root+'/receipts/'+digest(op.key)+'.json',bytes);
      const aliases=validateIdentityResponse(plan,op,receipt,raw);
      await assertFrozen();
      await gate.returned(op,digest(bytes),digest(raw),aliases);
      receipts.push({receiptBytesBase64:bytes.toString('base64'),rawBodyBase64:raw.toString('base64')});
    }
    // The coordinator is authoritative. A crash after completion but before this
    // exclusive file is saved requires a separately approved offline recovery.
    await gate.finish('completed');started=false;
    const returns={approval,summary:{id:plan.id,planSha256:digest(plan),status:'completed',
      returnedCalls:plan.operations.length},receipts};
    await durableIdentityFile(root+'/returns.json',JSON.stringify(returns,null,2));
    return returns;
  }catch(error){
    if(started){
      try{await gate.finish('stopped');}
      catch(fenceError){throw new AggregateError([error,fenceError],'Stopped; coordinator is authoritative');}
    }
    throw error;
  }
}
