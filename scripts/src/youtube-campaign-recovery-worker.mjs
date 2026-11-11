// Separate executor: the launched legacy runtime is never edited or restarted.
import assert from 'node:assert/strict';
import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {eligibilitySql} from './run-youtube-campaign.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {assertAdmission,campaignTransport,evaluateCandidate,classifyYoutubeResult} from './youtube-campaign-core.mjs';
import {readJson,optionalJson,immutableJson,recoveryTransport,startRecovery,recoveryStore,
  verifyRecoveryEvidence} from './youtube-campaign-recovery-core.mjs';

export function artistFromMetadata(p){
  return {profileId:p.profileId,cmArtist:p.cmArtist,name:p.artist,catalogProfile:p.catalogProfile,
    country:p.chartmetric?.code2??null,label:p.chartmetric?.label??p.chartmetric?.record_label??null,
    accounts:p.linkedAccounts.filter(a=>a.account_url?.trim()),releases:[...p.releases,...p.catalogTracks],
    context:{chartmetric:p.chartmetric,tags:p.tags,spotify:p.spotifyMetadata,platformSnapshots:p.platformSnapshots,
      profileMetadata:p.profileMetadata,
      warning:'Catalog context is not independent ownership proof. Platform snapshots are not account-bound captures.'}};
}
async function metadataFor(root,target){
  const file=root+'/metadata/'+target.profile_id+'.json';
  let p=await optionalJson(file);
  if(!p){
    const manifest={artists:[{...target,accounts:[],account_ids:[]}]};
    const accounts=await select(metadataQueries(manifest).accounts.replaceAll("platform!='instagram'","platform!='youtube'"));
    manifest.artists[0].accounts=accounts.filter(a=>a.profile_id===target.profile_id&&a.account_url?.trim());
    manifest.artists[0].account_ids=manifest.artists[0].accounts.map(a=>a.account_id);
    const queries=metadataQueries(manifest),data={accounts:manifest.artists[0].accounts};
    for(const key of Object.keys(queries).filter(k=>k!=='accounts'))
      data[key]=await select(queries[key].replaceAll("platform!='instagram'","platform!='youtube'"));
    p=buildMetadataOverlay(manifest,data,new Date().toISOString()).packets[0];
    await immutableJson(file,p);
  }
  assert.equal(p.profileId,target.profile_id);assert.equal(p.cmArtist,target.cm_artist);
  return artistFromMetadata(p);
}
export async function executeRecovery({pool,root,directory,plan,assertFrozen,credentials,
  selectImpl=select,fetchImpl=fetch}){
  const id=plan.campaignId,owner=plan.owner,scopeHash=plan.scopeSha256,approvalHash=plan.originalApprovalSha256;
  let claimed=false,active=null;
  const tx=async fn=>{
    const c=await pool.connect();
    try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}
    catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  };
  const assertOwner=async c=>{
    const p=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(p.owner,owner);assert.equal(p.status,'running');
    assert.equal(p.scope_sha256,scopeHash);assert.equal(p.approval_sha256,approvalHash);
    const r=(await c.query('SELECT * FROM youtube_link_campaign_recoveries WHERE campaign_id=$1 AND owner=$2',[id,owner])).rows[0];
    assert.equal(r?.status,'running');assert.equal(r.plan_sha256,evidenceDigest(plan));
    return p;
  };
  try{
    await assertFrozen();
    await startRecovery(recoveryStore(pool,id),plan,state=>verifyRecoveryEvidence(root,plan,state));claimed=true;
    const admissions=(await pool.query('SELECT * FROM youtube_link_campaign_admissions WHERE campaign_id=$1',[id])).rows;
    const dispatch=campaignTransport({root,assertFrozen,credentials,fetchImpl,
      admit:op=>tx(async c=>{
        const p=await assertOwner(c);
        const a=(await c.query('SELECT * FROM youtube_link_campaign_artists WHERE campaign_id=$1 AND profile_id=$2 FOR UPDATE',[id,op.profileId])).rows[0];
        const pending=(await c.query("SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE campaign_id=$1 AND status='admitted'",[id])).rows[0].n;
        assertAdmission(p,a,pending,{owner,scopeHash,approvalHash,profileId:op.profileId});
        await c.query(`INSERT INTO youtube_link_campaign_admissions
          (campaign_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,$4,$5,2)`,
        [id,op.key,op.profileId,op.kind,op.inputSha256]);
        await c.query('UPDATE youtube_link_campaigns SET reserved_cents=reserved_cents+2,updated_at=now() WHERE id=$1',[id]);
      }),
      returned:(op,sha,status)=>tx(async c=>{
        await assertOwner(c);
        const r=await c.query(`UPDATE youtube_link_campaign_admissions SET status='returned',receipt_sha256=$4,http_status=$5
          WHERE campaign_id=$1 AND operation_key=$2 AND input_sha256=$3 AND status='admitted'`,
        [id,op.key,op.inputSha256,sha,status]);assert.equal(r.rowCount,1);
        await c.query('UPDATE youtube_link_campaigns SET updated_at=now() WHERE id=$1',[id]);
      })});
    const request=recoveryTransport({admissions,assertFrozen,dispatch,
      readReceipt:key=>readJson(root+'/receipts/'+evidenceDigest(key)+'.json')});
    // Historical paid test identities remain deferred even if the first worker
    // died just after claiming the campaign and before applying this fence.
    await tx(async c=>{
      await assertOwner(c);
      await c.query(`UPDATE youtube_link_campaign_artists SET status='deferred',
        reason='historical_paid_youtube_attempt_preserved',updated_at=now()
        WHERE campaign_id=$1 AND status='queued'
        AND profile_id IN (SELECT profile_id FROM youtube_discovery_test_results)`,[id]);
    });
    while(true){
      const targets=(await pool.query(`SELECT * FROM youtube_link_campaign_artists
        WHERE campaign_id=$1 AND status IN ('queued','in_progress','failed') ORDER BY ordinal LIMIT 20`,[id])).rows;
      if(!targets.length)break;
      const eligible=new Map((await selectImpl(eligibilitySql(targets.map(a=>a.profile_id)))).map(a=>[a.profile_id,a]));
      for(const target of targets){
        await assertFrozen();
        if(eligible.get(target.profile_id)?.cm_artist!==target.cm_artist){
          await tx(async c=>{
            await assertOwner(c);
            await c.query(`UPDATE youtube_link_campaign_artists SET status='deferred',
              reason='current_catalog_eligibility_or_identity_changed',updated_at=now()
              WHERE campaign_id=$1 AND profile_id=$2`,[id,target.profile_id]);
          });continue;
        }
        // Reuse the original full context before reconstructing *any* paid
        // request. A fresh catalog overlay could change a model request hash.
        const artist=await metadataFor(root,target);
        await tx(async c=>{
          await assertOwner(c);
          const r=await c.query(`UPDATE youtube_link_campaign_artists SET status='in_progress',updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status IN ('queued','in_progress','failed')`,[id,target.profile_id]);
          assert.equal(r.rowCount,1);
        });
        active=target.profile_id;
        const packet=await request(active,'search','search-'+active,{method:'POST',url:'https://google.serper.dev/search',
          body:{q:`${artist.name} artist official YouTube channel`,num:10}});
        const found=youtubeSearchCandidates(packet.data);
        const record={artist,searchStatus:found.length?'candidates_found':'no_match',candidates:[]};
        for(const candidate of found){
          const checked=await evaluateCandidate({artist,candidate,request,
            channelConflict:async(channelId,profileId)=>tx(async c=>{
              await assertOwner(c);
              await c.query(`INSERT INTO youtube_link_campaign_channels(campaign_id,channel_id,profile_id)
                VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,channelId,profileId]);
              const others=(await c.query(`SELECT profile_id FROM youtube_link_campaign_channels
                WHERE campaign_id=$1 AND channel_id=$2 AND profile_id!=$3`,[id,channelId,profileId])).rows;
              for(const other of others)await c.query(`UPDATE youtube_link_campaign_artists
                SET likely=false,reason='channel_reused_across_catalog_artists',updated_at=now()
                WHERE campaign_id=$1 AND profile_id=$2`,[id,other.profile_id]);
              return others.length>0;
            })});
          record.candidates.push(checked);
          // The read-only publisher uses the original campaign evidence paths
          // across generations. Verify any interrupted save; never replace it.
          await immutableJson(root+'/inputs/'+active+'-'+evidenceDigest(candidate.url)+'.json',checked);
        }
        // An interrupted save may have left an uncommitted result. Never
        // overwrite it; require exact reconstructed evidence before committing.
        await immutableJson(root+'/artists/'+active+'.json',record);
        const stats=classifyYoutubeResult(record);
        await tx(async c=>{
          await assertOwner(c);
          const r=await c.query(`UPDATE youtube_link_campaign_artists SET status='completed',searched=$3,
            checked=$4,likely=$5,candidates=$6,result_sha256=$7,reason=NULL,updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,
          [id,active,stats.searched,stats.checked,stats.likely,stats.candidates,evidenceDigest(record)]);
          assert.equal(r.rowCount,1);
          // Global holds survive generations, even for previously saved positives.
          await c.query(`UPDATE youtube_link_campaign_artists a SET likely=false,
            reason='channel_reused_across_catalog_artists',updated_at=now()
            WHERE a.campaign_id=$1 AND EXISTS(
              SELECT 1 FROM youtube_link_campaign_channels x JOIN youtube_link_campaign_channels y
              ON x.campaign_id=y.campaign_id AND x.channel_id=y.channel_id AND x.profile_id!=y.profile_id
              WHERE x.campaign_id=a.campaign_id AND x.profile_id=a.profile_id)`,[id]);
          await c.query('UPDATE youtube_link_campaigns SET updated_at=now() WHERE id=$1',[id]);
        });
        active=null;
      }
    }
    await tx(async c=>{
      await assertOwner(c);
      await c.query("UPDATE youtube_link_campaigns SET status='completed',updated_at=now() WHERE id=$1",[id]);
      await c.query("UPDATE youtube_link_campaign_recoveries SET status='completed' WHERE campaign_id=$1 AND owner=$2",[id,owner]);
    });
  }catch(e){
    if(claimed){
      await tx(async c=>{
        // Do not let an obsolete process stop a later recovery owner.
        const p=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
        if(p.owner!==owner)return;
        await c.query(`UPDATE youtube_link_campaigns SET status='stopped',
          stop_reason='recovery_stopped_no_retry',updated_at=now() WHERE id=$1`,[id]);
        await c.query("UPDATE youtube_link_campaign_recoveries SET status='stopped' WHERE campaign_id=$1 AND owner=$2",[id,owner]);
        if(active)await c.query(`UPDATE youtube_link_campaign_artists SET status='failed',
          reason='recovery_stopped_no_retry',updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,[id,active]);
      });
      await immutableJson(directory+'/stopped.json',{at:new Date().toISOString(),activeProfile:active,
        reason:'recovery_stopped_no_retry',reservationsRetained:true});
    }
    // Do not expose provider bodies, SQL connection details or credentials.
    throw Error('Recovery stopped without retry. Preserve all receipts and admissions for operator review.');
  }
}
