// Operator-only recovery. Importing this module does not connect or dispatch.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {YOUTUBE_CAMPAIGN_ID as id,YOUTUBE_CAMPAIGN_ROOT as root} from './youtube-campaign-core.mjs';
import {readJson,immutableJson,recoverySchema,recoveryStore,reconcileRecovery,
  claimRecovery,approveRecovery,verifyRecoveryEvidence} from './youtube-campaign-recovery-core.mjs';
import {executeRecovery} from './youtube-campaign-recovery-worker.mjs';

async function runtimeHashes(directory){
  const files=(await fs.readdir(directory)).filter(f=>f.endsWith('.mjs')).sort();
  return Object.fromEntries(await Promise.all(files.map(async file=>[
    file,evidenceDigest(await fs.readFile(path.join(directory,file),'utf8'))])));
}
function recoveryDirectory(owner){
  assert.match(owner,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  return root+'/recoveries/'+owner;
}
export async function validateRecoveryFiles(directory,plan){
  assert.equal(plan.version,1);assert.equal(plan.campaignId,id);
  assert.equal(directory,recoveryDirectory(plan.owner));
  assert.equal(plan.noCatalogWrites,true);assert.equal(plan.noAutomaticRetries,true);
  assert.deepEqual(await runtimeHashes(directory+'/runtime'),plan.runtimeFingerprints,'Recovery runtime changed.');
  assert.equal(evidenceDigest(await readJson(root+'/queue.json')),plan.scopeSha256);
  assert.equal(evidenceDigest(await readJson(root+'/approval.json')),plan.originalApprovalSha256);
  assert.equal(evidenceDigest(await readJson(directory+'/plan.json')),evidenceDigest(plan),'Recovery plan changed.');
}
export async function prepareRecovery({pool,priorOwner,operator,drainEvidence}){
  assert.ok(operator?.trim()&&drainEvidence?.trim(),'Name the operator and how prior-worker drain was confirmed.');
  assert.match(priorOwner,/^[a-f0-9-]{36}$/);
  // A separate table only. No migration or update to active worker tables.
  await pool.query(recoverySchema);
  const store=recoveryStore(pool,id),owner=randomUUID(),directory=recoveryDirectory(owner);
  await fs.mkdir(root+'/recoveries',{recursive:true});
  await fs.mkdir(directory,{recursive:false});
  await freezeLocalModules(fileURLToPath(import.meta.url),directory+'/runtime');
  let plan;
  await store.transaction(async state=>{
    assert.equal(state.campaign.owner,priorOwner,'Operator drain attestation must name the exact prior owner.');
    const approval=await readJson(root+'/approval.json'),queue=await readJson(root+'/queue.json');
    plan={version:1,campaignId:id,owner,priorOwner,createdAt:new Date().toISOString(),
      scopeSha256:evidenceDigest(queue),originalApprovalSha256:evidenceDigest(approval),
      drained:{confirmed:true,priorOwner,operator,evidence:drainEvidence,at:new Date().toISOString()},
      noCatalogWrites:true,noAutomaticRetries:true,maximumSpendCents:null,
      runtimeFingerprints:await runtimeHashes(directory+'/runtime'),
      reconciliation:await reconcileRecovery({root,snapshot:state,queue,approval})};
    // Freeze first. A crash before DB claim leaves an inert unapproved file;
    // a crash after commit cannot replace the owner with a competing plan.
    await immutableJson(directory+'/plan.json',plan);
  });
  await claimRecovery(store,plan);
  return {owner,planSha256:evidenceDigest(plan),directory,blockers:plan.reconciliation.blockers,paidCalls:0};
}
export async function main(args=process.argv.slice(2)){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Recovery is an explicit workspace operator action.');
  const allowed=new Set(['--prepare-recovery','--approve-recovery','--resume-recovery','--prior-worker-drained',
    '--uncapped-approved','--prior-owner','--operator','--drain-evidence','--owner','--plan-sha256']);
  const flags=new Set(['--prepare-recovery','--approve-recovery','--resume-recovery','--prior-worker-drained','--uncapped-approved']);
  const options={};
  for(const arg of args){
    const at=arg.indexOf('='),key=at<0?arg:arg.slice(0,at),value=at<0?true:arg.slice(at+1);
    assert.ok(allowed.has(key)&&!(key in options),'Unknown or repeated recovery argument.');
    assert.equal(flags.has(key),at<0,'Flags and named values must use the documented form.');
    options[key]=value;
  }
  const modes=['--prepare-recovery','--approve-recovery','--resume-recovery'].filter(k=>options[k]);
  assert.equal(modes.length,1,'Choose exactly one explicit recovery action.');
  if(options['--prepare-recovery']){
    assert.equal(options['--prior-worker-drained'],true,'Drain the prior worker before preparing recovery.');
  }else{
    assert.ok(options['--owner']);assert.match(options['--plan-sha256']??'',/^[a-f0-9]{64}$/);
    assert.equal(options['--uncapped-approved'],true);
    if(options['--approve-recovery'])assert.ok(options['--operator']?.trim());
  }
  const pool=await connectSavedBatchPool();
  try{
    if(options['--prepare-recovery']){
      console.log(JSON.stringify(await prepareRecovery({pool,priorOwner:options['--prior-owner'],
        operator:options['--operator'],drainEvidence:options['--drain-evidence']})));return;
    }
    const directory=recoveryDirectory(options['--owner']),plan=await readJson(directory+'/plan.json');
    assert.equal(evidenceDigest(plan),options['--plan-sha256']);
    await validateRecoveryFiles(directory,plan);
    const store=recoveryStore(pool,id);
    if(options['--approve-recovery']){
      const approvalFile=directory+'/resume-approval.json';
      // Persist the exact operator attestation before its transactional commit.
      // Retry of this approval action is safe and never starts a worker.
      let approval;
      try{approval=await readJson(approvalFile);assert.equal(approval.approvedBy,options['--operator']);}
      catch(e){if(e.code!=='ENOENT')throw e;
        approval={planSha256:evidenceDigest(plan),owner:plan.owner,priorOwner:plan.priorOwner,
          explicitApproval:true,uncappedApproved:true,approvedBy:options['--operator'],at:new Date().toISOString()};
        await immutableJson(approvalFile,approval);
      }
      await approveRecovery(store,plan,approval,state=>verifyRecoveryEvidence(root,plan,state));
      console.log(JSON.stringify({status:'approved_not_started',owner:plan.owner,paidCalls:0}));return;
    }
    // A resume must execute the newly sealed runtime, not mutable source or
    // the previous worker's sealed directory.
    assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(directory,'runtime'));
    for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])
      assert.ok(process.env[key],'A required provider credential is unavailable.');
    await executeRecovery({pool,root,directory,plan,
      assertFrozen:()=>validateRecoveryFiles(directory,plan),
      credentials:{serper:process.env.SERPERDEV_API_KEY,scrapecreators:process.env.SCRAPECREATORS_API_KEY,
        openrouter:process.env.OPENROUTER_API_KEY}});
    console.log(JSON.stringify({status:'completed',owner:plan.owner,reservationsRetained:true}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}
  catch{console.error('YouTube recovery refused or stopped. Preserve evidence; no automatic retry or refund.');process.exitCode=1;}
}
