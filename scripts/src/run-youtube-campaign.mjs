import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {select,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {youtubeMetadataQueries,bindYoutubeCatalogAccounts} from './youtube-catalog-metadata.mjs';
import {youtubeArtistSearchQuery,rankYoutubeMusicCandidates} from './youtube-music-search.mjs';
import {createYoutubeChannelCache} from './youtube-channel-dedup.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {youtubeEligibilitySql,youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {YOUTUBE_CAMPAIGN_ID as id,YOUTUBE_CAMPAIGN_ROOT as root,MODEL_PLAN,youtubeCampaignSchema,
  validateQueue,assertAdmission,campaignTransport,evaluateCandidate,classifyYoutubeResult} from './youtube-campaign-core.mjs';

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value),{flag:'wx'});
const ownFiles=['scripts/src/run-youtube-campaign.mjs','scripts/src/youtube-campaign-core.mjs',
  'scripts/src/youtube-ownership-policy.mjs','scripts/src/youtube-ownership-transport.mjs',
  'scripts/src/youtube-discovery-test.mjs','scripts/src/instagram-artist-metadata-overlay.mjs',
  'scripts/src/youtube-ownership-evidence.mjs','scripts/src/youtube-catalog-metadata.mjs',
  'scripts/src/youtube-music-search.mjs','scripts/src/youtube-channel-dedup.mjs'];
