// Read-only measurements and sealing. No worker fencing, ledger writes or paid calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {holdChannelPlan,holdGroupApproval} from './youtube-channel-hold-continuation.mjs';
import {speedSwitchPlan,speedSuffix} from './youtube-channel-speed-switch.mjs';
import {readSourceHolds} from './run-youtube-channel-speed-switch.mjs';
import {sourceChannelSnapshot,verifySourceChannelReceipts} from './youtube-channel-fast-live.mjs';
import {assertHoldHistory} from './run-youtube-channel-hold-continuation.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function prepareSpeedSwitch(){
  const id='youtube-channel-speed-switch-safe-suffix-2026-11-16',root='generated-artifacts/'+id;
  try{await fs.lstat(root);assert.fail('Fresh sealed output required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const oldRoot='generated-artifacts/youtube-channel-hold-continuation-136-2026-11-16';
  const sourcePlan=deepFreeze(await read(oldRoot+'/plan.json')),sourceApproval=deepFreeze(await read(oldRoot+'/approval.json'));
  let at=performance.now();assert.deepEqual(holdChannelPlan(sourcePlan),sourcePlan);
  const historyValidationOnceMs=Math.round(performance.now()-at);
  at=performance.now();holdGroupApproval(sourcePlan,sourceApproval,sourcePlan.groups[0]);
  const groupApprovalFirstMs=Math.round(performance.now()-at);
  at=performance.now();for(let i=0;i<100;i++)holdGroupApproval(sourcePlan,sourceApproval,sourcePlan.groups[0]);
  const groupApproval100RepeatsMs=Math.round(performance.now()-at);
  const sourceFiles={...sourcePlan.sourceFiles};
  for(const f of ['plan.json','approval.json','run-started.json','recovery-applied.json'])
    sourceFiles[oldRoot+'/'+f]=digest(await fs.readFile(oldRoot+'/'+f));
  for(const [f,sha] of Object.entries(sourcePlan.runtimeFiles))sourceFiles[oldRoot+'/'+f]=sha;
  const verify=frozenFileVerifier(sourceFiles);await verify();
  const pool=await connectSavedBatchPool();let snapshot,holds;
  try{
    for(let attempt=0;attempt<30;attempt++){
      const c=await pool.connect();let stable=false;
      try{
        await c.query('BEGIN READ ONLY');await c.query("SET LOCAL statement_timeout='15000'");
        await assertHoldHistory(c,sourcePlan,true);
        snapshot=await sourceChannelSnapshot(c,sourcePlan);
        if(snapshot.admissions.every(a=>a.status==='returned')){
          holds=(await readSourceHolds(sourcePlan)).holds;
          const after=await sourceChannelSnapshot(c,sourcePlan);
          stable=digest(snapshot)===digest(after);
        }
        await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
      if(stable)break;
      assert.ok(attempt<29,'Could not observe a settled read-only preparation boundary');
      await new Promise(r=>setTimeout(r,2000));
    }
  }finally{await pool.end();}
  const projected=structuredClone(snapshot);
  for(const r of projected.runs)if(r.status==='running')r.status='stopped';
  await verifySourceChannelReceipts(sourcePlan,projected);
  await fs.mkdir(root);
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-speed-switch.mjs'),root+'/runtime'),runtimeFiles={};
  for(const f of modules){const name='runtime/'+path.basename(f);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));}
  const plan=deepFreeze(speedSwitchPlan({id,preparedAt:new Date().toISOString(),
    sourcePlan,sourceApproval,sourceFiles,runtimeFiles,
    preparationSnapshot:deepFreeze(snapshot),preparationHolds:deepFreeze(holds)}));
  const suffix=speedSuffix(plan,deepFreeze(projected),deepFreeze(holds));
  const benchmark={previouslyMeasuredGroupApprovalMs:83873,historyValidationOnceMs,
    groupApprovalFirstMs,groupApproval100RepeatsMs,
    note:'Measures local history validation only, not paid provider throughput or total completion time.'};
  const summary={id,status:'prepared_not_approved',sourceChecksPaidAtPreparation:suffix.paid,
    sourceChecksSetAsideWithoutSpending:suffix.unspentHolds,remainingAtPreparation:suffix.remaining,
    priorReservedAtPreparationCents:suffix.priorReservedCents,
    maximumRemainingAtPreparationCents:suffix.maximumRemainingCents,combinedCapCents:plan.combinedCapCents,
    exactRemainderSelectedAtLockedHandover:true,benchmark,activeWorkerChanged:false,
    paidCalls:0,ledgerWrites:0,catalogWrites:0,planSha256:digest(plan)};
  await fs.writeFile(root+'/plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
  await fs.writeFile(root+'/preparation.json',JSON.stringify(summary,null,2),{flag:'wx'});
  await verify();return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareSpeedSwitch()));
}
