import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {channelSuffix,recoveredChannelSnapshot} from './youtube-channel-fast-continuation.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
import {MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {assertZeroOriginalChannelAttempt} from './youtube-accounted-channel-groups.mjs';
export async function sourceChannelSnapshot(c,source){
  const ids=source.groups.map(g=>g.id);
  const runs=(await c.query(`SELECT id,owner,status,plan_sha256,approval_sha256,execution_sha256,cap_cents,reserved_cents
    FROM youtube_video_identity_runs WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows;
  const admissions=(await c.query(`SELECT run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,
    reserved_cents,status,http_status,receipt_sha256,raw_sha256 FROM youtube_video_identity_admissions
    WHERE run_id=ANY($1::text[]) ORDER BY run_id,operation_key`,[ids])).rows;
  return {runs,admissions};
}
export async function verifySourceChannelReceipts(source,snapshot){
  for(const a of snapshot.admissions){
    const group=source.groups.find(g=>g.id===a.run_id);assert.ok(group);
    const op=group.operations.find(o=>o.key===a.operation_key);assert.ok(op);
    const root='generated-artifacts/'+source.id+'/part-'+(group.groupIndex+1);
    const receipt=JSON.parse(await fs.readFile(root+'/receipts/'+digest(op.key)+'.json'));
    assert.equal(digest(receipt),a.receipt_sha256);
    assert.equal(receipt.approvalSha256,snapshot.runs.find(r=>r.id===group.id).approval_sha256);
    for(const [key,value] of Object.entries({runId:group.id,planSha256:digest(group),
      operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',targetUrl:op.targetUrl,
      inputSha256:op.inputSha256,status:200,rawPath:'receipts/'+digest(op.key)+'.raw'}))
      assert.equal(receipt[key],value);
    assert.deepEqual(receipt.request,op.request);
    const raw=await fs.readFile(root+'/'+receipt.rawPath);
    assert.equal(digest(raw),a.raw_sha256);assert.equal(digest(raw),receipt.rawBodySha256);
    const body=JSON.parse(raw);assert.equal(body.success,true);
    assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
  }
}
// The parent-row lock serializes this switch with the old worker's admissions
// and acknowledgments. Never fence a run while a request is in flight.
export async function handoverChannels({pool,plan,root,assertFrozen,waitMs=180000,
  delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  const start=Date.now();
  for(;;){
    await assertFrozen();const c=await pool.connect();let retry=false;
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [MIXED_PARENT])).rows[0]?.status,'stopped');
      await assertZeroOriginalChannelAttempt(c,plan.sourcePlan);
      const snapshot=await sourceChannelSnapshot(c,plan.sourcePlan);
      const running=snapshot.runs.filter(r=>r.status==='running');
      assert.ok(running.length<=1);
      assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_runs
        WHERE status='running' AND id<>ALL($1::text[])`,[plan.sourcePlan.groups.map(g=>g.id)])).rows[0].n,0,
      'Another identity stage is running');
      if(!plan.savedResponseRecovery&&(snapshot.admissions.some(a=>a.status!=='returned')||
        (!running.length&&!snapshot.runs.some(r=>r.status==='stopped')&&
          snapshot.admissions.length<plan.maximumCalls))){
        await c.query('ROLLBACK');retry=true;
      }else{
        const fenced=plan.savedResponseRecovery?recoveredChannelSnapshot(plan,snapshot):structuredClone(snapshot);
        if(running.length)fenced.runs.find(r=>r.id===running[0].id).status='stopped';
        const suffix=channelSuffix(plan,fenced);
        await verifySourceChannelReceipts(plan.sourcePlan,fenced);
        if(plan.savedResponseRecovery){
          assert.equal(running.length,0);
          const r=plan.savedResponseRecovery;
          assert.equal(digest(await fs.readFile(r.receiptPath)),r.receiptFileSha256);
          assert.equal(digest(await fs.readFile(r.rawPath)),r.rawFileSha256);
        }
        const cutover={sourceId:plan.sourcePlan.id,planSha256:digest(plan),capturedAt:new Date().toISOString(),
          snapshot:fenced,priorReservedCents:suffix.priorReservedCents,paidCount:suffix.paidCount,
          pendingCount:suffix.pendingCount,noRequestsInFlight:true,noPaidReplays:true,
          ...(plan.savedResponseRecovery?{heldResponse:{runId:plan.savedResponseRecovery.runId,
            operationKey:plan.savedResponseRecovery.operationKey,reason:'Conflicting catalog artist claim',
            ownershipAccepted:false,importEligible:false,transportReceivedOnly:true}}:{})};
        await durableStageFile(root+'/cutover.json',JSON.stringify(cutover,null,2));
        if(plan.savedResponseRecovery){
          const r=plan.savedResponseRecovery;
          assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
            receipt_sha256=$3,raw_sha256=$4,http_status=200 WHERE run_id=$1 AND operation_key=$2
            AND status='admitted' AND receipt_sha256 IS NULL AND raw_sha256 IS NULL AND http_status IS NULL`,
          [r.runId,r.operationKey,r.receiptSha256,r.rawSha256])).rowCount,1);
        }
        if(running.length)assert.equal((await c.query(`UPDATE youtube_video_identity_runs SET status='stopped'
          WHERE id=$1 AND owner=$2 AND status='running'`,[running[0].id,running[0].owner])).rowCount,1);
        await c.query('COMMIT');return cutover;
      }
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    assert.ok(retry&&Date.now()-start<waitMs,'No safe handover boundary; original work was not interrupted');
    await delay(1000);
  }
}
export async function fastChannelReadiness(c,plan,cutover,suffix,group,options={}){
  await assertZeroOriginalChannelAttempt(c,plan.sourcePlan);
  assert.deepEqual(await sourceChannelSnapshot(c,plan.sourcePlan),cutover.snapshot,
    'Historical channel accounting changed after handover');
  await accountedChannelReadiness(c,group,options);
  const runs=(await c.query(`SELECT id,status,plan_sha256,cap_cents,reserved_cents
    FROM youtube_video_identity_runs WHERE id=ANY($1::text[])`,[suffix.groups.map(g=>g.id)])).rows;
  let total=cutover.priorReservedCents;
  for(const run of runs){
    const g=suffix.groups.find(g=>g.id===run.id);assert.ok(g&&g.groupIndex<=group.groupIndex);
    assert.equal(run.plan_sha256,digest(g));assert.equal(run.cap_cents,g.maximumSpendCents);
    assert.ok(run.reserved_cents>=0&&run.reserved_cents<=g.maximumSpendCents);
    if(g.groupIndex<group.groupIndex){assert.equal(run.status,'completed');assert.equal(run.reserved_cents,g.maximumSpendCents);}
    else assert.ok(options.ownRun&&run.status==='running','New group was already attempted');
    total+=run.reserved_cents;
  }
  for(const earlier of suffix.groups.slice(0,group.groupIndex))
    assert.ok(runs.some(r=>r.id===earlier.id&&r.status==='completed'));
  assert.ok(total<=plan.combinedMaximumSpendCents);
  const admissions=(await c.query(`SELECT run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,
    reserved_cents,status,http_status FROM youtube_video_identity_admissions WHERE run_id=ANY($1::text[])`,
  [suffix.groups.map(g=>g.id)])).rows;
  assert.equal(admissions.reduce((n,a)=>n+a.reserved_cents,0)+cutover.priorReservedCents,total);
  for(const a of admissions){
    const g=suffix.groups.find(g=>g.id===a.run_id),o=g.operations.find(o=>o.key===a.operation_key);assert.ok(o);
    for(const [key,value] of Object.entries({profile_id:o.profileId,cm_artist:o.cmArtist,
      channel_id:o.allocationChannelKey,kind:'metadata',input_sha256:o.inputSha256,reserved_cents:2,
      status:'returned',http_status:200}))assert.equal(a[key],value);
  }
}
