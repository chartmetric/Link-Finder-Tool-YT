// Local-only preparation; deliberately no --run or --authorize mode.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {identityArchivePath,identityJson} from './youtube-video-identity-source.mjs';
import {mixedIdentitySourceNames} from './youtube-mixed-identity-source.mjs';
import {prepareMixedIdentityPlan,mixedIdentityApprovalProposal} from './youtube-mixed-identity-plan.mjs';

const entry=fileURLToPath(import.meta.url);
async function bytes(name){
  identityArchivePath(name);
  let current='.';
  for(const part of name.split('/')){
    current=path.join(current,part);
    assert.equal((await fs.lstat(current)).isSymbolicLink(),false,'Symlink archive input');
  }
  return fs.readFile(name);
}
async function seal(root){
  const seen=new Set(),files={};await fs.mkdir(root+'/runtime');
  async function visit(file){
    if(seen.has(file))return;seen.add(file);
    assert.equal(path.dirname(file),path.dirname(entry));
    const b=await fs.readFile(file),name='runtime/'+path.basename(file);
    await fs.writeFile(root+'/'+name,b,{flag:'wx'});files[name]=digest(b);
    for(const m of b.toString('utf8').matchAll(/(?:from\s*|import\s*\()\s*['"](\.\/[^'"]+\.mjs)['"]/g))
      await visit(path.resolve(path.dirname(file),m[1]));
  }
  await visit(entry);return files;
}
async function save(root,name,value){
  const f=await fs.open(root+'/'+name,'wx');
  try{await f.writeFile(typeof value==='string'?value:JSON.stringify(value,null,2));await f.sync();}
  finally{await f.close();}
}
const cell=v=>{
  let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
export async function prepareMixedIdentityCli(args){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Workspace-only preparation');
  assert.equal(args.length,3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.includes('--prepare-only'));
  assert.ok(args.every(a=>a==='--prepare-only'||/^--(?:id|source-id)=[a-z0-9-]+$/.test(a)));
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  const id=value('id'),sourceId=value('source-id');
  assert.match(id??'',/^youtube-mixed-identity-[a-z0-9-]{4,80}$/);
  assert.match(sourceId??'',/^youtube-mixed-captures-[a-z0-9-]{4,80}$/);
  const sourceRoot='generated-artifacts/'+sourceId,root='generated-artifacts/'+id;
  const planBytes=await bytes(sourceRoot+'/plan.json'),capturePlan=identityJson(planBytes);
  assert.equal(capturePlan.id,sourceId);
  const source={id:sourceId,files:{}};
  for(const name of mixedIdentitySourceNames(capturePlan))source.files[name]=(await bytes(name)).toString('base64');
  assert.equal(source.files[sourceRoot+'/plan.json'],planBytes.toString('base64'));
  const input={id,preparedAt:new Date().toISOString(),source,
    runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}};
  prepareMixedIdentityPlan(input); // Fail before creating any misleading output.
  await fs.mkdir(root); // Exclusive new directory, never overwrite a stopped stage.
  input.runtimeFiles=await seal(root);
  const plan=prepareMixedIdentityPlan(input);
  // Close the read/write race on originals before committing the new proposal.
  for(const [name,base64] of Object.entries(source.files))
    assert.equal(digest(await bytes(name)),digest(Buffer.from(base64,'base64')),'Source changed during preparation');
  await save(root,'plan.json',plan);
  await save(root,'approval-proposal.json',mixedIdentityApprovalProposal(plan));
  const columns=['artist','tier','profile_id','cm_artist','channel_id','youtube_url','aliases',
    'channel_type_label','topic_association','category','policy_status','reason','model_request_sha256',
    'model_body_bytes','exceeds_legacy_6000_bytes','catalog_packet_sha256','capture_receipt_sha256',
    'capture_raw_sha256','ownership_accepted','import_eligible'];
  const rows=plan.assessments.map(a=>[a.artistName,a.tier,a.profileId,a.cmArtist,a.channelId,a.candidate.url,
    JSON.stringify(a.aliases),a.channelTypeLabel,a.topicAssociationStatus,a.category,a.decision.status,
    a.decision.reason,a.prepared?.requestSha256,a.prepared?.bytes,a.prepared?.exceedsLegacy6000Bytes,
    a.catalogPacketSha256,a.captureReceiptFileSha256,a.captureRawBodySha256,false,false]);
  await save(root,'identity-review.csv','\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  const summary={id,status:'prepared_not_approved',planSha256:digest(plan),
    captureSourceId:sourceId,capturedArtists:plan.assessments.length,
    proposedModelCalls:plan.maximumCalls,proposedMaximumSpendCents:plan.proposedMaximumSpendCents,
    proposedMaximumRequestBytes:plan.model.proposedMaximumRequestBytes,
    oversizedLegacyRequests:plan.operations.filter(o=>o.requestBytes>6000).length,
    supportedTopics:plan.assessments.filter(a=>a.category==='supported_topic').length,
    unresolvedTopics:plan.assessments.filter(a=>a.topicAssociationStatus==='unverified').length,
    policyHeld:plan.assessments.filter(a=>!a.prepared).length,
    uncapturedArtists:plan.uncapturedArtists.length,deferredAlternatives:plan.deferredAndHeldAlternatives.length,
    paidCalls:0,ledgerWrites:0,catalogWrites:0,acceptedLinks:0,executable:false,ownershipAccuracy:null,
    sourceCoordinatorReconciled:false};
  await save(root,'summary.json',summary);
  console.log(JSON.stringify(summary));return plan;
}
if(process.argv[1]&&path.resolve(process.argv[1])===entry)await prepareMixedIdentityCli(process.argv.slice(2));
