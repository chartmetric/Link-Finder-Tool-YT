// Separate, explicitly approved recovery. Never edits an already sealed worker.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {CATALOG_RETRY_POLICY} from './campaign-parallel-catalog.mjs';
const load=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export async function compileCatalogRecovery({parentRuntime,runtime,parentFiles,moduleFile,nodeModules,hash}){
  await fs.mkdir(runtime,{recursive:false});
  for(const [name,sha] of Object.entries(parentFiles)){
    assert.equal(path.basename(name),name);
    const source=await fs.readFile(path.join(parentRuntime,name),'utf8');
    assert.equal(hash(source),sha,'Prior sealed runtime changed');
    await fs.writeFile(path.join(runtime,name),source,{flag:'wx'});
  }
  const replacements={
    'campaign-parallel-resume.mjs':[
      "import {select} from './instagram-artist-metadata-overlay.mjs';",
      "import {catalogSelect as select} from './campaign-parallel-catalog.mjs';"],
    'campaign-parallel-adapters.mjs':[
      "import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';",
      "import {metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';\nimport {catalogSelect as select} from './campaign-parallel-catalog.mjs';"],
  };
  for(const [name,[before,after]] of Object.entries(replacements)){
    const file=path.join(runtime,name),source=await fs.readFile(file,'utf8');
    assert.equal(source.split(before).length,2,'Unexpected inherited catalog binding');
    await fs.writeFile(file,source.replace(before,after));
  }
  assert.ok(!Object.hasOwn(parentFiles,'campaign-parallel-catalog.mjs'));
  await fs.copyFile(moduleFile,path.join(runtime,'campaign-parallel-catalog.mjs'));
  await fs.symlink(nodeModules,path.join(runtime,'node_modules'),'dir');
  const runtimeFiles={},changed=[];
  for(const name of (await fs.readdir(runtime)).filter(n=>n.endsWith('.mjs')).sort()){
    runtimeFiles[name]=hash(await fs.readFile(path.join(runtime,name),'utf8'));
    if(parentFiles[name]&&runtimeFiles[name]!==parentFiles[name])changed.push(name);
  }
  assert.deepEqual(changed.sort(),Object.keys(replacements).sort());
  return {runtimeFiles,changed,added:['campaign-parallel-catalog.mjs']};
}
async function prepare(previousPhase){
  assert.ok(process.argv.includes('--prepare-approved'));
  const root='generated-artifacts/instagram-tier-priority',parent=path.resolve(previousPhase);
  assert.equal(path.dirname(parent),path.resolve(root));
  assert.match(path.basename(parent),/^parallel-[a-f0-9-]{36}$/);
  const prior=await load(parent+'/approval.json'),stopped=await load(parent+'/stopped.json');
  const launched=await load(parent+'/launched.json');
  assert.equal(prior.platform,'instagram');assert.equal(prior.approvedResume,true);
  assert.equal(stopped.allLanesDrained,true);
  const core=await import(pathToFileURL(parent+'/runtime/campaign-parallel-core.mjs'));
  const {evidenceDigest:hash}=await import(pathToFileURL(parent+'/runtime/youtube-ownership-policy.mjs'));
  for(const [name,sha] of Object.entries(prior.runtimeFiles))
    assert.equal(hash(await fs.readFile(parent+'/runtime/'+name,'utf8')),sha);
  const cfg=core.CAMPAIGNS.instagram,approval=await load(root+'/approval.json'),queue=await load(root+'/queue.json');
  assert.equal(prior.campaignId,cfg.id);assert.equal(approval.maximumSpendCents,null);
  assert.equal(prior.scopeSha256,hash(queue));assert.equal(prior.approvalSha256,hash(approval));
  const {connectSavedBatchPool}=await import(pathToFileURL(parent+'/runtime/instagram-saved-batch-gate.mjs'));
  const pool=await connectSavedBatchPool();let ledger;
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
      await c.query("SET LOCAL statement_timeout='30s'");
      await c.query('SELECT id FROM instagram_priority_runs WHERE id=$1 FOR UPDATE',[cfg.id]);
      const legacy=(await c.query('SELECT * FROM instagram_campaign_budgets WHERE id=$1 FOR UPDATE',[cfg.id])).rows[0];
      assert.equal(legacy.owner,approval.parentOwner);assert.equal(legacy.scope_sha256,approval.parentScopeSha256);
      assert.equal(legacy.cap_cents,null);
      const cents=(await c.query(`SELECT coalesce(sum(b.reserved_cents),0)::int n FROM instagram_campaign_children c
        JOIN instagram_saved_batch_budgets b ON b.id=c.budget_id WHERE c.campaign_id=$1`,[cfg.id])).rows[0].n;
      assert.equal(cents,approval.legacyReservedCents);
      ledger=await core.ledgerProof(c,cfg);
      assert.equal(ledger.run.owner,launched.owner);
      assert.equal(ledger.run.approval_sha256,hash(approval));assert.equal(ledger.run.scope_sha256,hash(queue));
      const bindings=new Map(queue.map((a,i)=>[a.profile_id,{...a,ordinal:i}]));
      for(const a of ledger.artists){
        const expected=bindings.get(a.profile_id);assert.ok(expected);
        assert.equal(a.cm_artist,expected.cm_artist);assert.equal(a.tier,Number(expected.tier));
        assert.equal(a.ordinal,expected.ordinal);
      }
      await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  }finally{await pool.end();}
  console.log(JSON.stringify({stage:'full_archive_verification',admissions:ledger.admissions.length,
    completedArtists:ledger.artists.filter(a=>a.status==='completed').length,paidRequests:0}));
  await core.verifyArchive(cfg,ledger);
  const phase=root+'/parallel-'+randomUUID();await fs.mkdir(phase);
  const compiled=await compileCatalogRecovery({parentRuntime:parent+'/runtime',runtime:phase+'/runtime',
    parentFiles:prior.runtimeFiles,moduleFile:path.join(path.dirname(fileURLToPath(import.meta.url)),'campaign-parallel-catalog.mjs'),
    nodeModules:path.resolve('scripts/node_modules'),hash});
  const manifest={...prior,at:new Date().toISOString(),before:ledger.proof,runtimeFiles:compiled.runtimeFiles,
    approvedBy:'User selected Fix and resume safely: limited catalog-read retries, full receipt checks, then untouched Instagram work.',
    catalogRecovery:{previousPhase:previousPhase,previousApprovalSha256:hash(prior),retryPolicy:CATALOG_RETRY_POLICY,
      changedModules:compiled.changed,addedModules:compiled.added,matchingPolicyUnchanged:true,noPaidProviderRetries:true}};
  await fs.writeFile(phase+'/approval.json',JSON.stringify(manifest),{flag:'wx'});
  await fs.writeFile(phase+'/recovery-proof.json',JSON.stringify({at:manifest.at,
    priorApprovalSha256:hash(prior),sourceApprovalSha256:hash(approval),scopeSha256:hash(queue),
    fullReceiptsVerified:ledger.admissions.length,completedResultsVerified:ledger.artists.filter(a=>a.status==='completed').length,
    before:ledger.proof,changedModules:compiled.changed,addedModules:compiled.added,
    matchingPolicyUnchanged:true,terminalArtistsUnchanged:true,providerRequestsDuringPreparation:0}),{flag:'wx'});
  console.log(JSON.stringify({stage:'prepared',phase,preservedAdmissions:ledger.admissions.length,
    matchingPolicyUnchanged:true,paidRequests:0}));
  return phase;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const flag=process.argv.indexOf('--previous-phase');assert.ok(flag>0&&process.argv[flag+1]);
  const phase=await prepare(process.argv[flag+1]);
  if(process.argv.includes('--resume-after-checks-approved')){
    const child=spawn(process.execPath,[phase+'/runtime/campaign-parallel-resume.mjs',
      '--run-approved','--uncapped-approved',phase],{stdio:'inherit'});
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);
      child.once('exit',(code,signal)=>resolve({code,signal}));});
    if(exit.code!==0)throw Error('Approved continuation stopped; inspect its saved diagnostic. No automatic replay.');
  }
}
