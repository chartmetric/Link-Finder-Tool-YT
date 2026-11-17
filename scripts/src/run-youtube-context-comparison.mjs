import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {contextComparisonPlan,approveContextComparison,contextComparisonGate,
  contextComparisonResult} from './youtube-context-comparison.mjs';
import {executeSavedModels,readSavedJson,modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {reviewedCatalogCheck} from './run-youtube-reviewed-captures.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';

export async function contextComparisonFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed executor');
  deepFreeze(plan);assert.deepEqual(contextComparisonPlan(plan),plan);
  assert.deepEqual(await readSavedJson(root+'/plan.json'),plan);
  assert.deepEqual(await readSavedJson(plan.baselineRoot+'/plan.json'),plan.baselinePlan);
  assert.deepEqual(await readSavedJson(plan.baselineRoot+'/approval.json'),plan.baselineApproval);
  const files={...plan.sourceFiles,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json')),...extras};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const check=frozenFileVerifier(files);await check();return check;
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  assert.equal(args.filter(a=>['--authorize-prepared','--run-approved'].includes(a)).length,1);
  const id=value('id');assert.match(id??'',/^youtube-context-comparison-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await readSavedJson(root+'/plan.json');assert.equal(plan.id,id);
  let check=await contextComparisonFrozen(root,plan);
  if(args.includes('--authorize-prepared')){
    checkModelQuote(await modelQuote(),plan.pricing);
    const approval=approveContextComparison(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await readSavedJson(root+'/approval.json'));
  check=await contextComparisonFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  const pool=await connectSavedBatchPool();
  try{
    const gate=contextComparisonGate({pool,plan,approval,owner:randomUUID(),checkCatalog:reviewedCatalogCheck(plan)});
    console.log(JSON.stringify(await executeSavedModels({root,plan,approval,gate,assertFrozen:check,
      credential:process.env.OPENROUTER_API_KEY,validateApproval:approveContextComparison,
      parseResult:contextComparisonResult})));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
