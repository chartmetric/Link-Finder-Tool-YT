import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {digest} from './youtube-video-discovery-offline.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {approveMixedCaptures} from './youtube-mixed-channel-captures.mjs';
const read=async file=>JSON.parse(await fs.readFile(file));
export async function assertChannelBundleFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.deepEqual(channelCheckBundle(plan),plan);assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  assert.equal(digest(await read('generated-artifacts/'+plan.sourceBundleId+'/plan.json')),plan.sourceBundleSha256);
  for(const [name,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(root+'/'+name)),sha);
  for(const child of plan.children){
    const folder='generated-artifacts/'+child.id,p=await read(folder+'/plan.json');
    assert.equal(digest(p),child.planSha256);
    for(const [file,sha] of Object.entries(p.runtimeFiles))assert.equal(digest(await fs.readFile(folder+'/'+file)),sha);
    for(const [file,sha] of Object.entries(p.sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  }
}
async function save(file,data){
  const handle=await fs.open(file,'wx');try{await handle.writeFile(JSON.stringify(data,null,2));await handle.sync();}
  finally{await handle.close();}
}
async function absent(file){
  try{await fs.lstat(file);assert.fail('Existing approval or attempt cannot be overwritten');}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-batch-channel-checks-[a-z0-9-]{4,75}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(id,plan.id);
  await assertChannelBundleFrozen(root,plan);
  const invoke=(child,mode)=>{
    const flags=[mode,'--id='+child.id];
    if(mode==='--authorize-prepared')flags.push('--plan-sha256='+child.planSha256,'--approve-cents='+child.capCents);
    const result=spawnSync(process.execPath,['generated-artifacts/'+child.id+
      '/runtime/run-youtube-mixed-captures.mjs',...flags],{stdio:'inherit'});
    assert.ok(!result.error&&result.status===0,'Child stopped; no automatic retry or continuation');
  };
  if(modes[0]==='--authorize-prepared'){
    await absent(root+'/approval.json');
    for(const c of plan.children)await absent('generated-artifacts/'+c.id+'/approval.json');
    const approval=approveChannelCheckBundle(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await save(root+'/approval.json',approval);
    for(const c of plan.children){await assertChannelBundleFrozen(root,plan);invoke(c,'--authorize-prepared');}
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
  const approval=await read(root+'/approval.json');assert.deepEqual(approveChannelCheckBundle(plan,approval),approval);
  for(const c of plan.children){
    const a=await read('generated-artifacts/'+c.id+'/approval.json');assert.deepEqual(approveMixedCaptures(c.plan,a),a);
  }
  await save(root+'/run-started.json',{planSha256:digest(plan),at:new Date().toISOString()});
  for(const c of plan.children){await assertChannelBundleFrozen(root,plan);invoke(c,'--run-approved');}
  await save(root+'/summary.json',{id,status:'completed',channelChecks:plan.maximumCalls,
    maximumSpendCents:plan.maximumSpendCents,uploaderCalls:0,modelCalls:0,catalogWrites:0});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
