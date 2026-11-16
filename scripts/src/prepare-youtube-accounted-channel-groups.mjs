// No paid calls or database writes. Preserve the failed launch and approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {accountedChannelGroups,accountedGroupReadiness} from './youtube-accounted-channel-groups.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const id='youtube-accounted-channel-groups-265-2026-11-16',root='generated-artifacts/'+id;
const oldRoot='generated-artifacts/youtube-accounted-channel-checks-500-2026-11-16';
const read=async f=>JSON.parse(await fs.readFile(f));
const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value,null,2),{flag:'wx'});
export async function prepareAccountedChannelGroups(){
  try{await fs.lstat(root);assert.fail('Fresh preparation required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourcePlan=await read(oldRoot+'/plan.json'),sourceApproval=await read(oldRoot+'/approval.json');
  const originalRuntime=await import('../../'+oldRoot+'/runtime/run-youtube-accounted-channel-checks.mjs');
  await originalRuntime.assertAccountedChannelFrozen(oldRoot,sourcePlan);
  const pool=await connectSavedBatchPool();let c,previousAttempt;
  try{
    c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    previousAttempt={runs:(await c.query(`SELECT id,status,reserved_cents,cap_cents
      FROM youtube_video_identity_runs WHERE id=$1`,[sourcePlan.id])).rows,
      admissions:(await c.query(`SELECT count(*)::int n,coalesce(sum(reserved_cents),0)::int reserved_cents
        FROM youtube_video_identity_admissions WHERE run_id=$1`,[sourcePlan.id])).rows};
    assert.equal(previousAttempt.runs.length,0);assert.deepEqual(previousAttempt.admissions,[{n:0,reserved_cents:0}]);
    // Inspect the actual coordinator constraint, rather than assuming a large
    // exact aggregate also fits in a single legacy run.
    const constraints=(await c.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='youtube_video_identity_runs'::regclass AND conname='youtube_video_identity_runs_cap_cents_check'`)).rows;
    assert.ok(constraints.some(r=>/cap_cents <= 40/.test(r.definition)));
    previousAttempt.coordinatorConstraints=constraints;
    await c.query('COMMIT');
  }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
  await identityCatalogCheck(sourcePlan)(sourcePlan.selections.map(s=>({
    alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist})));
  await fs.mkdir(root);
  await save('previous-zero-paid-attempt.json',previousAttempt);
  const sourceFiles={...sourcePlan.sourceFiles};
  for(const file of [oldRoot+'/plan.json',oldRoot+'/approval.json',oldRoot+'/run-started.json',
    root+'/previous-zero-paid-attempt.json'])sourceFiles[file]=digest(await fs.readFile(file));
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-accounted-channel-groups.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){
    const key='runtime/'+path.basename(file);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));
  }
  const plan=accountedChannelGroups({id,preparedAt:new Date().toISOString(),sourcePlan,sourceApproval,
    previousAttempt,sourceFiles,runtimeFiles});
  assert.equal(plan.maximumCalls,265);assert.equal(plan.maximumSpendCents,530);
  const p=await connectSavedBatchPool();let client;
  try{
    client=await p.connect();await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // Every target is revalidated; only the first group can be at the live
    // sequential-dispatch boundary before the prior groups have executed.
    await accountedGroupReadiness(client,plan,plan.groups[0],{preparationOnly:true});
    assert.equal((await client.query('SELECT count(*)::int n FROM youtube_video_identity_runs WHERE id=ANY($1::text[])',
      [plan.groups.map(g=>g.id)])).rows[0].n,0);
    await client.query('COMMIT');
  }catch(e){if(client)await client.query('ROLLBACK');throw e;}finally{client?.release();await p.end();}
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await save('plan.json',plan);
  const summary={id,status:'prepared_not_approved',channelChecks:plan.maximumCalls,groups:plan.groups.length,
    maximumPerGroupCalls:Math.max(...plan.groups.map(g=>g.maximumCalls)),
    maximumAdditionalCents:plan.maximumSpendCents,previousPaidCalls:0,previousReservedCents:0,
    requestsUnchanged:true,planSha256:digest(plan),paidCalls:0,ledgerWrites:0,catalogWrites:0};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);
  console.log(JSON.stringify(await prepareAccountedChannelGroups()));
}
