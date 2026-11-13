// Workspace-only local files. Deliberately no --run, provider or database access.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityArchivePath,identityJson} from './youtube-video-identity-source.mjs';
import {validateVideoStagePlan} from './youtube-video-stage.mjs';
import {prepareVideoChannelCaptures,prepareVideoIdentityModels,validateVideoIdentityPlan,
  approveVideoIdentityPlan} from './youtube-video-identity-plan.mjs';

const entry=fileURLToPath(import.meta.url);
async function bytes(root,name){
  identityArchivePath(name);
  // Reject symlink components too, rather than following paths outside the archive.
  let current=root;
  assert.equal((await fs.lstat(current)).isDirectory(),true);
  for(const part of name.split('/')){
    current=path.join(current,part);
    assert.equal((await fs.lstat(current)).isSymbolicLink(),false,'Symlink archive input');
  }
  return fs.readFile(current);
}
const json=async(root,name)=>identityJson(await bytes(root,name));
const save=async(root,name,value)=>{
  const file=await fs.open(path.join(root,name),'wx');
  try{await file.writeFile(typeof value==='string'?value:JSON.stringify(value,null,2));await file.sync();}
  finally{await file.close();}
};
async function uploaderSource(root){
  const plan=await json(root,'plan.json');validateVideoStagePlan(plan);
  const names=new Set(['plan.json','approval.json','summary.json',
    ...Object.keys(plan.evidenceFiles),...Object.keys(plan.runtimeFiles)]);
  for(const op of plan.operations){
    names.add('receipts/'+digest(op.key)+'.json');
    names.add('receipts/'+digest(op.key)+'.raw');
  }
  const files={};
  for(const name of names)files[name]=(await bytes(root,name)).toString('base64');
  return {files};
}
// Seal only this offline dependency tree, not shared paid workers or their modules.
async function seal(root){
  await fs.mkdir(root+'/runtime');
  const seen=new Set(),hashes={};
  async function visit(file){
    if(seen.has(file))return;seen.add(file);
    assert.equal(path.dirname(file),path.dirname(entry),'Only local offline modules may be sealed');
    const content=await fs.readFile(file),name='runtime/'+path.basename(file);
    await fs.writeFile(root+'/'+name,content,{flag:'wx'});hashes[name]=digest(content);
    for(const m of content.toString('utf8').matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+\.mjs)['"]/g))
      await visit(path.resolve(path.dirname(file),m[1]));
  }
  await visit(entry);return hashes;
}
export function videoIdentityOptions(args){
  const allowed=['--prepare-captures','--prepare-models','--authorize-prepared'];
  assert.ok(args.length&&args.every(a=>allowed.includes(a)
    ||/^--(?:id|source-id|plan-sha256|approve-cents)=[a-zA-Z0-9-]+$/.test(a)),'Unsupported option');
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length,'Duplicate option');
  const modes=args.filter(a=>allowed.includes(a));assert.equal(modes.length,1);
  const value=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  const id=value('id'),mode=modes[0],sourceId=value('source-id');
  assert.match(id??'',/^youtube-video-identity-[a-z0-9-]{4,80}$/);
  if(mode==='--authorize-prepared'){
    assert.equal(sourceId,undefined);
    assert.match(value('plan-sha256')??'',/^[a-f0-9]{64}$/);
    assert.match(value('approve-cents')??'',/^(0|[1-9]\d*)$/);
  }else{
    assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
    assert.match(sourceId??'',mode==='--prepare-captures'
      ?/^youtube-video-review-[a-z0-9-]{4,80}$/:/^youtube-video-identity-[a-z0-9-]{4,80}$/);
    assert.notEqual(id,sourceId);
  }
  return {id,mode,sourceId,value};
}
async function assertFrozen(root,plan){
  assert.equal(path.dirname(entry),path.resolve(root,'runtime'),'Use the sealed preparation runtime');
  for(const [name,hash] of Object.entries(plan.runtimeFiles))
    assert.equal(digest(await bytes(root,name)),hash,'Preparation runtime changed');
}
export async function prepareVideoIdentityCli(args){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only preparation');
  const o=videoIdentityOptions(args),root='generated-artifacts/'+o.id;
  if(o.mode==='--authorize-prepared'){
    const plan=validateVideoIdentityPlan(await json(root,'plan.json'));
    assert.equal(plan.id,o.id);await assertFrozen(root,plan);
    const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:o.value('plan-sha256'),
      capCents:Number(o.value('approve-cents')),approvedAt:new Date().toISOString()});
    await save(root,'approval.json',approval);
    console.log(JSON.stringify({id:o.id,status:'approved_for_exact_scope_not_executable',
      paidCalls:0,executionEnabled:false}));return;
  }
  // Read and validate before creating anything; an unreturned uploader stage must
  // leave no misleading prepared output behind.
  const sourceRoot='generated-artifacts/'+o.sourceId;
  const input={id:o.id,preparedAt:new Date().toISOString(),
    runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}};
  if(o.mode==='--prepare-captures')input.source=await uploaderSource(sourceRoot);
  else{
    input.capturePlan=await json(sourceRoot,'plan.json');
    input.captureReturns=await json(sourceRoot,'returns.json');
  }
  const prepare=o.mode==='--prepare-captures'?prepareVideoChannelCaptures:prepareVideoIdentityModels;
  prepare(input);
  await fs.mkdir(root); // Fresh IDs only; never rewrite existing plans/results.
  input.runtimeFiles=await seal(root);
  const plan=prepare(input);
  await save(root,'plan.json',plan);
  const summary={id:o.id,status:'prepared_not_approved',stage:plan.stage,
    planSha256:digest(plan),maximumCalls:plan.maximumCalls,
    maximumSpendCents:plan.maximumSpendCents,paidCalls:0,executable:false,
    ownershipAccuracy:null,accuracyStatus:plan.accuracyStatus,
    selectedChannels:plan.selections.length,
    deferredChannels:plan.selections.reduce((n,s)=>n+s.alternatives.filter(c=>!c.selected).length,0),
    sharedChannelScope:plan.sharedChannelScope??plan.capturePlan.sharedChannelScope,
    sharedChannelPairs:plan.selections.reduce((n,s)=>n+s.alternatives.filter(c=>c.sharedChannelConflict).length,0)};
  await save(root,'summary.json',summary);
  const columns=['artist','tier','profile_id','cm_artist','channel_id','youtube_url','selected',
    'disposition','shared_channel_conflict','shared_channel_claims','video_url','uploader_name',
    'uploader_receipt_sha256','raw_body_sha256','channel_type_label','identity_status'];
  const rows=plan.selections.flatMap(s=>s.alternatives.flatMap(c=>c.observations.map(obs=>{
    const a=plan.assessments?.find(a=>a.profileId===s.profileId&&a.channelId===c.channelId);
    return [s.artist,s.tier,s.profileId,s.cmArtist,c.channelId,c.url,c.selected,c.disposition,
      c.sharedChannelConflict,JSON.stringify(c.sharedChannelClaims),obs.videoUrl,obs.uploaderName,
      obs.receiptFileSha256,obs.rawBodySha256,a?.channelTypeLabel??'Channel type unresolved',
      a?.category??'unresolved'];
  })));
  const cell=value=>{
    let s=String(value??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';
  };
  await save(root,'identity-alternatives.csv','\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  console.log(JSON.stringify(summary));return plan;
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry)await prepareVideoIdentityCli(process.argv.slice(2));
