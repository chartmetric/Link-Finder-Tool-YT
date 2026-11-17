import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {freshReviewPlan,approveFreshReview,freshReviewGate} from './youtube-fresh-review.mjs';
import {reviewBatchStart,reviewBatchGlobalReadiness} from './youtube-review-batch-live.mjs';
import {reviewBatchRequest} from './run-youtube-review-batch.mjs';
import {reviewBatchArtist,reviewBatchRows} from './youtube-review-batch.mjs';
import {REPRESENTATION_ASSESSMENTS} from './youtube-artist-representation.mjs';
import {boundedParallelArtists,sourceSnapshot,validatedSourcePackets,reuseSourcePackets,parallelGate,
  assertParallelWorld} from './youtube-review-parallel.mjs';
import {boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {pacedAdmissions,safeDiagnostic} from './campaign-parallel-core.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';

const clean=e=>String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,180);
const cell=v=>'"'+String(v??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
export async function runFreshReview({root,plan,approval,check}){
  assert.deepEqual(approveFreshReview(plan,approval),approval);
  for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])assert.ok(process.env[key]);
  checkModelQuote(await modelQuote(),plan.pricing);
  const selections=plan.artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
  await check();
  assertCurrentIdentityEligibility(selections,await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections)));
  await durableIdentityFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  for(const dir of ['inputs','receipts','artists'])await fs.mkdir(root+'/'+dir);
  const pool=await connectSavedBatchPool(),owner=randomUUID(),
    records=structuredClone(plan.completedRecords??[]),claims=new Map();
  const done=new Set(records.map(r=>r.artist.profileId));
  const remaining=plan.artists.filter(a=>!done.has(a.profile_id));
  let reusedRequests=new Set();
  let started=false,status='stopped',stopReason=null,gate,writeTail=Promise.resolve();
  const progress=value=>{
    const next=writeTail.then(async()=>{
      await fs.writeFile(root+'/progress.json.tmp',JSON.stringify(value));
      await fs.rename(root+'/progress.json.tmp',root+'/progress.json');
    });writeTail=next.catch(()=>{});return next;
  };
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');await reviewBatchGlobalReadiness(c,plan);
      if(plan.continuation){
        const parent=(await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
          [plan.parentId])).rows[0];assert.equal(parent?.status,'stopped');
        await boundedExperimentReadiness(c,plan);await assertParallelWorld(c,'');
        assert.deepEqual(await sourceSnapshot(c,plan.sourceId),plan.sourceSnapshot);
        await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
          VALUES($1,$2,$3,1000,'running')`,[plan.id,owner,plan.scopeSha256]);
        for(const a of plan.artists){
          const old=records.find(r=>r.artist.profileId===a.profile_id);
          await c.query(`INSERT INTO youtube_discovery_test_results
            (run_id,profile_id,cm_artist,artist,tier,status,metadata_json,candidates_json)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
          [plan.id,a.profile_id,a.cm_artist,a.artist,a.tier,old?'review_processed':'review_prepared',
            JSON.stringify({planSha256:approval.planSha256,reviewOnly:true,sourceId:plan.sourceId,
              ownershipAccepted:false,importEligible:false}),JSON.stringify(old?.candidates??[])]);
        }
      }else await reviewBatchStart(c,plan,approval,owner);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    gate=plan.continuation?parallelGate({pool,plan,approval,owner}):freshReviewGate({pool,plan,approval,owner});
    const failures=new Map();
    const transport=await reviewBatchRequest({root,plan,assertFrozen:check,
      modelAssessments:REPRESENTATION_ASSESSMENTS,
      gate:{admit:op=>gate.admit(op),async returned(op,sha,httpStatus){
        await gate.returned(op,sha,httpStatus);
        if(httpStatus>=500&&httpStatus<600)failures.set(op.key,op.profileId);
      }}});
    const pace=pacedAdmissions({intervalMs:plan.providerIntervalMs});
    const dispatch=async(profileId,kind,key,body)=>{
      await pace(kind);
      try{return await transport(profileId,kind,key,body);}
      catch(e){
        if(failures.get(key)===profileId){
          const prefix=root+'/receipts/'+digest(key),receipt=JSON.parse(await fs.readFile(prefix+'.json'));
          if(!providerStopReason({...receipt,data:JSON.parse(await fs.readFile(prefix+'.raw'))})){
            e.acknowledgedServerFailure=true;e.operationKey=key;
          }
        }
        throw e;
      }
    };
    let request=dispatch;
    if(plan.continuation){
      const packets=await validatedSourcePackets(plan,{sourceId:plan.sourceId,sourceRoot:plan.continuationSourceRoot});
      const cached=reuseSourcePackets(packets,dispatch);request=cached.request;reusedRequests=cached.reused;
    }
    for(const r of records)for(const c of r.candidates){
      const id=c.capture?.body.channelId;if(!id)continue;
      const ids=claims.get(id)??new Set();ids.add(r.artist.profileId);claims.set(id,ids);
    }
    const conflicts=async(artist,candidate)=>{
      const id=candidate.capture.body.channelId,ids=claims.get(id)??new Set();
      ids.add(artist.profileId);claims.set(id,ids);if(ids.size>1)return true;
      const aliases=[...new Set(['https://www.youtube.com/channel/'+id,...(candidate.providerAliases??[])])];
      const old=await pool.query(`SELECT profile_id FROM youtube_video_identity_claims
        WHERE (channel_id=$1 OR alias=ANY($2::text[])) AND profile_id<>$3 UNION
        SELECT profile_id FROM youtube_link_campaign_channels WHERE channel_id=$1 AND profile_id<>$3`,
      [id,aliases,artist.profileId]);
      const linked=await catalogLinkedYoutubeClaims(aliases.map(alias=>({alias,channelId:id})),select);
      return old.rows.length>0||linked.some(r=>r.profile_id!==artist.profileId)||claims.get(id).size>1;
    };
    console.log(JSON.stringify({phase:'paid_batch_started',id:plan.id,artists:100,remaining:remaining.length,
      retained:records.length,workers:16,capCents:1000,priorReservedCents:plan.sourceReservedCents,
      verificationPolicy:plan.verificationPolicy}));
    await progress({status:'running',accountedFor:records.length,total:100,workers:16,capCents:1000,updatedAt:new Date().toISOString()});
    await boundedParallelArtists(remaining,plan.parallelism,async a=>{
      const artist=youtubeArtistFromCatalogPacket(plan.packets.find(p=>p.profileId===a.profile_id));
      let record;
      try{record=await reviewBatchArtist({artist,tier:a.tier,request,conflicts,
        verificationPolicy:plan.verificationPolicy,maximumModelRequestBytes:plan.maximumModelRequestBytes});}
      catch(e){
        if(!e.acknowledgedServerFailure)throw e;
        record={artist,tier:a.tier,candidates:[],status:'failed',failedOperation:e.operationKey,
          failureReason:'Acknowledged server failure; not retried',ownershipAccepted:false,importEligible:false};
      }
      records.push(record);
      await durableIdentityFile(root+'/artists/'+a.profile_id+'.json',JSON.stringify(record));
      assert.equal((await pool.query(`UPDATE youtube_discovery_test_results d SET status=$4,
        candidates_json=$5::jsonb,checked_at=now() FROM youtube_discovery_test_runs r
        WHERE d.run_id=$1 AND d.profile_id=$2 AND d.status='review_prepared'
        AND r.id=d.run_id AND r.owner=$3 AND r.status='running'`,
      [plan.id,a.profile_id,owner,record.status==='failed'?'review_failed':'review_processed',
        JSON.stringify(record.candidates)])).rowCount,1);
      console.log(JSON.stringify({phase:'artist_finished',accountedFor:records.length,total:100}));
      await progress({status:'running',accountedFor:records.length,total:100,workers:16,updatedAt:new Date().toISOString()});
    },()=>gate.close());
    status='completed';
  }catch(e){
    gate?.close();stopReason=clean(e);throw e;
  }finally{
    try{
      await writeTail;
      if(started){
        records.sort((a,b)=>plan.artists.findIndex(x=>x.profile_id===a.artist.profileId)-
          plan.artists.findIndex(x=>x.profile_id===b.artist.profileId));
        const rows=reviewBatchRows(records);
        await durableIdentityFile(root+'/results.json',JSON.stringify(records,null,2));
        for(const r of records)assert.equal((await pool.query(`UPDATE youtube_discovery_test_results d
          SET candidates_json=$4::jsonb FROM youtube_discovery_test_runs run
          WHERE d.run_id=$1 AND d.profile_id=$2 AND run.id=d.run_id AND run.owner=$3 AND run.status='running'`,
        [plan.id,r.artist.profileId,owner,JSON.stringify(r.candidates)])).rowCount,1);
        const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_name','channel_type_label',
          'status','assessment','reason','ownership_accepted','import_eligible'];
        await durableIdentityFile(root+'/youtube-review.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))]
          .map(r=>r.map(cell).join(',')).join('\r\n'));
        const pending=Number((await pool.query(`SELECT count(*)::int n FROM youtube_bounded_test_admissions
          WHERE run_id=$1 AND status='admitted'`,[plan.id])).rows[0].n);
        if(pending)status='stopped';
        const budget=(await pool.query('SELECT reserved_cents,cap_cents FROM youtube_discovery_test_runs WHERE id=$1',
          [plan.id])).rows[0];
        assert.equal((await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3
          WHERE id=$1 AND owner=$2 AND status='running'`,[plan.id,owner,status])).rowCount,1);
        if(plan.continuation)assert.deepEqual(await sourceSnapshot(pool,plan.sourceId),plan.sourceSnapshot);
        assert.ok(plan.sourceReservedCents+budget.reserved_cents<=1000);
        const summary={id:plan.id,status,stopReason,totalArtists:100,artistsAccountedFor:records.length,
          artistsProcessed:records.filter(r=>r.status!=='failed').length,
          failedArtistsNotRetried:records.filter(r=>r.status==='failed').length,workers:16,
          suggestedArtists:records.filter(r=>r.candidates.some(c=>c.status==='review_suggestion')).length,
          channelRows:rows.filter(r=>r.youtube_url).length,
          suggestedChannelRows:rows.filter(r=>r.status==='review_suggestion').length,
          reservedCents:plan.sourceReservedCents+budget.reserved_cents,
          priorReservedCents:plan.sourceReservedCents,newReservedCents:budget.reserved_cents,
          reusedRequests:reusedRequests.size,totalAllowanceCents:budget.cap_cents,unreturnedRequests:pending,
          verificationPolicy:plan.verificationPolicy,ownershipAccepted:0,catalogWrites:0,
          fullCampaignResumed:false,policyActivated:false,paidRetries:0,updatedAt:new Date().toISOString()};
        await durableIdentityFile(root+'/summary.json',JSON.stringify(summary,null,2));
        await progress(summary);console.log(JSON.stringify(summary));
      }
    }finally{await pool.end();}
  }
}

async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.equal(args.filter(a=>['--authorize-prepared','--run-approved'].includes(a)).length,1);
  const id=value('id');assert.match(id??'',/^youtube-test-100-review-repr-[a-z0-9-]{4,55}$/);
  const root='generated-artifacts/'+id;
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use the sealed runtime');
  const plan=deepFreeze(freshReviewPlan(JSON.parse(await fs.readFile(root+'/plan.json'))));
  const files={...plan.sourceFiles,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json'))};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  let check=frozenFileVerifier(files);await check();
  if(args.includes('--authorize-prepared')){
    const approval=approveFreshReview(plan,{planSha256:value('plan-sha256'),capCents:Number(value('approve-cents')),
      approvedAt:new Date().toISOString()});
    assert.deepEqual(approveFreshReview(plan,JSON.parse(JSON.stringify(approval))),approval);
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(args.length,2);
  const bytes=await fs.readFile(root+'/approval.json'),approval=deepFreeze(JSON.parse(bytes));
  check=frozenFileVerifier({...files,[root+'/approval.json']:digest(bytes)});await check();
  await runFreshReview({root,plan,approval,check});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await main();}catch(e){
    console.error(JSON.stringify({phase:'fresh_batch_stopped',reason:clean(e),diagnostic:safeDiagnostic(e,'fresh_review')}));
    process.exitCode=1;
  }
}