export function eligibilitySql(ids){
  if(ids){
    assert.ok(ids.length&&ids.every(id=>/^\d+$/.test(id)));
  }
  // Same catalog definition as the approved discovery test, but no 4-per-tier
  // sample. Global tiers only; existing Instagram links do not exclude anyone.
  return youtubeEligibilitySql.replace(' LIMIT 4 BY t.tier','')
    .replace('ORDER BY t.tier,t.tier_rank,p.id',`${ids?'AND p.id IN ('+ids.join(',')+') ':''}ORDER BY t.tier,t.tier_rank,p.id`);
}
async function fingerprints(){
  // Read beside this module, not from mutable workspace source. A sealed
  // runtime can continue safely while unrelated task merges update the app.
  const directory=path.dirname(fileURLToPath(import.meta.url));
  return Object.fromEntries(await Promise.all(ownFiles.map(async f=>[f,
    evidenceDigest(await fs.readFile(path.join(directory,path.basename(f)),'utf8'))])));
}
export async function prepareYoutubeCampaign(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1','Prepare the coordinator only in the workspace.');
  const queue=validateQueue((await select(eligibilitySql())).map(a=>({...a,tier:Number(a.tier)})));
  assert.ok(queue.every(a=>Date.now()-Date.parse(a.snapshot_at.replace(' ','T')+'Z')<36*3600000),'Stale global tier snapshot.');
  const approval={version:1,id,at:new Date().toISOString(),platform:'youtube',tiers:[1,2,3,4,5],
    explicitApproval:true,approvedBy:'User selected Approve uncapped YouTube run.',
    maximumSpendCents:null,totalArtists:queue.length,scopeSha256:evidenceDigest(queue),
    scope:'Tier 1–5 musicians missing a connected catalog YouTube URL, regardless of saved candidates or Instagram links.',
    conservativeReservationPerRequestCents:2,model:MODEL_PLAN.model,
    noCatalogWrites:true,noAutomaticRetries:true,preserveHistoricalPaidAttempts:true,
    automaticContinuation:true,codeFingerprints:await fingerprints()};
  await fs.mkdir(root,{recursive:false});
  for(const name of ['receipts','artists','metadata','inputs'])await fs.mkdir(root+'/'+name);
  await save('queue.json',queue);await save('approval.json',approval);
  const pool=await connectSavedBatchPool();
  try{
    // Explicit operator preparation, not application startup or a production migration.
    await pool.query(youtubeCampaignSchema);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      await c.query(`INSERT INTO youtube_link_campaigns
        (id,owner,scope_sha256,approval_sha256,maximum_spend_cents,total_artists,status)
        VALUES($1,$2,$3,$4,NULL,$5,'prepared')`,[id,randomUUID(),approval.scopeSha256,evidenceDigest(approval),queue.length]);
      for(let at=0;at<queue.length;at+=1000){
        const rows=queue.slice(at,at+1000).map((a,i)=>({...a,ordinal:at+i}));
        await c.query(`INSERT INTO youtube_link_campaign_artists(campaign_id,profile_id,cm_artist,artist,tier,ordinal)
          SELECT $1,x.profile_id,x.cm_artist,x.artist,x.tier,x.ordinal FROM jsonb_to_recordset($2::jsonb)
          AS x(profile_id text,cm_artist text,artist text,tier int,ordinal int)`,[id,JSON.stringify(rows)]);
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }finally{await pool.end();}
  console.log(JSON.stringify({status:'prepared',artists:queue.length,maximumSpendUsd:null,
    tiers:Object.fromEntries([1,2,3,4,5].map(t=>[t,queue.filter(a=>a.tier===t).length])),paidCalls:0}));
}
async function catalogContext(targets){
  let manifest={artists:targets.map(a=>({...a,accounts:[],account_ids:[]}))};
  const accounts=await select(youtubeMetadataQueries(manifest).accounts);
  manifest=bindYoutubeCatalogAccounts(manifest,accounts);
  const queries=youtubeMetadataQueries(manifest),data={accounts:manifest.artists.flatMap(a=>a.accounts)};
  for(const key of Object.keys(queries).filter(k=>k!=='accounts'))
    data[key]=await select(queries[key]);
  const overlay=buildMetadataOverlay(manifest,data,new Date().toISOString());
  const out=new Map();
  for(const p of overlay.packets){
    // Same baseline shape; supplemental ownership evidence remains offline-only.
    const artist=youtubeArtistFromCatalogPacket(p);
    await save('metadata/'+p.profileId+'.json',p);out.set(p.profileId,artist);
  }
  return out;
}
const safeReasons=new Set(['provider_funding_failure','provider_authentication_or_access_failure',
  'provider_rate_limit','unexpected_provider_redirect','unreadable_provider_response','provider_protocol_failure',
  'provider_server_error_no_retry','provider_timeout_uncertain_no_retry']);
export async function runYoutubeCampaign(){
  assert.ok(process.argv.includes('--uncapped-approved'),'Explicit uncapped launch flag required.');
  for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])
    assert.ok(process.env[key],'A required provider credential is unavailable.');
  const approval=await read(root+'/approval.json'),queue=validateQueue(await read(root+'/queue.json'));
  assert.equal(approval.id,id);assert.equal(approval.explicitApproval,true);
  assert.equal(approval.maximumSpendCents,null);assert.equal(approval.scopeSha256,evidenceDigest(queue));
  assert.equal(approval.totalArtists,queue.length);
  const assertFrozen=async()=>{
    assert.deepEqual(await fingerprints(),approval.codeFingerprints,'Frozen YouTube code changed; no further paid calls.');
    assert.equal(evidenceDigest(await read(root+'/approval.json')),evidenceDigest(approval),'Approval changed.');
  };
  await assertFrozen();
  const pool=await connectSavedBatchPool(),owner=randomUUID(),approvalHash=evidenceDigest(approval);
  const scopeHash=approval.scopeSha256;
  let activeProfile=null,claimed=false;
  const transaction=async fn=>{
    const c=await pool.connect();
    try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  };
  const assertOwner=async c=>{
    const p=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(p.owner,owner);assert.equal(p.status,'running');
    assert.equal(p.scope_sha256,scopeHash);assert.equal(p.approval_sha256,approvalHash);
    return p;
  };
  const snapshot=async()=>{
    const {rows}=await pool.query(`SELECT c.status,c.reserved_cents,c.maximum_spend_cents,c.updated_at,c.stop_reason,
      count(*)::int total,
      count(*) FILTER(WHERE a.status='completed')::int processed,
      count(*) FILTER(WHERE a.searched)::int searched,
      count(*) FILTER(WHERE a.checked)::int checked,
      count(*) FILTER(WHERE a.likely)::int likely,
      count(*) FILTER(WHERE a.status='deferred')::int deferred,
      count(*) FILTER(WHERE a.status='failed')::int failed
      FROM youtube_link_campaigns c JOIN youtube_link_campaign_artists a ON a.campaign_id=c.id
      WHERE c.id=$1 GROUP BY c.id`,[id]);
    const p=rows[0];
    const value={id,scopeSha256:scopeHash,status:p.status,totalArtists:p.total,processedArtists:p.processed,
      searchedArtists:p.searched,checkedArtists:p.checked,likelyMatches:p.likely,
      deferredArtists:p.deferred,failedArtists:p.failed,processedPercent:p.processed/p.total*100,
      successRate:p.checked?p.likely/p.checked*100:null,reservedUsd:Number(p.reserved_cents)/100,
      maximumSpendUsd:null,updatedAt:p.updated_at,capturedAt:new Date().toISOString(),stopReason:p.stop_reason};
    await fs.writeFile(root+'/progress.json.tmp',JSON.stringify(value));
    await fs.rename(root+'/progress.json.tmp',root+'/progress.json');
    console.log(JSON.stringify(value));return value;
  };
  try{
    await transaction(async c=>{
      const p=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
      assert.equal(p.status,'prepared','This run was already launched. Do not replay or reset it.');
      assert.equal(p.approval_sha256,approvalHash);assert.equal(p.scope_sha256,scopeHash);
      assert.equal(p.total_artists,queue.length);assert.equal(p.maximum_spend_cents,null);
      await c.query("UPDATE youtube_link_campaigns SET owner=$2,status='running',updated_at=now() WHERE id=$1",[id,owner]);
    });claimed=true;
    // Historical 20-artist test admissions remain non-replayable. They are
    // retained as deferred references, not charged again or falsely rejected.
    const prior=(await pool.query('SELECT DISTINCT profile_id FROM youtube_discovery_test_results')).rows;
    const priorIds=prior.map(x=>x.profile_id);
    await pool.query(`UPDATE youtube_link_campaign_artists SET status='deferred',reason='historical_paid_youtube_attempt_preserved',
      updated_at=now() WHERE campaign_id=$1 AND profile_id=ANY($2::text[]) AND status='queued'`,[id,priorIds]);
    const request=campaignTransport({root,assertFrozen,
      credentials:{serper:process.env.SERPERDEV_API_KEY,scrapecreators:process.env.SCRAPECREATORS_API_KEY,
        openrouter:process.env.OPENROUTER_API_KEY},
      admit:op=>transaction(async c=>{
        const p=await assertOwner(c);
        const a=(await c.query('SELECT * FROM youtube_link_campaign_artists WHERE campaign_id=$1 AND profile_id=$2 FOR UPDATE',[id,op.profileId])).rows[0];
        const pending=(await c.query("SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE campaign_id=$1 AND status='admitted'",[id])).rows[0].n;
        assertAdmission(p,a,pending,{owner,scopeHash,approvalHash,profileId:op.profileId});
        await c.query(`INSERT INTO youtube_link_campaign_admissions
          (campaign_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
          [id,op.key,op.profileId,op.kind,op.inputSha256]);
        await c.query('UPDATE youtube_link_campaigns SET reserved_cents=reserved_cents+2,updated_at=now() WHERE id=$1',[id]);
      }),
      returned:(op,sha,status)=>transaction(async c=>{
        await assertOwner(c);
        const r=await c.query(`UPDATE youtube_link_campaign_admissions SET status='returned',receipt_sha256=$4,http_status=$5
          WHERE campaign_id=$1 AND operation_key=$2 AND input_sha256=$3 AND status='admitted'`,
          [id,op.key,op.inputSha256,sha,status]);assert.equal(r.rowCount,1);
        await c.query('UPDATE youtube_link_campaigns SET updated_at=now() WHERE id=$1',[id]);
      })});
    await snapshot();
    while(true){
      const targets=(await pool.query("SELECT * FROM youtube_link_campaign_artists WHERE campaign_id=$1 AND status='queued' ORDER BY ordinal LIMIT 20",[id])).rows;
      if(!targets.length)break;
      const eligible=await select(eligibilitySql(targets.map(a=>a.profile_id)));
      const eligibleMap=new Map(eligible.map(a=>[a.profile_id,a]));
      const current=[];
      for(const a of targets){
        const now=eligibleMap.get(a.profile_id);
        if(!now||now.cm_artist!==a.cm_artist){
          await pool.query(`UPDATE youtube_link_campaign_artists SET status='deferred',reason='current_catalog_eligibility_or_identity_changed',
            updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'`,[id,a.profile_id]);
        }else current.push(a);
      }
      if(!current.length){await snapshot();continue;}
      const metadata=await catalogContext(current);
      for(const target of current){
        await transaction(async c=>{
          await assertOwner(c);
          const r=await c.query(`UPDATE youtube_link_campaign_artists SET status='in_progress',updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'`,[id,target.profile_id]);assert.equal(r.rowCount,1);
        });
        activeProfile=target.profile_id;
        const artist=metadata.get(activeProfile);assert.ok(artist);assert.equal(artist.cmArtist,target.cm_artist);
        const search={method:'POST',url:'https://google.serper.dev/search',body:{q:youtubeArtistSearchQuery(artist),num:10}};
        const packet=await request(activeProfile,'search','search-'+activeProfile,search);
        assert.equal(packet.status,200,'Search failed; this is not a no-match.');
        const ranked=rankYoutubeMusicCandidates(artist,youtubeSearchCandidates(packet.data));
        const record={artist,searchStatus:ranked.allCandidates.length?'candidates_found':'no_match',
          allSearchCandidates:ranked.allCandidates,relatedTopicCandidates:ranked.relatedTopicCandidates,candidates:[]};
        const channelCache=createYoutubeChannelCache(artist);
        for(const candidate of ranked.candidates){
          const checked=await evaluateCandidate({artist,candidate,request,channelCache,
            channelConflict:async(channelId,profileId)=>transaction(async c=>{
              await assertOwner(c);
              await c.query(`INSERT INTO youtube_link_campaign_channels(campaign_id,channel_id,profile_id)
                VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,channelId,profileId]);
              const others=(await c.query(`SELECT profile_id FROM youtube_link_campaign_channels
                WHERE campaign_id=$1 AND channel_id=$2 AND profile_id!=$3`,[id,channelId,profileId])).rows;
              // A later shared-channel discovery holds both identities, not
              // just the latest artist. Original evidence files stay intact.
              for(const other of others)await c.query(`UPDATE youtube_link_campaign_artists
                SET likely=false,reason='channel_reused_across_catalog_artists',updated_at=now()
                WHERE campaign_id=$1 AND profile_id=$2`,[id,other.profile_id]);
              return others.length>0;
            })});
          if(!checked.aliasOf)record.candidates.push(checked);
          await save('inputs/'+activeProfile+'-'+evidenceDigest(candidate.url)+'.json',checked);
        }
        const resultHash=evidenceDigest(record);
        await save('artists/'+activeProfile+'.json',record);
        const stats=classifyYoutubeResult(record);
        await transaction(async c=>{
          await assertOwner(c);
          const r=await c.query(`UPDATE youtube_link_campaign_artists SET status='completed',searched=$3,
            checked=$4,likely=$5,candidates=$6,result_sha256=$7,updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,
            [id,activeProfile,stats.searched,stats.checked,stats.likely,stats.candidates,resultHash]);assert.equal(r.rowCount,1);
          await c.query('UPDATE youtube_link_campaigns SET updated_at=now() WHERE id=$1',[id]);
        });
        activeProfile=null;await snapshot();
      }
    }
    await pool.query("UPDATE youtube_link_campaigns SET status='completed',updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[id,owner]);
    await snapshot();
  }catch(e){
    if(claimed){
      // Never print raw provider errors or credentials. Unknown failures stay
      // stopped with a diagnostic class, retaining every admission/receipt.
      const reason=safeReasons.has(e.message)?e.message:'local_validation_or_unexpected_failure_no_retry';
      await pool.query("UPDATE youtube_link_campaigns SET status='stopped',stop_reason=$3,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[id,owner,reason]);
      if(activeProfile)await pool.query("UPDATE youtube_link_campaign_artists SET status='failed',reason=$3,updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'",[id,activeProfile,reason]);
      await save('stopped.json',{at:new Date().toISOString(),reason,errorClass:e.name,
        activeProfile,reservationsRetained:true,noRetries:true});
      await snapshot();
    }
    throw Error('YouTube campaign stopped safely; inspect preserved local evidence. No paid requests were retried.');
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--prepare-approved'))await prepareYoutubeCampaign();
  else if(process.argv.includes('--run-approved'))await runYoutubeCampaign();
  else throw Error('Choose explicit preparation or approved execution; no default paid work.');
}
