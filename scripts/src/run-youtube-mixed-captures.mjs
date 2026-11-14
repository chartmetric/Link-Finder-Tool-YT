// Exact channel metadata only. No models, searches, uploader calls or catalog writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateMixedCapturePlan,approveMixedCaptures} from './youtube-mixed-channel-captures.mjs';
import {mixedCaptureReadiness,mixedHistoricalClaims,assertMixedApproval,MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
import {videoIdentitySchema} from './youtube-video-identity-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const read=async file=>JSON.parse(await fs.readFile(file));
export function mixedClaims(plan){
  return plan.selections.map(s=>({alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist}));
}
export async function assertMixedFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  validateMixedCapturePlan(plan);assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [file,sha] of Object.entries(plan.runtimeFiles))assert.equal(digest(await fs.readFile(root+'/'+file)),sha);
  for(const [file,sha] of Object.entries(plan.sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
}
export async function executeMixedCaptures({root,plan,approval,pool,assertFrozen,checkCatalog,credential,
  fetchImpl=fetch,readinessCheck=mixedCaptureReadiness}){
  assertMixedApproval(plan,approval);assert.ok(typeof credential==='string'&&credential.length);
  await assertFrozen();await checkCatalog(mixedClaims(plan));
  const owner=randomUUID(),returns=[];let started=false;
  const transaction=async fn=>{
    const c=await pool.connect();try{await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[MIXED_PARENT])).rows[0]?.status,'stopped');
      const result=await fn(c);await c.query('COMMIT');return result;
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  };
  const locked=async c=>{
    const row=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
    assert.ok(row&&row.owner===owner&&row.status==='running'&&row.plan_sha256===digest(plan)
      &&row.approval_sha256===digest(approval)&&row.execution_sha256===digest(plan.runtimeFiles));
    assert.equal(row.cap_cents,plan.maximumSpendCents);
    return row;
  };
  try{
    await transaction(async c=>{
      await readinessCheck(c,plan);
      await c.query(`INSERT INTO youtube_video_identity_runs
        (id,owner,plan_sha256,approval_sha256,execution_sha256,cap_cents,status)
        VALUES($1,$2,$3,$4,$5,$6,'running')`,
      [plan.id,owner,digest(plan),digest(approval),digest(plan.runtimeFiles),plan.maximumSpendCents]);
    });started=true;
    await fs.mkdir(root+'/receipts');
    for(const op of plan.operations){
      await assertFrozen();await checkCatalog(mixedClaims(plan));
      await transaction(async c=>{
        const run=await locked(c);await readinessCheck(c,plan,{ownRun:true});
        const history=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1',[plan.id])).rows;
        assert.ok(history.every(h=>h.status==='returned'&&h.http_status===200));
        for(const h of history){
          const prior=plan.operations.find(o=>o.key===h.operation_key);assert.ok(prior);
          assert.equal(h.kind,'metadata');assert.equal(h.profile_id,prior.profileId);
          assert.equal(h.cm_artist,prior.cmArtist);assert.equal(h.channel_id,prior.allocationChannelKey);
          assert.equal(h.input_sha256,prior.inputSha256);assert.equal(h.reserved_cents,2);
          assert.match(h.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(h.raw_sha256,/^[a-f0-9]{64}$/);
        }
        assert.equal(run.reserved_cents,history.length*2);assert.ok(run.reserved_cents+2<=plan.maximumSpendCents);
        const claims=(await c.query(`SELECT profile_id,cm_artist FROM youtube_video_identity_claims
          WHERE lower(alias)=lower($1) OR channel_id=$2`,[op.targetUrl,op.expectedChannelId])).rows;
        assert.ok(claims.every(a=>a.profile_id===op.profileId&&a.cm_artist===op.cmArtist));
        await c.query(`INSERT INTO youtube_video_identity_admissions
          (run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,$5,'metadata',$6,2)`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.allocationChannelKey,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_video_identity_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2<=cap_cents`,[plan.id])).rowCount,1);
      });
      const response=await fetchImpl(op.request.url,{method:'GET',redirect:'error',
        headers:{'x-api-key':credential},signal:AbortSignal.timeout(120000)});
      const chunks=[];let length=0;
      if(response.body)for await(const chunk of response.body){length+=chunk.length;
        assert.ok(length<=2*1024*1024);chunks.push(chunk);}
      const raw=Buffer.concat(chunks),rawPath='receipts/'+digest(op.key)+'.raw';
      await durableStageFile(root+'/'+rawPath,raw);
      const receipt={runId:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
        operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,kind:'metadata',
        targetUrl:op.targetUrl,inputSha256:op.inputSha256,request:op.request,
        capturedAt:new Date().toISOString(),status:response.status,rawPath,rawBodySha256:digest(raw)};
      await durableStageFile(root+'/receipts/'+digest(op.key)+'.json',JSON.stringify(receipt));
      assert.equal(response.status,200);const body=JSON.parse(raw);
      assert.equal(body.success,true);assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
      const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
        operationKey:op.key,request:op.request,inputSha256:op.inputSha256,data:body},op.targetUrl);
      const bound=boundYoutubeCapture(op.targetUrl,capture);assert.ok(bound);
      if(op.expectedChannelId)assert.equal(bound.body.channelId,op.expectedChannelId);
      const observed=bound.aliases.map(alias=>({alias,channelId:bound.body.channelId,profileId:op.profileId,cmArtist:op.cmArtist}));
      await checkCatalog([...mixedClaims(plan),...observed]);
      await transaction(async c=>{
        await locked(c);
        await mixedHistoricalClaims(c,[...mixedClaims(plan),...observed]);
        const known=(await c.query(`SELECT profile_id,cm_artist FROM youtube_video_identity_claims
          WHERE channel_id=$1 OR lower(alias)=ANY($2::text[])`,
        [bound.body.channelId,bound.aliases.map(s=>s.toLowerCase())])).rows;
        assert.ok(known.every(r=>r.profile_id===op.profileId&&r.cm_artist===op.cmArtist));
        for(const claim of observed)await c.query(`INSERT INTO youtube_video_identity_claims(alias,channel_id,profile_id,cm_artist)
          VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[claim.alias,claim.channelId,claim.profileId,claim.cmArtist]);
        assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
          receipt_sha256=$3,raw_sha256=$4,http_status=200 WHERE run_id=$1 AND operation_key=$2 AND status='admitted'`,
        [plan.id,op.key,digest(receipt),digest(raw)])).rowCount,1);
      });
      returns.push({receipt,capture,ownershipAccepted:false,importEligible:false});
      console.log(JSON.stringify({phase:'channel_captures',completed:returns.length,total:plan.maximumCalls}));
    }
    await durableStageFile(root+'/returns.json',JSON.stringify({planSha256:digest(plan),returns},null,2));
    await transaction(async c=>{await locked(c);assert.equal(returns.length,plan.maximumCalls);
      await c.query("UPDATE youtube_video_identity_runs SET status='completed' WHERE id=$1",[plan.id]);});
  }catch(error){
    if(started)await transaction(async c=>{
      await c.query(`UPDATE youtube_video_identity_runs SET status='stopped'
        WHERE id=$1 AND owner=$2 AND plan_sha256=$3 AND status='running'`,
      [plan.id,owner,digest(plan)]);});
    throw error;
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-mixed-captures-[a-z0-9-]{4,80}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertMixedFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveMixedCaptures(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=await read(root+'/approval.json'),pool=await connectSavedBatchPool();
  try{
    assertMixedApproval(plan,approval);
    // This setup is deferred until explicit execution approval. Preparation
    // verifies table absence read-only and never creates coordinator records.
    const setup=await pool.connect();
    try{await setup.query('BEGIN');
      assert.equal((await setup.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [MIXED_PARENT])).rows[0]?.status,'stopped');
      await setup.query(videoIdentitySchema);await setup.query('COMMIT');
    }catch(error){await setup.query('ROLLBACK');throw error;}finally{setup.release();}
    await executeMixedCaptures({root,plan,approval,pool,credential:process.env.SCRAPECREATORS_API_KEY,
    checkCatalog:identityCatalogCheck(plan),assertFrozen:async()=>{
      await assertMixedFrozen(root,plan);assert.deepEqual(await read(root+'/approval.json'),approval);
    }});}finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
