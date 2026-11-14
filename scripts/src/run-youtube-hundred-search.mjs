// Sealed aggregate wrapper; children retain their stricter legacy 20-search contract.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {hundredSearchPlan,approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
const read=async name=>JSON.parse(await fs.readFile(name));
export async function assertHundredFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(hundredSearchPlan(plan),plan);assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(root+'/'+name)),sha);
  for(const child of plan.children){
    const childRoot='generated-artifacts/'+child.id,p=await read(childRoot+'/plan.json');
    assert.equal(digest(p),child.planSha256);
    for(const [name,sha] of Object.entries({...p.evidenceFiles,...p.runtimeFiles}))
      assert.equal(digest(await fs.readFile(childRoot+'/'+name)),sha);
  }
}
async function save(file,value){
  const handle=await fs.open(file,'wx');
  try{await handle.writeFile(JSON.stringify(value,null,2));await handle.sync();}finally{await handle.close();}
}
async function absent(file){
  try{await fs.lstat(file);assert.fail('Existing artifact cannot be overwritten or replayed: '+file);}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-batch-100-[a-z0-9-]{4,70}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertHundredFrozen(root,plan);
  const invoke=(child,mode)=>{
    const childArgs=[mode,'--id='+child.id];
    if(mode==='--authorize-prepared')childArgs.push('--plan-sha256='+child.planSha256,'--approve-cents=40');
    const output=spawnSync(process.execPath,['generated-artifacts/'+child.id+
      '/runtime/run-youtube-staged-search.mjs',...childArgs],{stdio:'inherit'});
    assert.ok(!output.error&&output.status===0,'Child stopped; no automatic retries or continuation');
  };
  if(modes[0]==='--authorize-prepared'){
    await absent(root+'/approval.json');
    for(const c of plan.children)await absent('generated-artifacts/'+c.id+'/approval.json');
    const approval=approveHundredSearch(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await save(root+'/approval.json',approval);
    for(const c of plan.children){await assertHundredFrozen(root,plan);invoke(c,'--authorize-prepared');}
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');
  assert.deepEqual(approveHundredSearch(plan,approval),approval);
  for(const c of plan.children)assertStagedSearchApproval(c.plan,
    await read('generated-artifacts/'+c.id+'/approval.json'));
  await save(root+'/run-started.json',{planSha256:digest(plan),at:new Date().toISOString()});
  for(const c of plan.children){await assertHundredFrozen(root,plan);invoke(c,'--run-approved');}
  await save(root+'/summary.json',{id,status:'completed',searchCalls:100,maximumSpendCents:200,
    uploaderCalls:0,channelCaptureCalls:0,modelCalls:0,catalogWrites:0,fullCampaignResumed:false});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
