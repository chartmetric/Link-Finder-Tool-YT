import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveReviewBatch,reviewBatchArtist,reviewBatchRows} from './youtube-review-batch.mjs';
import {parallelPlan,sourceSnapshot,validatedSourcePackets,reuseSourcePackets,parallelGate,assertParallelWorld,
  boundedParallelArtists,SOURCE_ID,SOURCE_ROOT,TARGET_ID,TARGET_ROOT} from './youtube-review-parallel.mjs';
import {reviewBatchFrozen,reviewBatchRequest} from './run-youtube-review-batch.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';
import {pacedAdmissions} from './campaign-parallel-core.mjs';
const cell=x=>'"'+String(x??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
export async function runParallelReview({plan,approval,check}){
  assert.deepEqual(parallelPlan(plan),plan);assert.deepEqual(approveReviewBatch(plan,approval),approval);
  const records=structuredClone(plan.completedRecords);
  const completed=new Set(records.map(r=>r.artist.profileId));
  for(const id of plan.failedProfileIds){
    const a=plan.artists.find(a=>a.profile_id===id);
    records.push({artist:{profileId:id,cmArtist:a.cm_artist,name:a.artist},tier:a.tier,candidates:[],
      status:'failed',failureReason:'Acknowledged provider server failure; not retried',
      ownershipAccepted:false,importEligible:false});
  }
  const remaining=plan.artists.filter(a=>!completed.has(a.profile_id)&&!plan.failedProfileIds.includes(a.profile_id));
  const selections=remaining.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
  assertCurrentIdentityEligibility(selections,
    await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
  checkModelQuote(await modelQuote(),plan.pricing);
  const savedPackets=await validatedSourcePackets(plan);await check();
  await durableIdentityFile(TARGET_ROOT+'/run-started.json',JSON.stringify({at:new Date().toISOString(),
    planSha256:digest(plan),sourceId:SOURCE_ID,sharedAllowanceCents:1000,parallelism:16}));
  for(const d of ['receipts','inputs','artists'])await fs.mkdir(TARGET_ROOT+'/'+d);
  const pool=await connectSavedBatchPool(),owner=randomUUID();
  let started=false,gate,summaryStatus='stopped',stopReason=null,writeTail=Promise.resolve();
  const persist=(file,data)=>{const job=writeTail.then(()=>fs.writeFile(file,data));writeTail=job.catch(()=>{});return job;};
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [plan.parentId])).rows[0]?.status,'stopped');
      await c.query('SELECT id FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[SOURCE_ID]);
      assert.deepEqual(await sourceSnapshot(c),plan.sourceSnapshot);
      await boundedExperimentReadiness(c,plan);await assertParallelWorld(c,'');
      await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
        VALUES($1,$2,$3,1000,'running')`,[TARGET_ID,owner,plan.scopeSha256]);
      for(const a of plan.artists)await c.query(`INSERT INTO youtube_discovery_test_results
        (run_id,profile_id,cm_artist,artist,tier,status,metadata_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [TARGET_ID,a.profile_id,a.cm_artist,a.artist,a.tier,completed.has(a.profile_id)?'source_processed':
        plan.failedProfileIds.includes(a.profile_id)?'source_failed':'review_prepared',
      JSON.stringify({sourceId:SOURCE_ID,sourcePlanSha256:plan.sourcePlanSha256,reviewOnly:true,
        ownershipAccepted:false,importEligible:false,totalSharedAllowanceCents:1000})]);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    gate=parallelGate({pool,plan,approval,owner});
    const knownReturnedFailures=new Map();
    const transportGate={admit:op=>gate.admit(op),async returned(op,sha,status){
      await gate.returned(op,sha,status);
      if(status>=500&&status<600)knownReturnedFailures.set(op.key,{status,profileId:op.profileId});
    }};
    const transport=await reviewBatchRequest({root:TARGET_ROOT,plan,gate:transportGate,assertFrozen:check});
    const pace=pacedAdmissions({intervalMs:plan.providerIntervalMs});
    const cached=reuseSourcePackets(savedPackets,async(profileId,kind,key,request)=>{
      await pace(kind);
      try{return await transport(profileId,kind,key,request);}
      catch(e){
        if(knownReturnedFailures.get(key)?.profileId===profileId){
          const prefix=TARGET_ROOT+'/receipts/'+digest(key),meta=JSON.parse(await fs.readFile(prefix+'.json'));
          const packet={...meta,data:JSON.parse(await fs.readFile(prefix+'.raw'))};
          if(!providerStopReason(packet)){
            e.acknowledgedServerFailure=true;e.operationKey=key;e.profileId=profileId;
          }
        }
        throw e;
      }
    });
    const claims=new Map();
    for(const r of records)for(const c of r.candidates){
      const id=c.capture?.body.channelId;if(!id)continue;
      const ids=claims.get(id)??new Set();ids.add(r.artist.profileId);claims.set(id,ids);
    }
    const conflicts=async(artist,candidate)=>{
      const id=candidate.capture.body.channelId,ids=claims.get(id)??new Set();
      ids.add(artist.profileId);claims.set(id,ids);
      if(ids.size>1)return true;
      const aliases=[...new Set(['https://www.youtube.com/channel/'+id,...(candidate.providerAliases??[])])];
      const old=await pool.query(`SELECT profile_id FROM youtube_video_identity_claims
        WHERE (channel_id=$1 OR alias=ANY($2::text[])) AND profile_id<>$3
        UNION SELECT profile_id FROM youtube_link_campaign_channels WHERE channel_id=$1 AND profile_id<>$3`,
      [id,aliases,artist.profileId]);
      const current=await catalogLinkedYoutubeClaims(aliases.map(alias=>({alias,channelId:id})),select);
      return old.rows.length>0||current.some(a=>a.profile_id!==artist.profileId)||claims.get(id).size>1;
    };
    console.log(JSON.stringify({phase:'parallel_started',workers:16,remainingArtists:remaining.length,
      keptCompletedArtists:completed.size,keptFailedArtists:plan.failedProfileIds.length,
      priorReservedCents:plan.sourceReservedCents,sharedAllowanceCents:1000}));
    await boundedParallelArtists(remaining,16,async a=>{
      const artist=youtubeArtistFromCatalogPacket(plan.packets.find(p=>p.profileId===a.profile_id));
      let record;
      try{record=await reviewBatchArtist({artist,tier:a.tier,request:cached.request,conflicts});}
      catch(e){
        if(!e.acknowledgedServerFailure)throw e;
        record={artist,tier:a.tier,candidates:[],status:'failed',failureReason:'Acknowledged server failure; not retried',
          failedOperation:e.operationKey,ownershipAccepted:false,importEligible:false};
      }
      records.push(record);
      await durableIdentityFile(TARGET_ROOT+'/artists/'+a.profile_id+'.json',JSON.stringify(record));
      assert.equal((await pool.query(`UPDATE youtube_discovery_test_results d SET status=$4,
        candidates_json=$5::jsonb,checked_at=now() FROM youtube_discovery_test_runs r
        WHERE d.run_id=$1 AND d.profile_id=$2 AND d.status='review_prepared'
        AND r.id=d.run_id AND r.owner=$3 AND r.status='running'`,
      [TARGET_ID,a.profile_id,owner,record.status==='failed'?'review_failed':'review_processed',
        JSON.stringify(record.candidates)])).rowCount,1);
      const rows=reviewBatchRows(records);
      console.log(JSON.stringify({phase:'artist_finished',accountedFor:records.length,total:100,workers:16,
        reviewSuggestions:rows.filter(r=>r.status==='review_suggestion').length}));
      await persist(TARGET_ROOT+'/progress.json',JSON.stringify({status:'running',accountedFor:records.length,
        total:100,workers:16,updatedAt:new Date().toISOString()}));
    },()=>gate.close());
    summaryStatus='completed';
  }catch(e){
    gate?.close();stopReason=String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,180);
    throw e;
  }finally{
    try{
      await writeTail;
      if(started){
        records.sort((a,b)=>plan.artists.findIndex(r=>r.profile_id===a.artist.profileId)-
          plan.artists.findIndex(r=>r.profile_id===b.artist.profileId));
        const rows=reviewBatchRows(records);
        await durableIdentityFile(TARGET_ROOT+'/results.json',JSON.stringify(records,null,2));
        for(const r of records)assert.equal((await pool.query(`UPDATE youtube_discovery_test_results d
          SET candidates_json=$4::jsonb FROM youtube_discovery_test_runs run WHERE d.run_id=$1 AND d.profile_id=$2
          AND run.id=d.run_id AND run.owner=$3 AND run.status='running'`,
        [TARGET_ID,r.artist.profileId,owner,JSON.stringify(r.candidates)])).rowCount,1);
        const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_name','channel_type_label',
          'status','assessment','reason','ownership_accepted','import_eligible'];
        await durableIdentityFile(TARGET_ROOT+'/youtube-review.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))]
          .map(r=>r.map(cell).join(',')).join('\r\n'));
        assert.deepEqual(await sourceSnapshot(pool),plan.sourceSnapshot,'Source spending history changed');
        const own=(await pool.query(`SELECT reserved_cents FROM youtube_discovery_test_runs WHERE id=$1`,[TARGET_ID])).rows[0];
        const pending=Number((await pool.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
          WHERE run_id=$1 AND status='admitted'`,[TARGET_ID])).rows[0].n);
        if(pending)summaryStatus='stopped';
        assert.equal((await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3
          WHERE id=$1 AND owner=$2 AND status='running'`,[TARGET_ID,owner,summaryStatus])).rowCount,1);
        const summary={id:TARGET_ID,status:summaryStatus,stopReason,parallelWorkers:16,
          artistsAccountedFor:records.length,totalArtists:100,artistsProcessed:records.filter(r=>r.status!=='failed').length,
          failedArtistsNotRetried:records.filter(r=>r.status==='failed').length,
          channelRows:rows.filter(r=>r.youtube_url).length,
          reviewSuggestions:rows.filter(r=>r.status==='review_suggestion').length,
          uncertain:rows.filter(r=>['uncertain','held'].includes(r.status)).length,
          notMatched:rows.filter(r=>r.status==='not_a_match').length,
          noSelectedChannel:rows.filter(r=>r.status==='no_selected_channel').length,
          priorReservedCents:plan.sourceReservedCents,newReservedCents:own.reserved_cents,
          totalReservedCents:plan.sourceReservedCents+own.reserved_cents,totalSharedAllowanceCents:1000,
          unreturnedRequests:pending,ownershipAccepted:0,catalogWrites:0,paidRetries:0,
          fullCampaignResumed:false};
        await durableIdentityFile(TARGET_ROOT+'/summary.json',JSON.stringify(summary,null,2));
        await fs.writeFile(TARGET_ROOT+'/progress.json',JSON.stringify({...summary,updatedAt:new Date().toISOString()}));
        console.log(JSON.stringify(summary));
      }
    }finally{await pool.end();}
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:plan-sha256|approve-cents)=[a-z0-9]+$/.test(a)));
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.equal(args.filter(a=>['--authorize-prepared','--run-approved'].includes(a)).length,1);
  const plan=deepFreeze(parallelPlan(JSON.parse(await fs.readFile(TARGET_ROOT+'/plan.json'))));
  let check=await reviewBatchFrozen(TARGET_ROOT,plan);
  if(args.includes('--authorize-prepared')){
    const approval=approveReviewBatch(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableIdentityFile(TARGET_ROOT+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const bytes=await fs.readFile(TARGET_ROOT+'/approval.json'),approval=deepFreeze(JSON.parse(bytes));
  check=await reviewBatchFrozen(TARGET_ROOT,plan,{[TARGET_ROOT+'/approval.json']:digest(bytes)});
  await runParallelReview({plan,approval,check});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
