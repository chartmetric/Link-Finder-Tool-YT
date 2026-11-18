import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {coverageRecoveryPlan} from './youtube-coverage-recovery.mjs';
import {COVERAGE_EXECUTION,COVERAGE_LIMITS,CoverageLimit,validateCoverageApproval,
  recoveryQueues,recoverCoverageArtist} from './youtube-coverage-execution.mjs';
import {coverageGate,coverageRequest} from './youtube-coverage-live.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {boundedParallelArtists,assertParallelWorld,sourceSnapshot} from './youtube-review-parallel.mjs';
import {reviewBatchRows} from './youtube-review-batch.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {boundYoutubeCapture} from './youtube-ownership-policy.mjs';

const source='generated-artifacts/youtube-test-100-review-repr-20261117-2245-cont1/results.json';
const selections=plan=>plan.recovery.recovery.map(a=>({profileId:a.profileId,cmArtist:a.cmArtist,artist:a.artist,tier:a.tier}));
async function eligibility(plan){
  const scope=selections(plan);assertCurrentIdentityEligibility(scope,await select(identityEligibilitySql(scope)));
}
async function freezeCheck(root,plan,approval){
  const files={[source]:plan.sourceFileSha256,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json')),
    [root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))};
  if(plan.sourceRun)files['generated-artifacts/'+plan.sourceRun.id+'/results.json']=plan.sourceRun.initialStateFileSha256;
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const check=frozenFileVerifier(files);await check();validateCoverageApproval(plan,approval);return check;
}
async function prepare(root,id,priorId){
  const bytes=await fs.readFile(source),records=JSON.parse(bytes),recovery=coverageRecoveryPlan(records);
  const p={version:COVERAGE_EXECUTION,id,parentId:'full-tiers-1-5-no-youtube-uncapped',
    sourceFileSha256:digest(bytes),records,recovery,maximumSpendCents:1000,limits:COVERAGE_LIMITS,
    scopeSha256:digest(recovery.recovery.map(a=>[a.profileId,a.cmArtist])),
    reviewOnly:true,catalogWrites:0,parallelism:8,maximumRounds:8,
    preparedAt:new Date().toISOString(),pricing:await modelQuote(),runtimeFiles:{}};
  if(priorId){
    assert.match(priorId,/^youtube-test-100-coverage-75-[a-z0-9-]+$/);
    const priorRoot='generated-artifacts/'+priorId;
    const oldPlan=JSON.parse(await fs.readFile(priorRoot+'/plan.json'));
    const oldApproval=JSON.parse(await fs.readFile(priorRoot+'/approval.json'));
    validateCoverageApproval(oldPlan,oldApproval);
    assert.equal(oldPlan.sourceRun,undefined,'One-source continuation only');
    assert.equal(oldPlan.scopeSha256,p.scopeSha256);
    const resultBytes=await fs.readFile(priorRoot+'/results.json'),initialState=JSON.parse(resultBytes);
    const pool=await connectSavedBatchPool();
    try{
      const snapshot=await sourceSnapshot(pool,priorId);
      assert.equal(snapshot.run.status,'stopped');
      assert.ok(snapshot.admissions.every(a=>a.status==='returned'),'Uncertain admissions prohibit continuation');
      assert.equal(snapshot.run.reserved_cents,snapshot.admissions.length*2);
      // Reconcile every dispatched receipt, not only receipts needed by the next request.
      const uploaderCounts={};
      for(const op of snapshot.admissions){
        const prefix=priorRoot+'/receipts/'+digest(op.operation_key);
        const receipt=JSON.parse(await fs.readFile(prefix+'.json'));
        assert.equal(digest(receipt),op.receipt_sha256);
        assert.equal(digest(receipt.request),op.input_sha256);
        assert.equal(receipt.operationKey,op.operation_key);
        assert.equal(receipt.profileId,op.profile_id);
        assert.equal(receipt.status,op.http_status);
        assert.equal(digest(await fs.readFile(prefix+'.raw')),receipt.rawBodySha256);
        if(op.kind==='metadata'&&new URL(receipt.request.url).pathname==='/v1/youtube/video')
          uploaderCounts[op.profile_id]=(uploaderCounts[op.profile_id]??0)+1;
      }
      p.sourceRun={id:priorId,snapshot,reservedCents:snapshot.run.reserved_cents,
        initialState,initialStateSha256:digest(initialState),initialStateFileSha256:digest(resultBytes),
        originalApprovalSha256:digest(oldApproval),uploaderCounts};
    }finally{await pool.end();}
  }
  await eligibility(p);
  await fs.mkdir(root);
  for(const f of await freezeLocalModules(fileURLToPath(import.meta.url),root+'/runtime')){
    const name='runtime/'+path.basename(f);p.runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));
  }
  const approval={explicitApproval:true,additionalCapCents:1000,planSha256:digest(p),
    approvalScope:'75 previously unsuggested artists; additional $10 recovery; review only',
    approvedAt:new Date().toISOString()};
  validateCoverageApproval(p,approval);
  await durableIdentityFile(root+'/plan.json',JSON.stringify(p));
  await durableIdentityFile(root+'/approval.json',JSON.stringify(approval));
  console.log(JSON.stringify({phase:'prepared',artists:75,maximumAdditionalCents:1000,paidCalls:0}));
}
async function run(root,plan,approval){
  const check=await freezeCheck(root,plan,approval);
  await eligibility(plan);checkModelQuote(await modelQuote(),plan.pricing);
  const pool=await connectSavedBatchPool(),owner=randomUUID(),
    records=structuredClone(plan.sourceRun?.initialState??plan.records),
    queues=new Map(),exhausted=new Set(),reused=new Set();
  const byId=new Map(records.map(r=>[r.artist.profileId,r]));
  for(const r of plan.recovery.recovery){
    const q=recoveryQueues(byId.get(r.profileId),r);
    q.videoAttempts=plan.sourceRun?.uploaderCounts[r.profileId]??0;
    queues.set(r.profileId,q);
  }
  for(const d of ['inputs','receipts','artists'])await fs.mkdir(root+'/'+d);
  await durableIdentityFile(root+'/run-started.json',JSON.stringify({at:new Date().toISOString(),planSha256:digest(plan)}));
  let started=false,status='stopped',reason=null,gate,tail=Promise.resolve(),round=-1;
  const save=()=>{
    const job=tail.then(async()=>{
      const rows=reviewBatchRows(records);
      const budget=(await pool.query('SELECT reserved_cents FROM youtube_discovery_test_runs WHERE id=$1',[plan.id])).rows[0];
      const summary={id:plan.id,status,totalArtists:100,recoveryArtists:75,
        baselineSuggestedArtists:25,
        suggestedArtists:records.filter(r=>r.candidates.some(c=>c.status==='review_suggestion')).length,
        suggestedChannelRows:rows.filter(r=>r.status==='review_suggestion').length,
        additionalReservedCents:Number(budget.reserved_cents)+(plan.sourceRun?.reservedCents??0),
        priorRecoveryReservedCents:plan.sourceRun?.reservedCents??0,
        thisStageReservedCents:Number(budget.reserved_cents),additionalCapCents:1000,
        reusedRequests:reused.size,round:round+1,stopReason:reason,
        accuracyMeasured:false,catalogWrites:0,updatedAt:new Date().toISOString()};
      summary.coveragePercent=summary.suggestedArtists;
      summary.netNewSuggestedArtists=summary.suggestedArtists-25;
      await fs.writeFile(root+'/progress.json.tmp',JSON.stringify(summary,null,2));
      await fs.rename(root+'/progress.json.tmp',root+'/progress.json');
      return summary;
    });tail=job.catch(()=>{});return job;
  };
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [plan.parentId])).rows[0]?.status,'stopped');
      await assertParallelWorld(c,'');
      await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
        VALUES($1,$2,$3,1000,'running')`,[plan.id,owner,plan.scopeSha256]);
      for(const a of plan.recovery.recovery)await c.query(`INSERT INTO youtube_discovery_test_results
        (run_id,profile_id,cm_artist,artist,tier,status,metadata_json,candidates_json)
        VALUES($1,$2,$3,$4,$5,'coverage_prepared',$6::jsonb,'[]'::jsonb)`,
      [plan.id,a.profileId,a.cmArtist,a.artist,a.tier,JSON.stringify({planSha256:digest(plan),
        approvalSha256:digest(approval),recoveryOnly:true,actualCohortSize:75,catalogWrites:0})]);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    gate=coverageGate({pool,plan,approval,owner});
    const request=coverageRequest({pool,root,plan,gate,check,onReuse:op=>reused.add(op.run_id+':'+op.operation_key)});
    const conflicts=async(artist,candidate)=>{
      const id=candidate.capture.body.channelId,aliases=[...new Set([
        candidate.url,'https://www.youtube.com/channel/'+id,
        ...(boundYoutubeCapture(candidate.url,candidate.capture)?.aliases??[])])];
      candidate.providerAliases=aliases;
      const old=(await pool.query(`SELECT profile_id FROM youtube_video_identity_claims
        WHERE (channel_id=$1 OR alias=ANY($2::text[])) AND profile_id<>$3
        UNION SELECT profile_id FROM youtube_link_campaign_channels WHERE channel_id=$1 AND profile_id<>$3`,
      [id,aliases,artist.profileId])).rows;
      const linked=await catalogLinkedYoutubeClaims(aliases.map(alias=>({alias,channelId:id})),select);
      return old.length>0||linked.some(r=>r.profile_id!==artist.profileId)||
        records.some(r=>r.artist.profileId!==artist.profileId&&r.candidates.some(c=>c.capture?.body?.channelId===id));
    };
    status='running';await save();
    for(round=0;round<plan.maximumRounds;round++){
      await check();await eligibility(plan);
      const active=plan.recovery.recovery.filter(r=>!exhausted.has(r.profileId)&&
        !byId.get(r.profileId).candidates.some(c=>c.status==='review_suggestion'));
      if(!active.length)break;
      await boundedParallelArtists(active.map(a=>({...a,profile_id:a.profileId})),plan.parallelism,async a=>{
        const record=byId.get(a.profileId);
        try{await recoverCoverageArtist({record,recovery:a,request,conflicts,round,queues:queues.get(a.profileId)});}
        catch(e){
          if(e.code==='COVERAGE_RESOURCE_MISSING'){
            record.recoveryEvents.push({kind:'resource_not_found',target:e.target,
              sourceReceipt:e.sourceReceipt??null,reason:e.message});
          }else if(e.code==='PRIOR_COVERAGE_REQUEST'){
            exhausted.add(a.profileId);
            record.recoveryEvents.push({kind:'historical_request_held',reason:e.message});
          }else{
          if(!(e instanceof CoverageLimit))throw e;
          if(e.message==='Additional $10 cap reached')throw e;
          exhausted.add(a.profileId);
          record.recoveryEvents.push({kind:'per_artist_limit',reason:e.message});
          }
        }
        // New observations are separately persisted, never overwrite the source run.
        await fs.writeFile(root+'/artists/'+a.profileId+'.json',JSON.stringify(record));
        const q=queues.get(a.profileId);
        if(!q.channels.length&&(!q.videos.length||q.videoAttempts>=2)&&!q.searches.length)exhausted.add(a.profileId);
        const progress=await save();
        console.log(JSON.stringify({phase:'coverage_progress',round:round+1,
          suggestedArtists:progress.suggestedArtists,reservedCents:progress.additionalReservedCents}));
      },()=>gate.close());
    }
    status='completed';
  }catch(e){
    gate?.close();
    reason=String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,180);
    status=e instanceof CoverageLimit?'budget_exhausted':'stopped';
    console.error(JSON.stringify({phase:'recovery_stopped',reason}));
  }finally{
    try{
      await tail;
      if(started){
        const rows=reviewBatchRows(records);
        for(const r of plan.recovery.recovery){
          const record=byId.get(r.profileId);
          await pool.query(`UPDATE youtube_discovery_test_results SET status='coverage_processed',
            candidates_json=$3::jsonb,checked_at=now() WHERE run_id=$1 AND profile_id=$2`,
          [plan.id,r.profileId,JSON.stringify(record.candidates)]);
        }
        await durableIdentityFile(root+'/results.json',JSON.stringify(records,null,2));
        const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_name','channel_type_label',
          'status','assessment','reason','ownership_accepted','import_eligible'];
        const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
        for(const [file,list] of [['youtube-review.csv',rows],['youtube-suggestions.csv',rows.filter(r=>r.status==='review_suggestion')]])
          await durableIdentityFile(root+'/'+file,'\ufeff'+[columns,...list.map(r=>columns.map(k=>r[k]))]
            .map(row=>row.map(cell).join(',')).join('\r\n'));
        const pending=Number((await pool.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
          WHERE run_id=$1 AND status='admitted'`,[plan.id])).rows[0].n);
        if(pending){status='stopped';reason='Unacknowledged paid request; no automatic retry';}
        await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3 WHERE id=$1 AND owner=$2 AND status='running'`,
          [plan.id,owner,status==='completed'?'completed':'stopped']);
        const summary=await save();summary.unreturnedRequests=pending;
        await durableIdentityFile(root+'/summary.json',JSON.stringify(summary,null,2));
        console.log(JSON.stringify(summary));
      }
    }finally{await pool.end();}
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const [mode,id,priorId]=process.argv.slice(2);
  assert.ok(process.argv.length===4||(process.argv.length===5&&mode==='--prepare-continuation-approved'));
  assert.match(id??'',/^youtube-test-100-coverage-75-[a-z0-9-]+$/);
  const root='generated-artifacts/'+id;
  if(mode==='--prepare-approved')return prepare(root,id);
  if(mode==='--prepare-continuation-approved')return prepare(root,id,priorId);
  assert.equal(mode,'--run-approved');
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use the sealed runtime');
  const plan=deepFreeze(JSON.parse(await fs.readFile(root+'/plan.json')));
  const approval=deepFreeze(JSON.parse(await fs.readFile(root+'/approval.json')));
  await run(root,plan,approval);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(e){
    console.error(JSON.stringify({phase:'preflight_stopped',name:e.name,code:e.code??null,
      reason:String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,180)}));
    process.exitCode=1;
  }
}
