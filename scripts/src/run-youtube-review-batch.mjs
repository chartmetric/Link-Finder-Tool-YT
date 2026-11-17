import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewBatchPlan,approveReviewBatch,reviewBatchArtist,reviewBatchRows} from './youtube-review-batch.mjs';
import {reviewBatchStart,reviewBatchGate} from './youtube-review-batch-live.mjs';
import {readSavedJson,modelQuote,checkModelQuote} from './run-youtube-saved-model-checks.mjs';
import {deepFreeze} from './run-youtube-channel-fast-continuation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';
import {durableIdentityFile} from './youtube-video-identity-execution.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {COMBINED_ASSESSMENTS} from './youtube-combined-ownership.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';

export async function reviewBatchFrozen(root,plan,extras={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed executor');
  deepFreeze(plan);assert.deepEqual(reviewBatchPlan(plan),plan);
  assert.deepEqual(await readSavedJson(root+'/plan.json'),plan);
  const files={...plan.sourceFiles,[root+'/plan.json']:digest(await fs.readFile(root+'/plan.json')),...extras};
  for(const [f,sha] of Object.entries(plan.runtimeFiles))files[root+'/'+f]=sha;
  const check=frozenFileVerifier(files);await check();return check;
}
export async function reviewBatchRequest({root,plan,gate,assertFrozen,fetchImpl=fetch,
  modelAssessments=COMBINED_ASSESSMENTS,credentials={
  serper:process.env.SERPERDEV_API_KEY,scrapecreators:process.env.SCRAPECREATORS_API_KEY,
  openrouter:process.env.OPENROUTER_API_KEY}}){
  const byId=new Map(plan.artists.map(a=>[a.profile_id,a]));
  return async(profileId,kind,key,request)=>{
    const artist=byId.get(profileId);assert.ok(artist);
    assert.ok(['search','metadata','model'].includes(kind));
    assert.ok(key.startsWith(kind+'-'+profileId+'-'));
    const u=new URL(request.url);
    assert.equal(u.username,'');assert.equal(u.password,'');
    if(kind==='search'){
      assert.equal(request.method,'POST');assert.equal(request.url,'https://google.serper.dev/search');
      const packet=plan.packets.find(p=>p.profileId===profileId);
      const {youtubeSearchPlan}=await import('./youtube-search-plan.mjs');
      assert.deepEqual(request.body,youtubeSearchPlan(youtubeArtistFromCatalogPacket(packet)).request);
    }else if(kind==='metadata'){
      assert.equal(request.method,'GET');assert.equal(u.origin,'https://api.scrapecreators.com');
      assert.ok(['/v1/youtube/channel','/v1/youtube/video'].includes(u.pathname));
      assert.equal([...u.searchParams.keys()].join(','),'url');
    }else{
      assert.equal(request.method,'POST');assert.equal(request.url,'https://openrouter.ai/api/alpha/decisions');
      assert.equal(request.body.model,'typesafe/jev-1.13');
      assert.equal(request.body.state.artist.profileId,profileId);
      assert.equal(request.body.state.artist.cmArtist,artist.cm_artist);
      assert.ok(Buffer.byteLength(JSON.stringify(request.body))<=plan.maximumModelRequestBytes);
      assert.deepEqual(Object.keys(request.body.questions),['combined_assessment']);
    }
    await assertFrozen();
    const op={profileId,kind,key,inputSha256:digest(request)};
    const credential=kind==='search'?credentials.serper:
      kind==='metadata'?credentials.scrapecreators:credentials.openrouter;
    assert.ok(credential);
    await durableIdentityFile(root+'/inputs/'+digest(key)+'.json',JSON.stringify({op,request}));
    await gate.admit(op);
    const headers=kind==='search'?{'X-API-KEY':credential,'Content-Type':'application/json'}:
      kind==='metadata'?{'x-api-key':credential}:{Authorization:'Bearer '+credential,'Content-Type':'application/json'};
    const response=await fetchImpl(request.url,{method:request.method,headers,redirect:'error',
      signal:AbortSignal.timeout(120000),...(request.body?{body:JSON.stringify(request.body)}:{})});
    const chunks=[];let length=0;
    if(response.body)for await(const chunk of response.body){
      length+=chunk.length;assert.ok(length<=2*1024*1024);chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks),prefix=root+'/receipts/'+digest(key);
    await durableIdentityFile(prefix+'.raw',raw);
    const receipt={runId:plan.id,profileId,cmArtist:artist.cm_artist,kind,operationKey:key,
      inputSha256:op.inputSha256,request,status:response.status,at:new Date().toISOString(),
      rawBodySha256:digest(raw),rawPath:'receipts/'+digest(key)+'.raw'};
    await durableIdentityFile(prefix+'.json',JSON.stringify(receipt));
    const data=JSON.parse(raw);
    const packet={...receipt,data,sourcePath:prefix+'.json',rawBodyBase64:raw.toString('base64')};
    const stop=providerStopReason(packet);
    // Saved non-success responses remain charged history, never retries.
    await gate.returned(op,digest(receipt),response.status);
    if(stop)throw Error(stop);
    assert.equal(response.status,200,'Provider request failed; no automatic retry');
    if(kind==='metadata'){
      assert.equal(data.success,true);
      assert.ok(Number.isFinite(data.credits_charged)&&data.credits_charged>=0&&data.credits_charged<=1);
    }
    if(kind==='model'){
      assert.ok(['typesafe/jev-1.13','typesafe/jev-1.13-20260917'].includes(data.model));
      assert.ok(Number.isFinite(data.usage?.cost)&&data.usage.cost>=0&&data.usage.cost<=.02);
      assert.deepEqual(Object.keys(data.answers??{}),['combined_assessment']);
      assert.ok(Object.hasOwn(modelAssessments,data.answers.combined_assessment?.choice));
    }
    return packet;
  };
}
const cell=x=>'"'+String(x??'').replace(/^[=+\-@\t\r\n]/u,"'$&").replaceAll('"','""')+'"';
export async function runReviewBatch({root,plan,approval,assertFrozen}){
  assert.deepEqual(approveReviewBatch(plan,approval),approval);
  for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])assert.ok(process.env[key]);
  checkModelQuote(await modelQuote(),plan.pricing);
  const selections=plan.artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
  const checkCatalog=async list=>assertCurrentIdentityEligibility(list,
    await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(list)));
  await checkCatalog(selections);await assertFrozen();
  await durableIdentityFile(root+'/run-started.json',JSON.stringify({planSha256:digest(plan),at:new Date().toISOString()}));
  for(const dir of ['receipts','inputs','artists'])await fs.mkdir(root+'/'+dir);
  const pool=await connectSavedBatchPool(),owner=randomUUID(),records=[];
  let started=false,status='stopped',stopReason=null;
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');await reviewBatchStart(c,plan,approval,owner);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    const gate=reviewBatchGate({pool,plan,approval,owner});
    const request=await reviewBatchRequest({root,plan,gate,assertFrozen});
    const conflicts=async(artist,candidate)=>{
      const id=candidate.capture.body.channelId,aliases=candidate.providerAliases??[];
      const claims=[...new Set(['https://www.youtube.com/channel/'+id,...aliases])]
        .map(alias=>({alias,channelId:id,profileId:artist.profileId,cmArtist:artist.cmArtist}));
      const historical=await pool.query(`SELECT profile_id FROM youtube_video_identity_claims
        WHERE (channel_id=$1 OR alias=ANY($2::text[])) AND profile_id<>$3
        UNION SELECT profile_id FROM youtube_link_campaign_channels WHERE channel_id=$1 AND profile_id<>$3`,
      [id,claims.map(c=>c.alias),artist.profileId]);
      const current=await catalogLinkedYoutubeClaims(claims,select);
      return historical.rows.length>0||current.some(r=>r.profile_id!==artist.profileId)||
        records.some(r=>r.artist.profileId!==artist.profileId&&r.candidates.some(c=>c.capture?.body.channelId===id));
    };
    for(let index=0;index<plan.artists.length;index++){
      if(index%20===0){
        await checkCatalog(selections.slice(index,index+20));
        checkModelQuote(await modelQuote(),plan.pricing);
      }
      const a=plan.artists[index],artist=youtubeArtistFromCatalogPacket(
        plan.packets.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist));
      const record=await reviewBatchArtist({artist,tier:a.tier,request,conflicts,
        maximumModelRequestBytes:plan.maximumModelRequestBytes});
      records.push(record);
      await durableIdentityFile(root+'/artists/'+a.profile_id+'.json',JSON.stringify(record));
      const result=await pool.query(`UPDATE youtube_discovery_test_results d
        SET status='review_processed',candidates_json=$4::jsonb,metadata_json=$5::jsonb,checked_at=now()
        FROM youtube_discovery_test_runs r WHERE d.run_id=$1 AND d.profile_id=$2 AND r.id=d.run_id
        AND r.owner=$3 AND r.status='running' AND d.status='review_prepared'`,
      [plan.id,a.profile_id,owner,JSON.stringify(record.candidates),JSON.stringify({reviewOnly:true,
        ownershipAccepted:false,importEligible:false,searchStatus:record.discovery.searchStatus})]);
      assert.equal(result.rowCount,1);
      const rows=reviewBatchRows(records);
      console.log(JSON.stringify({phase:'artist_finished',completed:records.length,total:100,
        reviewSuggestions:rows.filter(r=>r.status==='review_suggestion').length}));
      await fs.writeFile(root+'/progress.json',JSON.stringify({status:'running',completed:records.length,
        total:100,updatedAt:new Date().toISOString()}));
    }
    status='completed';
  }catch(e){
    stopReason='Stopped without retry: '+String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,140);
    throw e;
  }finally{
    try{
      if(started){
        const rows=reviewBatchRows(records);
        await durableIdentityFile(root+'/results.json',JSON.stringify(records,null,2));
        // Final safety holds supersede intermediate per-artist views without
        // modifying archived model answers or original capture evidence.
        for(const r of records)await pool.query(`UPDATE youtube_discovery_test_results
          SET candidates_json=$3::jsonb WHERE run_id=$1 AND profile_id=$2`,
        [plan.id,r.artist.profileId,JSON.stringify(r.candidates)]);
        const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_name','channel_type_label',
          'status','assessment','reason','ownership_accepted','import_eligible'];
        await durableIdentityFile(root+'/youtube-review.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))]
          .map(r=>r.map(cell).join(',')).join('\r\n'));
        assert.equal((await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3
          WHERE id=$1 AND owner=$2 AND status='running'`,[plan.id,owner,status])).rowCount,1);
        const budget=(await pool.query(`SELECT reserved_cents,cap_cents FROM youtube_discovery_test_runs WHERE id=$1`,
          [plan.id])).rows[0];
        const counts=(await pool.query(`SELECT kind,status,count(*)::int calls FROM youtube_bounded_test_admissions
          WHERE run_id=$1 GROUP BY kind,status ORDER BY kind,status`,[plan.id])).rows;
        const summary={id:plan.id,status,stopReason,artistsProcessed:records.length,totalArtists:100,
          channelRows:rows.filter(r=>r.youtube_url).length,reviewSuggestions:rows.filter(r=>r.status==='review_suggestion').length,
          uncertain:rows.filter(r=>['uncertain','held'].includes(r.status)).length,
          notMatched:rows.filter(r=>r.status==='not_a_match').length,
          noSelectedChannel:rows.filter(r=>r.status==='no_selected_channel').length,
          reservedCents:budget.reserved_cents,totalAllowanceCents:budget.cap_cents,admissions:counts,
          providerReportedModelUsd:records.flatMap(r=>r.candidates).reduce((n,c)=>n+(c.assessment?.modelAnswer.providerReportedUsd??0),0),
          ownershipAccepted:0,catalogWrites:0,paidRetries:0,fullCampaignResumed:false};
        await durableIdentityFile(root+'/summary.json',JSON.stringify(summary,null,2));
        console.log(JSON.stringify(summary));
      }
    }finally{await pool.end();}
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)||
    /^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  assert.equal(args.filter(a=>['--authorize-prepared','--run-approved'].includes(a)).length,1);
  const id=value('id');assert.match(id??'',/^youtube-test-100-review-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await readSavedJson(root+'/plan.json');assert.equal(plan.id,id);
  let check=await reviewBatchFrozen(root,plan);
  if(args.includes('--authorize-prepared')){
    const approval=approveReviewBatch(plan,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableIdentityFile(root+'/approval.json',JSON.stringify(approval,null,2));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  const approval=deepFreeze(await readSavedJson(root+'/approval.json'));
  check=await reviewBatchFrozen(root,plan,{[root+'/approval.json']:digest(await fs.readFile(root+'/approval.json'))});
  await runReviewBatch({root,plan,approval,assertFrozen:check});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
