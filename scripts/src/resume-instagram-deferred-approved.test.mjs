import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';

const operation=fileURLToPath(new URL('./resume-instagram-deferred-approved.mjs',import.meta.url));
const fence=fileURLToPath(new URL('../fixtures/instagram-preparation-network-fence.mjs',import.meta.url));
const observer=new URL('../../artifacts/api-server/src/lib/instagram-continuation-status.ts',import.meta.url).href;

async function fixture(t,mode) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ig-preparation-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'generated-artifacts/instagram-tier-priority');
  const parent=path.join(root,'parallel-493d5352-9a7f-4d95-a88a-c78c42a8f960');
  const write=async(file,value)=>{
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
  };
  const queue=Array.from({length:9404},(_,i)=>({profile_id:String(i+1),cm_artist:String(i+2),tier:2}));
  await write(path.join(dir,'generated-artifacts/instagram-tier-gap-investigation-2026-11-11/history-rows.json'),queue);
  const approval={maximumSpendCents:null};
  await write(root+'/queue.json',queue);
  await write(root+'/approval.json',approval);
  // Synthetic, disposable runtime only. No production dependencies are imported.
  const files={
    'campaign-parallel-adapters.mjs':"export function eligibilitySql(platform,ids){ return ''; }",
    'youtube-ownership-policy.mjs':`import {createHash} from 'node:crypto';
      export const evidenceDigest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');`,
    'campaign-parallel-core.mjs':`
      import fs from 'node:fs/promises';
      export const CAMPAIGNS={instagram:{id:'fixture'}};
      export async function ledgerProof(){
        const queue=JSON.parse(await fs.readFile('generated-artifacts/instagram-tier-priority/queue.json','utf8'));
        return {run:{status:'completed'},proof:{fixture:true},admissions:[],
          artists:queue.map(a=>({...a,status:'deferred',reason:'current_catalog_eligibility_or_identity_changed'}))};
      }
      export async function verifyArchive(){
        if(process.env.FIXTURE_MODE==='failed')throw Error('fixture archive rejected');
        if(process.env.FIXTURE_MODE==='interrupted'){await new Promise(()=>setInterval(()=>{},1000));}
        if(process.env.FIXTURE_MODE==='exited')process.exit(7);
      }
      // assert.equal(run.status,'stopped','Only an ended worker can be handed off.');
    `,
    'instagram-saved-batch-gate.mjs':`
      export async function connectSavedBatchPool(){
        return {async connect(){return {async query(sql,params){
          return {rows:[],rowCount:sql.includes('UPDATE instagram_priority_artists')?params[1].length:0};
        },release(){}};},async query(){return {rows:[]};},async end(){}};
      }`,
    'campaign-parallel-resume.mjs':`
      import fs from 'node:fs/promises';
      if(process.env.FIXTURE_MODE==='launch_failed')throw Error('fixture launch failed');
      const phase=process.argv.at(-1);
      await fs.writeFile(phase+'/launch-attempt.json','{}');
      if(process.env.FIXTURE_MODE==='coordinator_failed')process.exit(9);
      await fs.writeFile(phase+'/launched.json','{}');
    `,
  };
  for(const [name,source] of Object.entries(files))await write(parent+'/runtime/'+name,source);
  await write(parent+'/approval.json',{approvalSha256:hash(approval),scopeSha256:hash(queue),
    runtimeFiles:Object.fromEntries(Object.entries(files).map(([name,source])=>[name,hash(source)]))});
  if(mode==='early_approval_failed')await write(root+'/approval.json',{maximumSpendCents:10000});
  if(mode==='early_runtime_failed')await fs.appendFile(parent+'/runtime/campaign-parallel-adapters.mjs','\n// integrity mismatch');
  const child=spawn(process.execPath,['--import',fence,operation,'--approved-stale-tier-exception'],{
    cwd:dir,env:{FIXTURE_MODE:mode,NODE_OPTIONS:`--import=${fence}`},stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');});
  let output='';
  child.stdout.on('data',chunk=>{
    output+=chunk;
    if(mode==='interrupted' && output.includes('verifying_saved_archive'))child.kill('SIGTERM');
  });
  let errors='';
  child.stderr.on('data',chunk=>{errors+=chunk;});
  const [code,signal]=await once(child,'exit');
  const phases=(await fs.readdir(root)).filter(name=>name.startsWith('parallel-') && name!==path.basename(parent));
  assert.equal(phases.length,1);
  const phase=path.join(root,phases[0]);
  const marker=JSON.parse(await fs.readFile(phase+'/preparation-status.json','utf8'));
  return {root,phase,marker,code,signal,errors};
}

for(const [mode,status] of [
  ['early_approval_failed','failed'],['early_runtime_failed','failed'],
  ['failed','failed'],['interrupted','interrupted'],['exited','interrupted'],
  ['launch_failed','failed'],['coordinator_failed','failed'],['success','handed_off'],
]) test(`real preparation CLI records ${mode} using offline fixtures`,{timeout:15000},async t=>{
  const f=await fixture(t,mode);
  assert.equal(f.marker.status,status,f.errors);
  assert.equal(f.marker.phase,path.basename(f.phase));
  assert.ok(Date.parse(f.marker.at)>=Date.parse(f.marker.startedAt));
  if(mode==='success'){
    assert.equal(f.code,0,f.errors);
    await fs.stat(f.phase+'/launched.json');
    const proof=JSON.parse(await fs.readFile(f.phase+'/recovery-proof.json','utf8'));
    assert.equal(proof.paidCallsDuringPreparation,0);
    assert.equal(proof.noPaidReplay,true);
    assert.equal(proof.requeued.length,9404);
  } else assert.notEqual(f.code,0);
  if(mode==='interrupted') assert.equal(f.marker.reason,'SIGTERM');
  if(['early_approval_failed','early_runtime_failed','failed','interrupted','exited','launch_failed'].includes(mode))
    await assert.rejects(fs.stat(f.phase+'/launch-attempt.json'),{code:'ENOENT'});
  if(mode.startsWith('early_')){
    // Read the actual emitted terminal marker through the real read-only
    // observer. Native type stripping needs no API boot, database or providers.
    const observed=spawnSync(process.execPath,['--import',fence,'--experimental-strip-types',
      '--input-type=module','-e',`
        import fs from 'node:fs/promises';
        import {continuationRequest} from ${JSON.stringify(observer)};
        const root=${JSON.stringify(f.root)};
        const queue=JSON.parse(await fs.readFile(root+'/queue.json','utf8'));
        const result=await continuationRequest(root,new Set(queue.map(a=>a.profile_id)),'2020-01-01T00:00:00.000Z');
        process.stdout.write(JSON.stringify(result));
      `],{env:{},encoding:'utf8',timeout:10000});
    assert.equal(observed.status,0,observed.stderr);
    assert.equal(JSON.parse(observed.stdout).status,'continuation_preparation_failed');
    await assert.rejects(fs.stat(f.phase+'/recovery-proof.json'),{code:'ENOENT'});
  }
});
