// Explicit operator continuation; never an app startup hook or automatic retry.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';
import {priorityTransport} from './instagram-tier-priority-core.mjs';
import {campaignTransport} from './youtube-campaign-core.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {CAMPAIGNS,readJson,saveJson,ledgerProof,verifyArchive,assertParallelAdmission,
  sameTierBatch,drainBatch,rollingArtists,preparedArtistBuffer,gradualCapacity,pacedAdmissions,safeDiagnostic} from './campaign-parallel-core.mjs';
import {eligibilitySql,catalogContexts,instagramSavedCandidates,processInstagram,processYoutube} from './campaign-parallel-adapters.mjs';
import {COORDINATOR_OPTIONS,openCoordinatorPool,coordinatorTransactions} from './campaign-parallel-coordinator.mjs';

const DEFAULT_WIDTH=3;
const directory=path.dirname(fileURLToPath(import.meta.url));
async function transaction(pool,fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
    await c.query("SET LOCAL statement_timeout='30s'");const value=await fn(c);await c.query('COMMIT');return value;
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function assertLegacy(c,approval){
  const p=(await c.query('SELECT * FROM instagram_campaign_budgets WHERE id=$1 FOR UPDATE',[CAMPAIGNS.instagram.id])).rows[0];
  assert.equal(p.owner,approval.parentOwner);assert.equal(p.scope_sha256,approval.parentScopeSha256);assert.equal(p.cap_cents,null);
  const cents=(await c.query(`SELECT coalesce(sum(b.reserved_cents),0)::int n FROM instagram_campaign_children c
    JOIN instagram_saved_batch_budgets b ON b.id=c.budget_id WHERE c.campaign_id=$1`,[CAMPAIGNS.instagram.id])).rows[0].n;
  assert.equal(cents,approval.legacyReservedCents);
}
export async function prepareParallel(platform){
  assert.ok(process.argv.includes('--prepare-approved'));
  const cfg=CAMPAIGNS[platform];assert.ok(cfg);
  const rolling=process.argv.includes('--rolling-approved');
  if(rolling)assert.equal(platform,'instagram','YouTube remains paused.');
  const buffered=process.argv.includes('--buffered-approved');
  if(buffered)assert.ok(rolling&&platform==='instagram','Buffered speed-up is Instagram only.');
  const deadline=process.argv.includes('--deadline-approved');
  if(deadline)assert.ok(buffered&&platform==='instagram','Deadline speed-up is Instagram only.');
  const width=deadline?128:buffered?16:rolling?8:DEFAULT_WIDTH;
  const pool=await connectSavedBatchPool();
  try{
    const approval=await readJson(cfg.root+'/approval.json'),queue=await readJson(cfg.root+'/queue.json');
    assert.equal(approval.id,cfg.id);assert.equal(approval.maximumSpendCents,null);
    assert.equal(hash(queue),approval.scopeSha256);
    const ledger=await transaction(pool,async c=>{
      await c.query(`SELECT id FROM ${cfg.runs} WHERE id=$1 FOR UPDATE`,[cfg.id]);
      if(platform==='instagram')await assertLegacy(c,approval);
      return ledgerProof(c,cfg);
    });
    assert.equal(ledger.run.approval_sha256,hash(approval));assert.equal(ledger.run.scope_sha256,hash(queue));
    const bindings=new Map(queue.map((a,i)=>[a.profile_id,{...a,ordinal:i}]));
    for(const a of ledger.artists){
      const q=bindings.get(a.profile_id);assert.ok(q);
      assert.equal(a.cm_artist,q.cm_artist);assert.equal(a.tier,Number(q.tier));assert.equal(a.ordinal,q.ordinal);
    }
    await verifyArchive(cfg,ledger);
    const phase=cfg.root+'/parallel-'+randomUUID();await fs.mkdir(phase);
    const runtime=phase+'/runtime';
    const copied=await freezeLocalModules(fileURLToPath(import.meta.url),runtime);
    // Deliberately preserve each platform's launched evidence policy. Concurrent
    // task merges must not silently change the paid worker's decision inputs.
    for(const source of copied){
      const name=path.basename(source);
      // The sealing utility is operator-only code reviewed with this change;
      // it was not part of either old worker's runtime dependency graph.
      if(name.startsWith('campaign-parallel-')||name==='seal-youtube-campaign-runtime.mjs')continue;
      try{await fs.writeFile(runtime+'/'+name,await fs.readFile(cfg.root+'/runtime/'+name));}
      catch(e){
        if(e.code!=='ENOENT')throw e;
        // The generic runner includes the other platform's adapter as well.
        // Its unused modules still come from that platform's sealed runtime,
        // never a concurrently merged source policy.
        const other=CAMPAIGNS[platform==='youtube'?'instagram':'youtube'];
        await fs.writeFile(runtime+'/'+name,await fs.readFile(other.root+'/runtime/'+name));
      }
    }
    // Include dependencies named only by an older frozen policy revision.
    for(const name of (await fs.readdir(cfg.root+'/runtime')).filter(x=>x.endsWith('.mjs')))
      await fs.writeFile(runtime+'/'+name,await fs.readFile(cfg.root+'/runtime/'+name));
    const runtimeFiles={};
    for(const name of (await fs.readdir(runtime)).filter(x=>x.endsWith('.mjs')).sort())
      runtimeFiles[name]=hash(await fs.readFile(runtime+'/'+name,'utf8'));
    const manifest={version:1,at:new Date().toISOString(),platform,campaignId:cfg.id,width,rolling,buffered,deadline,
      catalogPreparationBatchSize:deadline?192:buffered?64:width,
      coordinator:{...COORDINATOR_OPTIONS,maximumPending:512,serializeTransactions:true},
      ...(deadline?{targetDeadline:'2026-11-11T20:00:00Z',rampIntervalMs:60000,admissionIntervalMs:50}:{}),
      approvalSha256:hash(approval),scopeSha256:hash(queue),before:ledger.proof,
      approvedBy:deadline?'User requested all remaining Tier 1–5 Instagram work by noon PST and asked to maximize effort; preserve uncapped authorization and keep YouTube paused.':
        buffered?'User requested faster Instagram again: prepare catalog context in groups and increase to sixteen rolling artists; YouTube stays paused.':
        rolling?'User approved increasing Instagram parallelism and removing group waits; keep YouTube paused.':
        'User selected Speed up; resume YouTube too.',
      approvedResume:true,maximumSpendCents:null,strictTierOrder:true,
      continueOnlyUntouchedArtists:true,preservePriorEvidenceAndCharges:true,
      noCatalogWrites:true,noAutomaticRetry:true,policyRuntime:cfg.root+'/runtime',runtimeFiles};
    await saveJson(phase+'/approval.json',manifest);
    console.log(JSON.stringify({prepared:true,platform,phase,width,rolling,buffered,deadline,paidRequests:0,
      preservedAdmissions:ledger.admissions.length,reservedCents:ledger.proof.reservedCents}));
    return phase;
  }finally{await pool.end();}
}
export async function runParallel(phase){
  assert.ok(process.argv.includes('--run-approved')&&process.argv.includes('--uncapped-approved'));
  const manifest=await readJson(phase+'/approval.json'),cfg=CAMPAIGNS[manifest.platform];
  assert.ok(cfg);assert.equal(manifest.campaignId,cfg.id);assert.equal(manifest.approvedResume,true);
  const WIDTH=manifest.deadline?128:manifest.buffered?16:manifest.rolling?8:DEFAULT_WIDTH;
  if(manifest.buffered){
    assert.equal(manifest.rolling,true);assert.equal(manifest.platform,'instagram');
    assert.equal(manifest.catalogPreparationBatchSize,manifest.deadline?192:64);
  }
  if(manifest.deadline){
    assert.equal(manifest.buffered,true);assert.equal(manifest.rampIntervalMs,60000);
    assert.equal(manifest.admissionIntervalMs,50);
  }
  if(manifest.rolling)assert.equal(manifest.platform,'instagram');
  assert.equal(manifest.width,WIDTH);assert.equal(manifest.maximumSpendCents,null);
  assert.equal(path.resolve(phase,'runtime'),directory,'Execute the sealed continuation, not mutable source.');
  const approval=await readJson(cfg.root+'/approval.json'),queue=await readJson(cfg.root+'/queue.json');
  assert.equal(hash(approval),manifest.approvalSha256);assert.equal(hash(queue),manifest.scopeSha256);
  for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])
    assert.ok(process.env[key],'Provider credential unavailable.');
  const assertFrozen=async()=>{
    assert.equal(hash(await readJson(phase+'/approval.json')),hash(manifest));
    assert.equal(hash(await readJson(cfg.root+'/approval.json')),manifest.approvalSha256);
    for(const [name,digest] of Object.entries(manifest.runtimeFiles)){
      assert.equal(path.basename(name),name);
      assert.equal(hash(await fs.readFile(directory+'/'+name,'utf8')),digest,'Sealed continuation changed.');
    }
  };
  await assertFrozen();
  if(manifest.coordinator)assert.deepEqual(manifest.coordinator,
    {...COORDINATOR_OPTIONS,maximumPending:512,serializeTransactions:true});
  const pool=manifest.coordinator?await openCoordinatorPool():await connectSavedBatchPool();
  const owner=randomUUID(),live=new Map();
  let claimed=false,closed=false,stage='claim',firstError=null;
  const close=e=>{closed=true;firstError??=e;};
  const tx=manifest.coordinator?coordinatorTransactions(pool,{maximumPending:512}):fn=>transaction(pool,fn);
  const assertOwner=async c=>{
    if(manifest.platform==='instagram')await assertLegacy(c,approval);
    const r=(await c.query(`SELECT * FROM ${cfg.runs} WHERE id=$1 FOR UPDATE`,[cfg.id])).rows[0];
    assert.equal(r.owner,owner);assert.equal(r.status,'running');
    assert.equal(r.approval_sha256,manifest.approvalSha256);assert.equal(r.scope_sha256,manifest.scopeSha256);
    return r;
  };
  async function progress(){
    const p=(await pool.query(`SELECT r.status,r.reserved_cents,r.updated_at,r.stop_reason,
      count(*) FILTER(WHERE a.status='completed')::int processed,
      count(*) FILTER(WHERE a.checked)::int checked,count(*) FILTER(WHERE a.likely)::int likely,
      count(*) FILTER(WHERE a.status='failed')::int failed,count(*) FILTER(WHERE a.status='deferred')::int deferred,
      min(tier) FILTER(WHERE a.status IN ('queued','in_progress')) next_tier
      FROM ${cfg.runs} r JOIN ${cfg.artists} a ON a.campaign_id=r.id WHERE r.id=$1 GROUP BY r.id`,[cfg.id])).rows[0];
    const value={campaignId:cfg.id,platform:manifest.platform,status:p.status,totalArtists:queue.length,
      processedArtists:p.processed,checkedArtists:p.checked,likelyMatches:p.likely,
      deferredArtists:p.deferred,failedArtists:p.failed,reservedCents:Number(p.reserved_cents)+(approval.legacyReservedCents??0),
      maximumSpendCents:null,nextTier:p.next_tier,strictTierOrder:true,parallelArtists:WIDTH,
      updatedAt:p.updated_at,stopReason:p.stop_reason};
    await fs.writeFile(phase+'/progress.json.tmp',JSON.stringify(value));
    await fs.rename(phase+'/progress.json.tmp',phase+'/progress.json');console.log(JSON.stringify(value));return value;
  }
  try{
    await saveJson(phase+'/launch-attempt.json',{at:new Date().toISOString(),owner,noReplay:true});
    await tx(async c=>{
      await c.query(`SELECT id FROM ${cfg.runs} WHERE id=$1 FOR UPDATE`,[cfg.id]);
      if(manifest.platform==='instagram')await assertLegacy(c,approval);
      const current=await ledgerProof(c,cfg);
      assert.deepEqual(current.proof,manifest.before,'Stopped coordinator changed after reconciliation.');
      await c.query(`UPDATE ${cfg.runs} SET owner=$2,status='running',stop_reason=NULL,updated_at=now() WHERE id=$1`,[cfg.id,owner]);
    });claimed=true;
    await saveJson(phase+'/launched.json',{at:new Date().toISOString(),owner,approvedResume:true});
    const transport=(manifest.platform==='instagram'?priorityTransport:campaignTransport)({
      root:cfg.root,assertFrozen,credentials:{serper:process.env.SERPERDEV_API_KEY,
        scrapecreators:process.env.SCRAPECREATORS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY},
      admit:op=>tx(async c=>{
        const run=await assertOwner(c);
        const artist=(await c.query(`SELECT * FROM ${cfg.artists} WHERE campaign_id=$1 AND profile_id=$2 FOR UPDATE`,[cfg.id,op.profileId])).rows[0];
        const pending=(await c.query(`SELECT operation_key,profile_id FROM ${cfg.admissions} WHERE campaign_id=$1 AND status='admitted'`,[cfg.id])).rows;
        const lower=(await c.query(`SELECT count(*)::int n FROM ${cfg.artists} WHERE campaign_id=$1 AND tier<$2
          AND status IN ('queued','in_progress')`,[cfg.id,artist.tier])).rows[0].n;
        assertParallelAdmission({run,artist,owner,approval,approvalHash:manifest.approvalSha256,
          pending,live,lowerTier:lower,width:WIDTH,closed});
        if(manifest.platform==='instagram')assert.equal((await c.query(
          'SELECT 1 FROM instagram_saved_batch_admissions WHERE profile_id=$1 LIMIT 1',[op.profileId])).rowCount,0);
        await c.query(`INSERT INTO ${cfg.admissions}(campaign_id,operation_key,profile_id,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,$5,2)`,[cfg.id,op.key,op.profileId,op.kind,op.inputSha256]);
        await c.query(`UPDATE ${cfg.runs} SET reserved_cents=reserved_cents+2,updated_at=now() WHERE id=$1`,[cfg.id]);
        // Register before releasing the serialized run lock.
        live.set(op.key,op.profileId);
      }).catch(e=>{close(e);throw e;}),
      returned:(op,sha,status)=>tx(async c=>{
        await assertOwner(c); // Remains valid during drain, even when dispatch is closed.
        const result=await c.query(`UPDATE ${cfg.admissions} SET status='returned',receipt_sha256=$4,http_status=$5
          WHERE campaign_id=$1 AND operation_key=$2 AND input_sha256=$3 AND status='admitted'`,
          [cfg.id,op.key,op.inputSha256,sha,status]);assert.equal(result.rowCount,1);
        await c.query(`UPDATE ${cfg.runs} SET updated_at=now() WHERE id=$1`,[cfg.id]);
      }).then(()=>{live.delete(op.key);}).catch(e=>{close(e);throw e;})});
    const pace=manifest.deadline?pacedAdmissions({intervalMs:manifest.admissionIntervalMs}):null;
    const request=async(...args)=>{
      if(pace)await pace(args[1]);
      assert.equal(closed,false,'Dispatch gate closed; drain only.');
      return transport(...args);
    };
    const owners=new Map();
    if(manifest.platform==='instagram'){
      const baseline=await readJson(cfg.root+'/baseline.json');
      const rows=(await pool.query(`SELECT profile_id FROM ${cfg.artists} WHERE campaign_id=$1 AND status='completed'`,[cfg.id])).rows;
      const old=new Map(baseline.map(a=>[a.profileId,a]));
      for(const a of rows){
        const r=old.get(a.profile_id)??await readJson(cfg.root+'/artists/'+a.profile_id+'.json');
        for(const candidate of r.allCandidates??r.candidates??[]){
          if(!owners.has(candidate.url))owners.set(candidate.url,new Set());owners.get(candidate.url).add(a.profile_id);
        }
      }
    }
    const conflict=manifest.platform==='instagram'?async(url,profileId)=>{
      if(!owners.has(url))owners.set(url,new Set());owners.get(url).add(profileId);return owners.get(url).size>1;
    }:async(channelId,profileId)=>tx(async c=>{
      await assertOwner(c);
      await c.query(`INSERT INTO ${cfg.channels}(campaign_id,channel_id,profile_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [cfg.id,channelId,profileId]);
      const others=(await c.query(`SELECT profile_id FROM ${cfg.channels} WHERE campaign_id=$1 AND channel_id=$2 AND profile_id!=$3`,
        [cfg.id,channelId,profileId])).rows;
      for(const other of others)await c.query(`UPDATE ${cfg.artists} SET likely=false,
        reason='channel_reused_across_catalog_artists',updated_at=now() WHERE campaign_id=$1 AND profile_id=$2`,[cfg.id,other.profile_id]);
      return others.length>0;
    });
    const queueById=new Map(queue.map(a=>[a.profile_id,a]));
    await progress();
    // One loader owns catalog preparation; live artist slots refill on completion.
    // Earliest-tier selection includes in-progress artists, so a slow lower-tier
    // artist still blocks every higher-tier dispatch.
    const load=async(slots,activeRows=[])=>{
      if(!slots||closed)return [];
      while(!closed){
      stage='catalog_eligibility';
      const rows=(await pool.query(`SELECT * FROM ${cfg.artists} WHERE campaign_id=$1 AND status='queued'
        AND NOT(profile_id=ANY($3::text[]))
        AND tier=(SELECT min(tier) FROM ${cfg.artists} WHERE campaign_id=$1 AND status IN ('queued','in_progress'))
        ORDER BY ordinal LIMIT $2`,[cfg.id,slots,activeRows.map(row=>row.a.profile_id)])).rows;
      if(!rows.length)return [];
      const batch=sameTierBatch(rows,slots),eligible=await select(eligibilitySql(manifest.platform,batch.map(a=>a.profile_id)));
      const now=new Map(eligible.map(a=>[a.profile_id,a])),targets=[];
      for(const a of batch){
        if(now.get(a.profile_id)?.cm_artist!==a.cm_artist){
          await tx(async c=>{await assertOwner(c);await c.query(`UPDATE ${cfg.artists}
            SET status='deferred',reason='current_catalog_eligibility_or_identity_changed',updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'`,[cfg.id,a.profile_id]);});
        }else targets.push({...a,artist:now.get(a.profile_id).artist});
      }
      if(!targets.length)continue;
      stage='catalog_metadata';
      const contexts=await catalogContexts(manifest.platform,cfg.root,targets);
      const saved=manifest.platform==='instagram'?await instagramSavedCandidates(
        targets.filter(a=>Number(queueById.get(a.profile_id).has_saved_candidate)===1)):new Map();
      return targets.map(a=>({a,target:contexts.get(a.profile_id),source:saved.get(a.profile_id)}));
      }
      return [];
    };
    const work=async({a,target,source})=>{
      stage='paid_artist_checks';
        await tx(async c=>{
          await assertOwner(c);assert.equal(closed,false);
          const r=await c.query(`UPDATE ${cfg.artists} SET status='in_progress',artist=$3,updated_at=now()
            WHERE campaign_id=$1 AND profile_id=$2 AND status='queued'`,[cfg.id,a.profile_id,a.artist]);assert.equal(r.rowCount,1);
        });
        try{
          const process=manifest.platform==='instagram'?processInstagram:processYoutube;
          const {result,stats,reason}=await process({target,a,source,
            root:cfg.root,request,conflict});
          await saveJson(cfg.root+'/artists/'+a.profile_id+'.json',result);
          await tx(async c=>{
            await assertOwner(c);
            // Recheck shared channels at commit: another live lane may have
            // registered the same channel after this lane's model started.
            if(manifest.platform==='youtube'){
              const shared=(await c.query(`SELECT 1 FROM ${cfg.channels} a JOIN ${cfg.channels} b
                ON a.campaign_id=b.campaign_id AND a.channel_id=b.channel_id AND a.profile_id!=b.profile_id
                WHERE a.campaign_id=$1 AND a.profile_id=$2 LIMIT 1`,[cfg.id,a.profile_id])).rowCount;
              if(shared)stats.likely=false;
            }else if(result.candidates.some(f=>f.reviewSuggestion&&(owners.get(f.url)?.size??0)>1))stats.likely=false;
            const r=await c.query(`UPDATE ${cfg.artists} SET status='completed',searched=$3,checked=$4,likely=$5,
              candidates=$6,result_sha256=$7,reason=$8,updated_at=now()
              WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,
              [cfg.id,a.profile_id,stats.searched,stats.checked,stats.likely,stats.candidates,hash(result),reason]);assert.equal(r.rowCount,1);
            await c.query(`UPDATE ${cfg.runs} SET updated_at=now() WHERE id=$1`,[cfg.id]);
          });
        }catch(e){
          close(e);
          await tx(async c=>{await assertOwner(c);await c.query(`UPDATE ${cfg.artists} SET status='failed',reason=$3,
            updated_at=now() WHERE campaign_id=$1 AND profile_id=$2 AND status='in_progress'`,
            [cfg.id,a.profile_id,safeDiagnostic(e,stage).reason]);});throw e;
        }
    };
    // Serialize progress-file writes; concurrent completions cannot share a
    // temporary filename or report an older count after a newer one.
    let report=Promise.resolve(),lastReportAt=0;
    const workAndReport=async row=>{
      await work(row);
      if(!manifest.buffered||Date.now()-lastReportAt>=5000){
        lastReportAt=Date.now();report=report.then(()=>progress());
      }
      await report;
    };
    if(manifest.rolling){
      const next=manifest.buffered?preparedArtistBuffer({batchSize:manifest.catalogPreparationBatchSize,prepare:load}):load;
      const capacity=manifest.deadline?gradualCapacity({maximum:WIDTH,intervalMs:manifest.rampIntervalMs}):()=>WIDTH;
      await rollingArtists({width:WIDTH,capacity,load:next,work:workAndReport,onError:close});
    }else while(!closed){
      const rows=await load(WIDTH);if(!rows.length)break;
      await drainBatch(rows,workAndReport,close);
    }
    assert.equal(closed,false);
    await tx(async c=>{await assertOwner(c);
      assert.equal((await c.query(`SELECT 1 FROM ${cfg.admissions} WHERE campaign_id=$1 AND status='admitted' LIMIT 1`,[cfg.id])).rowCount,0);
      assert.equal((await c.query(`SELECT 1 FROM ${cfg.artists}
        WHERE campaign_id=$1 AND status IN ('queued','in_progress') LIMIT 1`,[cfg.id])).rowCount,0,
        'Cannot mark a campaign complete while untouched or active artists remain.');
      await c.query(`UPDATE ${cfg.runs} SET status='completed',updated_at=now() WHERE id=$1`,[cfg.id]);});
    await progress();
  }catch(e){
    close(e);
    if(claimed){
      const diagnostic=safeDiagnostic(firstError,stage);
      await tx(async c=>{await assertOwner(c);await c.query(`UPDATE ${cfg.runs}
        SET status='stopped',stop_reason=$3,updated_at=now() WHERE id=$1 AND owner=$2`,[cfg.id,owner,diagnostic.reason]);});
      await saveJson(phase+'/stopped.json',{at:new Date().toISOString(),...diagnostic,
        reservationsRetained:true,noReplay:true,allLanesDrained:true});await progress();
    }
    throw Error('Parallel campaign stopped safely; inspect continuation diagnostic. No automatic replay.');
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--prepare-approved'))await prepareParallel(process.argv.at(-1));
  else if(process.argv.includes('--run-approved'))await runParallel(process.argv.at(-1));
  else throw Error('Explicit preparation or approved continuation required.');
}
