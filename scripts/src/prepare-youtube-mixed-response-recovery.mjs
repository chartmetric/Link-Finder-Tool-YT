// Preparation: read-only coordination/catalog plus NEW local sealed proposals.
// Offline audit mode does not connect to any database or provider.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {auditMixedSavedResponses,mixedRecoveryPlan,mixedRecoveryContinuation} from './youtube-mixed-response-recovery.mjs';
import {verifyMixedRecoveryArchives,mixedRecoveryQuiet,assertMixedRecoverySnapshot} from './youtube-mixed-response-recovery-live.mjs';
import {mixedCaptureReadiness,mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
async function seal(id,make){
  const root='generated-artifacts/'+id;
  await fs.mkdir(root); // Refuse overwrite, including incomplete preparation.
  const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'run-youtube-mixed-response-recovery.mjs');
  const files=await freezeLocalModules(entry,root+'/runtime'),runtimeFiles={};
  for(const f of files)runtimeFiles['runtime/'+path.basename(f)]=digest(await fs.readFile(root+'/runtime/'+path.basename(f)));
  const plan=make(runtimeFiles);
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  console.log(JSON.stringify({id,planSha256:digest(plan),status:'prepared_not_approved',
    maximumAdditionalCents:plan.maximumSpendCents??0,providerRequests:0,coordinatorWrites:0,catalogWrites:0}));
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>['--audit-offline','--prepare-only','--prepare-continuation'].includes(a)
    ||/^--(?:id|source-id|recovery-id|evidence)=[A-Za-z0-9_./-]+$/.test(a)));
  const modes=args.filter(a=>['--audit-offline','--prepare-only','--prepare-continuation'].includes(a));assert.equal(modes.length,1);
  if(modes[0]==='--audit-offline'){
    assert.equal(args.length,2);
    console.log(JSON.stringify(auditMixedSavedResponses(await read(value('evidence'))),null,2));return;
  }
  assert.equal(args.length,3);
  const id=value('id'),preparedAt=new Date().toISOString();
  if(modes[0]==='--prepare-only')assert.match(id??'',/^youtube-mixed-response-recovery-[a-z0-9-]{4,60}$/);
  else assert.match(id??'',/^youtube-mixed-captures-recovered-[a-z0-9-]{4,60}$/);
  const sourceId=value(modes[0]==='--prepare-only'?'source-id':'recovery-id');
  assert.match(sourceId??'',modes[0]==='--prepare-only'
    ?/^youtube-mixed-captures-[a-z0-9-]{4,80}$/:/^youtube-mixed-response-recovery-[a-z0-9-]{4,60}$/);
  const sourceRoot='generated-artifacts/'+sourceId,source=await read(sourceRoot+'/plan.json');
  const sourceApproval=await read(sourceRoot+'/approval.json');assert.equal(source.id,sourceId);
  const pool=await connectSavedBatchPool(),c=await pool.connect();let evidence;
  try{
    await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // No FOR UPDATE in preparation: the apply/dispatch gate must lock and
    // revalidate the entire snapshot again after exact operator approval.
    if(modes[0]==='--prepare-only'){
      await mixedCaptureReadiness(c,source,{ownRun:true});
      const run=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1',[sourceId])).rows[0];
      const admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1',[sourceId])).rows;
      const claims=(await c.query('SELECT * FROM youtube_video_identity_claims')).rows.map(r=>({
        alias:r.alias,channelId:r.channel_id,profileId:r.profile_id,cmArtist:r.cm_artist}));
      const savedResponses=[];
      for(const a of admissions){
        const file=sourceRoot+'/receipts/'+digest(a.operation_key)+'.json',bytes=await fs.readFile(file);
        const receipt=JSON.parse(bytes);
        assert.equal(receipt.rawPath,'receipts/'+digest(a.operation_key)+'.raw');
        savedResponses.push({receipt,receiptFileSha256:digest(bytes),
          rawBodyBase64:(await fs.readFile(sourceRoot+'/'+receipt.rawPath)).toString('base64')});
      }
      evidence=JSON.parse(JSON.stringify({plan:source,approval:sourceApproval,run,admissions,savedResponses,claims}));
      const audit=auditMixedSavedResponses(evidence),observed=audit.captures.flatMap(c=>c.observed);
      await mixedHistoricalClaims(c,observed);await identityCatalogCheck(source)(observed);
      const candidate=mixedRecoveryPlan({id,preparedAt,evidence,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}});
      await verifyMixedRecoveryArchives(candidate);
    }else{
      // Read-only projection of the locked checks; never acknowledge here.
      const readOnly={query:(sql,params)=>c.query(sql.replaceAll(' FOR UPDATE',''),params)};
      await mixedRecoveryQuiet(readOnly);
      await assertMixedRecoverySnapshot(readOnly,source,{requireRecovered:true});
      await verifyMixedRecoveryArchives(source);
      await mixedCaptureReadiness(c,source.evidence.plan,{ownRun:true});
      await identityCatalogCheck(source.evidence.plan)(source.audit.pending.map(o=>({
        alias:o.targetUrl,channelId:o.expectedChannelId,profileId:o.profileId,cmArtist:o.cmArtist})));
      // Validate the recovery approval before creating any continuation files.
      mixedRecoveryContinuation({id,preparedAt,recoveryPlan:source,recoveryApproval:sourceApproval,
        runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}});
    }
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
  await seal(id,runtimeFiles=>modes[0]==='--prepare-only'
    ?mixedRecoveryPlan({id,preparedAt,evidence,runtimeFiles})
    :mixedRecoveryContinuation({id,preparedAt,recoveryPlan:source,recoveryApproval:sourceApproval,runtimeFiles}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
