// Workspace-only executor for separately approved immutable identity plans.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityJson} from './youtube-video-identity-source.mjs';
import {validateVideoIdentityPlan,assertVideoIdentityApproval} from './youtube-video-identity-plan.mjs';
import {archiveBytes,durableIdentityFile,approveIdentityExecution,assertIdentityExecutionApproval,
  assertExecutionManifest,executeVideoIdentity,IDENTITY_EXECUTION_POLICY,IDENTITY_PARENT} from './youtube-video-identity-execution.mjs';
import {videoIdentityGate} from './youtube-video-identity-gate.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';

const entry=fileURLToPath(import.meta.url);
export function identityExecutionOptions(args){
  const modes=['--prepare-executor','--authorize-execution','--run-approved'];
  assert.ok(args.length&&args.every(a=>modes.includes(a)
    ||/^--(?:id|plan-sha256|execution-sha256|approve-cents)=[a-zA-Z0-9-]+$/.test(a)),'Unsupported execution option');
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length,'Duplicate option');
  assert.equal(args.filter(a=>modes.includes(a)).length,1);
  const mode=args.find(a=>modes.includes(a));
  const value=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  const id=value('id');assert.match(id??'',/^youtube-video-identity-[a-z0-9-]{4,80}$/);
  if(mode==='--authorize-execution'){
    for(const k of ['plan-sha256','execution-sha256'])assert.match(value(k)??'',/^[a-f0-9]{64}$/);
    assert.match(value('approve-cents')??'',/^(0|[1-9]\d*)$/);
  }else for(const k of ['plan-sha256','execution-sha256','approve-cents'])assert.equal(value(k),undefined);
  return {id,mode,value};
}
async function seal(root){
  const source=path.dirname(entry),seen=new Set(),runtimeFiles={};
  await fs.mkdir(root+'/execution');
  await fs.mkdir(root+'/execution/runtime');
  async function visit(file){
    if(seen.has(file))return;seen.add(file);
    assert.equal(path.dirname(file),source,'Only local execution dependencies may be sealed');
    const bytes=await fs.readFile(file),name='execution/runtime/'+path.basename(file);
    await durableIdentityFile(root+'/'+name,bytes);runtimeFiles[name]=digest(bytes);
    for(const m of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+\.mjs)['"]/g))
      await visit(path.resolve(source,m[1]));
  }
  await visit(entry);
  // Resolve pg from the package that declares it; no root dependency install.
  await fs.symlink(path.resolve('scripts/node_modules'),root+'/execution/runtime/node_modules','dir');
  return runtimeFiles;
}
async function frozen(root,plan,approval,manifest){
  assert.equal(path.dirname(entry),path.resolve(root,'execution/runtime'),'Use the sealed execution runtime');
  assertExecutionManifest(plan,approval,manifest);
  assert.equal(digest(identityJson(await archiveBytes(root,'plan.json'))),digest(plan));
  assert.equal(digest(identityJson(await archiveBytes(root,'approval.json'))),digest(approval));
  assert.equal(digest(identityJson(await archiveBytes(root,'execution/manifest.json'))),digest(manifest));
  for(const [name,hash] of Object.entries({...plan.runtimeFiles,...manifest.runtimeFiles}))
    assert.equal(digest(await archiveBytes(root,name)),hash,'Frozen preparation or executor changed');
}
export async function runVideoIdentityCli(args){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only executor');
  const o=identityExecutionOptions(args),root='generated-artifacts/'+o.id;
  const plan=validateVideoIdentityPlan(identityJson(await archiveBytes(root,'plan.json')));
  const approval=identityJson(await archiveBytes(root,'approval.json'));
  assert.equal(plan.id,o.id);assertVideoIdentityApproval(plan,approval);
  for(const [name,hash] of Object.entries(plan.runtimeFiles))
    assert.equal(digest(await archiveBytes(root,name)),hash,'Preparation runtime changed');
  if(o.mode==='--prepare-executor'){
    // This command performs no database queries, admissions or paid calls.
    const manifest={policy:IDENTITY_EXECUTION_POLICY,id:plan.id,planSha256:digest(plan),
      approvalSha256:digest(approval),parentId:IDENTITY_PARENT,preparedAt:new Date().toISOString(),
      runtimeFiles:await seal(root)};
    await durableIdentityFile(root+'/execution/manifest.json',JSON.stringify(manifest,null,2));
    console.log(JSON.stringify({status:'executor_prepared_not_approved',id:plan.id,
      planSha256:digest(plan),executionSha256:digest(manifest),maximumSpendCents:plan.maximumSpendCents,paidCalls:0}));
    return manifest;
  }
  const manifest=identityJson(await archiveBytes(root,'execution/manifest.json'));
  await frozen(root,plan,approval,manifest);
  if(o.mode==='--authorize-execution'){
    const authorization=approveIdentityExecution(plan,approval,manifest,{
      planSha256:o.value('plan-sha256'),executionSha256:o.value('execution-sha256'),
      capCents:Number(o.value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/execution/approval.json',JSON.stringify(authorization,null,2));
    console.log(JSON.stringify({status:'execution_approved_not_started',id:plan.id,paidCalls:0}));
    return authorization;
  }
  const executionApproval=identityJson(await archiveBytes(root,'execution/approval.json'));
  assertIdentityExecutionApproval(plan,approval,manifest,executionApproval);
  const pool=await connectSavedBatchPool();
  try{
    const gate=videoIdentityGate({pool,plan,approval,manifest,executionApproval,owner:randomUUID(),
      checkCatalog:identityCatalogCheck(plan)});
    const returns=await executeVideoIdentity({plan,approval,manifest,executionApproval,root,gate,
      credentials:{scrapecreators:process.env.SCRAPECREATORS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY},
      assertFrozen:async()=>{
        await frozen(root,plan,approval,manifest);
        assert.equal(digest(identityJson(await archiveBytes(root,'execution/approval.json'))),digest(executionApproval));
      }});
    console.log(JSON.stringify({id:plan.id,status:returns.summary.status,returnedCalls:returns.summary.returnedCalls,
      catalogWrites:0,fullCampaignResumed:false}));
    return returns;
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry)await runVideoIdentityCli(process.argv.slice(2));
