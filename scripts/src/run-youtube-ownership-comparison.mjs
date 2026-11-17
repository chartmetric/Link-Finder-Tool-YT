import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {comparisonPlan,approveComparison,comparisonResult,rejectComparisonReplay} from './youtube-ownership-comparison.mjs';
import {executeSavedModels,readSavedJson,modelQuote,checkModelQuote,liveSavedModelCatalog} from './run-youtube-saved-model-checks.mjs';
import {savedModelGate} from './youtube-saved-model-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';

export async function comparisonFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed comparison executor');
  deepFreeze(plan);assert.deepEqual(comparisonPlan(plan),plan);
  assert.deepEqual(await readSavedJson(root+'/plan.json'),plan);
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
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-ownership-comparison-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await readSavedJson(root+'/plan.json');assert.equal(plan.id,id);
  let check=await comparisonFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    checkModelQuote(await modelQuote(),plan.pricing);
    const approval=approveComparison(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await readSavedJson(root+'/approval.json'));
  check=await comparisonFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  const pool=await connectSavedBatchPool();
  try{
    const gate=savedModelGate({pool,plan,source:{sourceLedgerSnapshot:plan.baselineLedgerSnapshot},
      approval,owner:randomUUID(),checkCatalog:liveSavedModelCatalog(plan),rejectReplay:rejectComparisonReplay});
    console.log(JSON.stringify(await executeSavedModels({root,plan,approval,gate,
      credential:process.env.OPENROUTER_API_KEY,assertFrozen:check,
      validateApproval:approveComparison,parseResult:comparisonResult})));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
