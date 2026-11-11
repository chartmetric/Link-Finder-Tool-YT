import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {youtubeEligibilitySql} from './youtube-discovery-test.mjs';
import {instagramProfileUrl} from './musician-instagram-matching.mjs';
import {instagramSearchCandidates} from './instagram-search-clues.mjs';
import {serperQuery} from './instagram-pilot-live-transport.mjs';
import {digest,enrichedRequest} from './instagram-next-saved-batch.mjs';
import {answersFrom} from './instagram-jev-label-ablation.mjs';
import {catalogBoundReviewSuggestion} from './instagram-likely-review-policy.mjs';
import {PRIORITY_ROOT as root} from './instagram-tier-handoff.mjs';
import {PRIORITY_ID as id,validatePriorityAdmission,priorityTransport,normalizeSavedInstagram} from './instagram-tier-priority-core.mjs';

const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value),{flag:'wx'});
export function instagramPriorityEligibility(ids){
  assert.ok(ids.length&&ids.every(id=>/^\d+$/.test(id)));
  return youtubeEligibilitySql.replaceAll("'youtube'","'instagram'").replace(' LIMIT 4 BY t.tier','')
    .replace('ORDER BY t.tier,t.tier_rank,p.id',`AND p.id IN (${ids.join(',')}) ORDER BY t.tier,t.tier_rank,p.id`);
}
async function contextFor(rows){
  const manifest={artists:rows.map(a=>({...a,accounts:[],account_ids:[]}))};
  const accounts=await select(metadataQueries(manifest).accounts);
  for(const a of manifest.artists){
    // Retain invalid/missing URLs in the raw packet, but do not use them to
    // construct trusted Spotify identifiers or an identity reference.
    a.accounts=accounts.filter(x=>x.profile_id===a.profile_id&&x.account_url?.trim()
      &&(x.platform!=='spotify'||/^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]{22}\/?(?:\?.*)?$/.test(x.account_url)));
    a.account_ids=a.accounts.map(x=>x.account_id);
  }
  const data={accounts},queries=metadataQueries(manifest);
  for(const key of Object.keys(queries).filter(k=>k!=='accounts'))data[key]=await select(queries[key]);
  const packets=buildMetadataOverlay(manifest,data,new Date().toISOString()).packets;
  const result=new Map();
  for(const p of packets){
    await save('metadata/'+p.profileId+'.json',p);
    const accounts=p.linkedAccounts.filter(a=>a.account_url?.trim());
    const player={profile_id:p.profileId,cm_artist:p.cmArtist,artist:p.artist,
      accounts,account_ids:accounts.map(a=>a.account_id),source_identity_matches:true,catalog_profile:p.catalogProfile};
    const context={ownershipConfirmed:false,items:p.chartmetric?.code2?[{kind:'country',
      source:'new_vertical.cm_artist',text:p.chartmetric.code2,binding:'catalog_artist_identity_only',
      asOf:p.catalogProfile.source_updated_at,stale:false}]:[]};
    result.set(p.profileId,{profileId:p.profileId,artist:p.artist,player,context,
      sourceCapturedAt:p.collectedAt,sourceArtistName:p.artist,candidates:[]});
  }
  return result;
}
export async function runPriorityInstagram(){
  assert.ok(process.argv.includes('--run-approved')&&process.argv.includes('--strict-tier-order-approved'));
  for(const k of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])assert.ok(process.env[k],'Missing provider credential.');
  const approval=await read(root+'/approval.json'),queue=await read(root+'/queue.json');
  assert.equal(approval.id,id);assert.equal(approval.maximumSpendCents,null);
  assert.equal(approval.order,'tier_1_then_2_then_3_then_4_then_5');
  assert.equal(digest(queue),approval.scopeSha256);
  const directory=path.dirname(fileURLToPath(import.meta.url));
  const assertFrozen=async()=>{
    assert.equal(digest(await read(root+'/approval.json')),digest(approval));
    for(const [file,sha] of Object.entries(approval.runtimeFiles)){
      assert.equal(path.basename(file),file);
      assert.equal(digest(await fs.readFile(path.join(directory,file),'utf8')),sha,'Sealed runtime changed.');
    }
  };
  await assertFrozen();
  const pool=await connectSavedBatchPool(),owner=randomUUID();
  let claimed=false,active=null;
  const tx=async work=>{
    const c=await pool.connect();
    try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");await c.query("SET LOCAL statement_timeout='15s'");
      const result=await work(c);await c.query('COMMIT');return result;
    }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
  };
  const assertParent=async c=>{
    const p=(await c.query('SELECT * FROM instagram_campaign_budgets WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(p.owner,approval.parentOwner);assert.equal(p.scope_sha256,approval.parentScopeSha256);assert.equal(p.cap_cents,null);
    const legacy=(await c.query(`SELECT coalesce(sum(b.reserved_cents),0)::int cents FROM instagram_campaign_children c
      JOIN instagram_saved_batch_budgets b ON b.id=c.budget_id WHERE c.campaign_id=$1`,[id])).rows[0].cents;
    assert.equal(legacy,approval.legacyReservedCents,'Legacy work changed; block new spending.');
  };
  const assertRun=async c=>{
    await assertParent(c);
    const p=(await c.query('SELECT * FROM instagram_priority_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    assert.equal(p.owner,owner);assert.equal(p.status,'running');
    assert.equal(p.scope_sha256,approval.scopeSha256);assert.equal(p.approval_sha256,digest(approval));return p;
  };
  async function progress(){
    const p=(await pool.query(`SELECT r.status,r.reserved_cents,r.updated_at,r.stop_reason,
      count(*) FILTER(WHERE a.status='completed')::int processed,
      count(*) FILTER(WHERE a.checked)::int checked,count(*) FILTER(WHERE a.likely)::int likely,
      count(*) FILTER(WHERE a.status='deferred')::int deferred,
      min(tier) FILTER(WHERE a.status IN ('queued','in_progress')) next_tier
      FROM instagram_priority_runs r JOIN instagram_priority_artists a ON a.campaign_id=r.id
      WHERE r.id=$1 GROUP BY r.id`,[id])).rows[0];
    const value={campaignId:id,status:p.status,totalArtists:queue.length,processedArtists:p.processed,
      checkedArtists:p.checked,likelyMatches:p.likely,deferredArtists:p.deferred,
      reservedCents:approval.legacyReservedCents+Number(p.reserved_cents),maximumSpendCents:null,
      nextTier:p.next_tier,strictTierOrder:true,updatedAt:p.updated_at,stopReason:p.stop_reason};
    await fs.writeFile(root+'/progress.json.tmp',JSON.stringify(value));await fs.rename(root+'/progress.json.tmp',root+'/progress.json');
    console.log(JSON.stringify(value));return value;
  }
  try{
    await tx(async c=>{
      await assertParent(c);
      const p=(await c.query('SELECT * FROM instagram_priority_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      assert.equal(p.status,'prepared','Already launched; automatic recovery/replay is forbidden.');
      assert.equal(p.scope_sha256,approval.scopeSha256);assert.equal(p.approval_sha256,digest(approval));
      assert.equal(Number(p.reserved_cents),0);
      await c.query("UPDATE instagram_priority_runs SET owner=$2,status='running',updated_at=now() WHERE id=$1",[id,owner]);
    });claimed=true;
    const request=priorityTransport({root,assertFrozen,
      credentials:{serper:process.env.SERPERDEV_API_KEY,scrapecreators:process.env.SCRAPECREATORS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY},
      admit:op=>tx(async c=>{
        const p=await assertRun(c);
        const a=(await c.query('SELECT * FROM instagram_priority_artists WHERE campaign_id=$1 AND profile_id=$2 FOR UPDATE',[id,op.profileId])).rows[0];
        const pending=(await c.query("SELECT count(*)::int n FROM instagram_priority_admissions WHERE campaign_id=$1 AND status='admitted'",[id])).rows[0].n;
        const lower=(await c.query("SELECT count(*)::int n FROM instagram_priority_artists WHERE campaign_id=$1 AND tier<$2 AND status IN ('queued','in_progress')",[id,a.tier])).rows[0].n;
        validatePriorityAdmission(p,a,pending,{owner,scopeHash:approval.scopeSha256,approvalHash:digest(approval),profileId:op.profileId,lowerTier:lower});
        const old=(await c.query('SELECT 1 FROM instagram_saved_batch_admissions WHERE profile_id=$1 LIMIT 1',[op.profileId])).rowCount;
        assert.equal(old,0,'Artist already incurred a legacy charge; do not replay.');
        await c.query(`INSERT INTO instagram_priority_admissions(campaign_id,operation_key,profile_id,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,$5,2)`,[id,op.key,op.profileId,op.kind,op.inputSha256]);
        await c.query('UPDATE instagram_priority_runs SET reserved_cents=reserved_cents+2,updated_at=now() WHERE id=$1',[id]);
      }),
      returned:(op,sha,status)=>tx(async c=>{
        await assertRun(c);
        const r=await c.query(`UPDATE instagram_priority_admissions SET status='returned',receipt_sha256=$4,http_status=$5
          WHERE campaign_id=$1 AND operation_key=$2 AND input_sha256=$3 AND status='admitted'`,[id,op.key,op.inputSha256,sha,status]);
        assert.equal(r.rowCount,1);
        await c.query('UPDATE instagram_priority_runs SET updated_at=now() WHERE id=$1',[id]);
      })});
    const originalById=new Map(queue.map(a=>[String(a.profile_id),a]));
    // Prior bound URLs are caution about reuse, not guessed aliases.
    const owners=new Map();
    for(const prior of await read(root+'/baseline.json'))for(const candidate of prior.candidates??[]){
      if(!owners.has(candidate.url))owners.set(candidate.url,new Set());
      owners.get(candidate.url).add(prior.profileId);
    }
    await progress();
    while(true){
      const selected=(await pool.query("SELECT * FROM instagram_priority_artists WHERE campaign_id=$1 AND status='queued' ORDER BY tier,ordinal LIMIT 20",[id])).rows;
      if(!selected.length)break;
      const eligible=await select(instagramPriorityEligibility(selected.map(a=>a.profile_id)));
      const current=new Map(eligible.map(a=>[a.profile_id,a])),targets=[];
      for(const a of selected){
        const now=current.get(a.profile_id);
        if(!now||now.cm_artist!==a.cm_artist){
          await pool.query(`UPDATE instagram_priority_artists SET status='deferred',reason='current_catalog_eligibility_or_identity_changed',updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'`,[id,a.profile_id]);
        }else targets.push({...a,artist:now.artist});
      }
      if(!targets.length){await progress();continue;}
      const context=await contextFor(targets);
      const savedIds=targets.filter(a=>Number(originalById.get(a.profile_id).has_saved_candidate)===1).map(a=>a.profile_id);
      const saved=new Map();
      if(savedIds.length){
        const rows=await select(`SELECT toString(profile_id) profile_id,argMax(tuple(cm_artist,artist,result_json),updated_at) latest,
          toString(max(updated_at),'UTC') captured_at FROM poc_new_verticals.musician_instagram_discovery_events
          WHERE profile_id IN (${savedIds.join(',')}) AND status='candidates_found' GROUP BY profile_id`);
        for(const row of rows)saved.set(row.profile_id,row);
      }
      for(const a of targets){
        await tx(async c=>{
          await assertRun(c);
          const r=await c.query("UPDATE instagram_priority_artists SET status='in_progress',artist=$3,updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'",[id,a.profile_id,a.artist]);
          assert.equal(r.rowCount,1);
        });
        active=a.profile_id;
        const target=context.get(active);assert.ok(target);assert.equal(target.player.cm_artist,a.cm_artist);
        const source=saved.get(active);
        if(source&&String(source.latest[0])===a.cm_artist){
          const parsed=JSON.parse(source.latest[2]);assert.ok(Array.isArray(parsed.profiles));
          target.candidates=parsed.profiles.flatMap(c=>{const url=instagramProfileUrl(c.url);return url?[{...c,url}]:[];});
          target.sourceCapturedAt=source.captured_at;target.sourceArtistName=source.latest[1];
        }
        if(!target.candidates.length){
          for(const queryIndex of [0,1]){
            const packet=await request(active,'search','search-'+active+'-'+queryIndex,{
              method:'POST',url:'https://google.serper.dev/search',body:{q:serperQuery({artist:a.artist,queryIndex}),num:10}});
            if(packet.status>=500){target.searchUnavailable=true;break;}
            assert.equal(packet.status,200);assert.ok(Array.isArray(packet.data.organic),'Search failure is not a no-match.');
            target.candidates=instagramSearchCandidates(packet.data.organic.map(hit=>({...hit,observedAt:packet.at})),
              a.artist,{explicitAliases:true});
            target.sourceCapturedAt=packet.at;
            if(target.candidates.length)break;
          }
        }
        const expanded=instagramSearchCandidates([],a.artist,{explicitAliases:true,savedCandidates:target.candidates});
        if(expanded.length)target.candidates=expanded;
        target.candidates=[...new Map(target.candidates.map(c=>[c.url,c])).values()];
        await save('inputs/'+active+'-scope.json',target);
        const findings=[];
        for(const candidate of target.candidates){
          if(!owners.has(candidate.url))owners.set(candidate.url,new Set());
          owners.get(candidate.url).add(active);
          const key=active+'-'+digest(candidate.url);
          const packet=await request(active,'metadata','metadata-'+key,{method:'GET',
            url:'https://api.scrapecreators.com/v1/instagram/profile?'+new URLSearchParams({handle:new URL(candidate.url).pathname.split('/')[1]})});
          const metadata=await normalizeSavedInstagram(packet,candidate.url,root+'/normalized',key);
          const finding={...candidate,metadata,reviewSuggestion:false,status:'metadata_unavailable',reason:metadata.reason??null};
          findings.push(finding);
          if(!metadata.available){if(packet.status>=500)break;continue;}
          let built;
          try{built=enrichedRequest({...target,selected:candidate},metadata.candidate);}
          catch{finding.status='held';finding.reason='complete_evidence_does_not_fit_supported_request';continue;}
          await save('inputs/'+key+'.json',{request:built.body,requestSha256:built.sha256});
          const response=await request(active,'model','model-'+key,{method:'POST',url:'https://openrouter.ai/api/alpha/decisions',body:built.body});
          if(response.status>=500){finding.status='model_unavailable';finding.reason='acknowledged_provider_server_error_not_retried';break;}
          assert.equal(response.status,200);assert.ok(!response.data.error);
          assert.ok(['typesafe/jev-1.13','typesafe/jev-1.13-20260917'].includes(response.data.model));
          assert.ok(Number.isFinite(response.data.usage?.cost)&&response.data.usage.cost>=0&&response.data.usage.cost<=.02);
          const answer=answersFrom(response.data,1)[0];assert.ok(answer);
          const profile={...built.profile,jevVerification:answer};
          const decision=catalogBoundReviewSuggestion(profile,target.player,{
            sharedHandle:owners.get(candidate.url).size>1,
            guardPolicy:'targeted_title_guard',modelState:built.body.state});
          Object.assign(finding,{status:decision.status,reason:decision.reason,reviewSuggestion:decision.reviewSuggestion,
            decision,recordedAnswer:answer,metadataActuallyUsed:built.body.state,requestSha256:built.sha256});
          if(finding.reviewSuggestion)break;
        }
        const checked=findings.some(f=>f.recordedAnswer),likely=findings.some(f=>f.reviewSuggestion);
        const result={profileId:active,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier,
          outcome:likely?'likely_review_suggestion':target.searchUnavailable?'search_unavailable':
            target.candidates.length?'checked_no_accepted_candidate':'completed_no_candidate_result',
          checked,likelyReviewSuggestion:likely,candidates:findings,allCandidates:target.candidates,
          artistCatalogMetadata:target.player,verified:false,liveLinkChanged:false};
        await save('artists/'+active+'.json',result);
        await tx(async c=>{
          await assertRun(c);
          const r=await c.query(`UPDATE instagram_priority_artists SET status='completed',searched=true,checked=$3,
            likely=$4,candidates=$5,result_sha256=$6,reason=$7,updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,
            [id,active,checked,likely,target.candidates.length,digest(result),result.outcome]);assert.equal(r.rowCount,1);
          await c.query('UPDATE instagram_priority_runs SET updated_at=now() WHERE id=$1',[id]);
        });
        active=null;await progress();
      }
    }
    await pool.query("UPDATE instagram_priority_runs SET status='completed',updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[id,owner]);await progress();
  }catch(e){
    if(claimed){
      const reason=/^provider_[a-z_]+$/.test(e.message)?e.message:'local_validation_or_unexpected_failure_no_retry';
      await pool.query("UPDATE instagram_priority_runs SET status='stopped',stop_reason=$3,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[id,owner,reason]);
      if(active)await pool.query("UPDATE instagram_priority_artists SET status='failed',reason=$3,updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'",[id,active,reason]);
      await save('stopped.json',{at:new Date().toISOString(),reason,errorClass:e.name,
        errorDetail:e.name==='AssertionError'?String(e.message).slice(0,300):undefined,
        activeProfile:active,reservationsRetained:true,noReplay:true});await progress();
    }
    throw Error('Instagram tier-priority worker stopped safely; no automatic retry.');
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await runPriorityInstagram();
