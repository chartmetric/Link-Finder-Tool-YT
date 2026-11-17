import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {RECOVERY,approveMixedRecovery,approveMixedRecoveryContinuation} from './youtube-mixed-response-recovery.mjs';
import {acknowledgeMixedSavedResponse,executeMixedRecoveryContinuation,saveMixedRecoveryResult} from './youtube-mixed-response-recovery-live.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function assertRecoveryFrozen(root,plan,approval){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(await read(root+'/plan.json'),plan);
  for(const [file,sha] of Object.entries(plan.runtimeFiles))
    assert.equal(digest(await fs.readFile(root+'/'+file)),sha);
  if(approval)assert.deepEqual(await read(root+'/approval.json'),approval);
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|acknowledge-approved|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--acknowledge-approved','--run-approved'].includes(a));
  assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-mixed-(?:response-recovery|captures-recovered)-[a-z0-9-]{4,60}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  const recovery=plan.version===RECOVERY;
  const approve=recovery?approveMixedRecovery:approveMixedRecoveryContinuation;
  await assertRecoveryFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approve(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(modes[0],recovery?'--acknowledge-approved':'--run-approved');
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');assert.deepEqual(approve(plan,approval),approval);
  const assertFrozen=()=>assertRecoveryFrozen(root,plan,approval);
  const pool=await connectSavedBatchPool();
  try{
    if(recovery){
      const result=await acknowledgeMixedSavedResponse({plan,approval,pool,assertFrozen,
        checkCatalog:identityCatalogCheck(plan.evidence.plan)});
      await saveMixedRecoveryResult(root,result);console.log(JSON.stringify(result));
    }else{
      // One-shot execution, just like the original runner. No restart marker
      // deletion or resume path. All source reservations remain in PostgreSQL.
      await durableStageFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),
        approvalSha256:digest(approval),at:new Date().toISOString()}));
      await executeMixedRecoveryContinuation({root,plan,approval,pool,assertFrozen,
        checkCatalog:identityCatalogCheck(plan),credential:process.env.SCRAPECREATORS_API_KEY});
    }
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
