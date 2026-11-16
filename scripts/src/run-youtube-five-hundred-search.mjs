// Executes only separately approved, immutable search bundles in serial order.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {fiveHundredSearchPlan,approveFiveHundredSearch} from './youtube-five-hundred-search-plan.mjs';
import {approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
const read=async file=>JSON.parse(await fs.readFile(file));
export async function assertFiveHundredFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(fiveHundredSearchPlan(plan),plan);
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  const check=async(folder,p)=>{
    for(const [file,sha] of Object.entries({...p.evidenceFiles,...p.runtimeFiles}))
      assert.equal(digest(await fs.readFile(folder+'/'+file)),sha);
  };
  await check(root,plan);
  for(const child of plan.children){
    const folder='generated-artifacts/'+child.id,p=await read(folder+'/plan.json');
    assert.equal(digest(p),child.planSha256);await check(folder,p);
    for(const leaf of p.children){
      const leafRoot='generated-artifacts/'+leaf.id,leafPlan=await read(leafRoot+'/plan.json');
      assert.equal(digest(leafPlan),leaf.planSha256);await check(leafRoot,leafPlan);
    }
  }
}
async function save(file,value){
  const h=await fs.open(file,'wx');
  try{await h.writeFile(JSON.stringify(value,null,2));await h.sync();}finally{await h.close();}
}
async function absent(file){
  try{await fs.lstat(file);assert.fail('Existing approval or execution cannot be overwritten');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-batch-500-[a-z0-9-]{4,70}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(id,plan.id);
  await assertFiveHundredFrozen(root,plan);
  const invoke=(child,mode)=>{
    const flags=[mode,'--id='+child.id];
    if(mode==='--authorize-prepared')flags.push('--plan-sha256='+child.planSha256,'--approve-cents=200');
    const result=spawnSync(process.execPath,['generated-artifacts/'+child.id+
      '/runtime/run-youtube-hundred-search.mjs',...flags],{stdio:'inherit'});
    assert.ok(!result.error&&result.status===0,'Child stopped; no automatic retry or continuation');
  };
  if(modes[0]==='--authorize-prepared'){
    await absent(root+'/approval.json');await absent(root+'/run-started.json');
    for(const c of plan.children){
      await absent('generated-artifacts/'+c.id+'/approval.json');
      await absent('generated-artifacts/'+c.id+'/run-started.json');
      for(const leaf of c.plan.children)await absent('generated-artifacts/'+leaf.id+'/approval.json');
    }
    const approval=approveFiveHundredSearch(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await save(root+'/approval.json',approval);
    for(const c of plan.children){await assertFiveHundredFrozen(root,plan);invoke(c,'--authorize-prepared');}
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json');
  assert.deepEqual(approveFiveHundredSearch(plan,approval),approval);
  for(const c of plan.children){
    const a=await read('generated-artifacts/'+c.id+'/approval.json');
    assert.deepEqual(approveHundredSearch(c.plan,a),a);
    for(const leaf of c.plan.children)assertStagedSearchApproval(leaf.plan,
      await read('generated-artifacts/'+leaf.id+'/approval.json'));
  }
  await save(root+'/run-started.json',{planSha256:digest(plan),at:new Date().toISOString()});
  for(const c of plan.children){await assertFiveHundredFrozen(root,plan);invoke(c,'--run-approved');}
  await save(root+'/summary.json',{id,status:'completed',searchCalls:500,maximumSpendCents:1000,
    uploaderCalls:0,channelCaptureCalls:0,modelCalls:0,catalogWrites:0,fullCampaignResumed:false});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
