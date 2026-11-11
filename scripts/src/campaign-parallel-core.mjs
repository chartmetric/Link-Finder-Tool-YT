// Bounded, same-tier continuation. No provider calls or database connection at import.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {evidenceDigest as hash} from './youtube-ownership-policy.mjs';

export const CAMPAIGNS={
  instagram:{id:'full-tiers-1-5-no-ig-usd100',root:'generated-artifacts/instagram-tier-priority',
    runs:'instagram_priority_runs',artists:'instagram_priority_artists',admissions:'instagram_priority_admissions',
    channels:'instagram_priority_handles'},
  youtube:{id:'full-tiers-1-5-no-youtube-uncapped',root:'generated-artifacts/full-tiers-1-5-no-youtube-uncapped',
    runs:'youtube_link_campaigns',artists:'youtube_link_campaign_artists',admissions:'youtube_link_campaign_admissions',
    channels:'youtube_link_campaign_channels'},
};
export const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export const saveJson=async(file,value)=>fs.writeFile(file,JSON.stringify(value),{flag:'wx'});
export function assertParallelAdmission({run,artist,owner,approval,approvalHash,pending,live,lowerTier,width,closed}){
  assert.equal(closed,false,'Dispatch gate closed; drain only.');
  assert.equal(run.owner,owner);assert.equal(run.status,'running');
  assert.equal(run.maximum_spend_cents,null);
  assert.equal(run.scope_sha256,approval.scopeSha256);assert.equal(run.approval_sha256,approvalHash);
  assert.equal(artist.status,'in_progress');
  assert.equal(Number(lowerTier),0,'Higher-priority tier remains pending.');
  assert.ok(Number.isInteger(width)&&width>=1&&width<=128);
  assert.ok(pending.length<width,'Parallel request limit reached.');
  for(const op of pending){
    assert.equal(live.get(op.operation_key),op.profile_id,'Unknown or abandoned admission blocks dispatch.');
    assert.notEqual(op.profile_id,artist.profile_id,'Never overlap requests for one artist.');
  }
}
export function sameTierBatch(rows,width=3){
  assert.ok(Number.isInteger(width)&&width>0&&width<=192);
  if(!rows.length)return [];
  const sorted=[...rows].sort((a,b)=>a.tier-b.tier||a.ordinal-b.ordinal);
  return sorted.filter(a=>a.tier===sorted[0].tier).slice(0,width);
}
export async function drainBatch(rows,work,onError){
  // Each rejection closes the dispatch gate before waiting for other lanes.
  // Already sent responses are persisted, never cancelled to change concurrency.
  const results=await Promise.allSettled(rows.map(async row=>{
    try{return await work(row);}catch(e){onError(e);throw e;}
  }));
  const failure=results.find(r=>r.status==='rejected');
  if(failure)throw failure.reason;
}
export async function rollingArtists({width,capacity=()=>width,load,work,onError}){
  assert.ok(Number.isInteger(width)&&width>=1&&width<=128);
  const active=new Map();
  let failure=null;
  const fail=e=>{if(!failure){failure=e;onError(e);}};
  try{
    while(!failure){
      const loadingAlongsideArtists=active.size>0;
      const limit=capacity();
      assert.ok(Number.isInteger(limit)&&limit>0&&limit<=width,'Invalid live slot limit.');
      const rows=await load(Math.max(0,limit-active.size),[...active.values()]);
      if(failure)break; // A live lane may fail during catalog preparation.
      assert.ok(rows.length<=width-active.size,'Prepared work exceeds available slots.');
      for(const row of rows){
        const task=Promise.resolve().then(()=>work(row)).catch(fail).finally(()=>active.delete(task));
        // Track preparation synchronously, before work's asynchronous database
        // claim. A refill must not select this still-queued artist a second time.
        active.set(task,row);
      }
      if(!active.size){
        // The final lower-tier artist may finish while the loader observes
        // that tier as blocked. Re-read before declaring the queue complete.
        if(!rows.length&&loadingAlongsideArtists)continue;
        break;
      }
      await Promise.race(active.keys());
    }
  }catch(e){fail(e);}
  await Promise.allSettled(active.keys());
  if(failure)throw failure;
}
export function preparedArtistBuffer({batchSize,prepare}){
  assert.ok(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=192);
  let ready=[];
  return async(slots,activeRows=[])=>{
    if(slots<=0)return [];
    if(!ready.length){
      const rows=await prepare(batchSize,activeRows);
      assert.ok(rows.length<=batchSize,'Catalog preparation exceeds its bounded buffer.');
      ready=rows;
    }
    // Only the single rolling loader owns this buffer. Entries not yet handed
    // to a slot have no claims or paid admissions and remain queued on disk.
    return ready.splice(0,slots);
  };
}
export function gradualCapacity({maximum=128,intervalMs=60000,now=Date.now}={}){
  assert.ok([32,64,128].includes(maximum));assert.ok(intervalMs>0);
  const start=now();
  return ()=>Math.min(maximum,32*2**Math.floor(Math.max(0,now()-start)/intervalMs));
}
export function pacedAdmissions({intervalMs=50,now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  assert.ok(intervalMs>=1);
  const tails=new Map(),last=new Map();
  return kind=>{
    assert.ok(['search','metadata','model'].includes(kind));
    const step=(tails.get(kind)??Promise.resolve()).then(async()=>{
      const pause=Math.max(0,(last.get(kind)??-Infinity)+intervalMs-now());
      if(pause)await wait(pause);
      last.set(kind,now());
    });
    tails.set(kind,step);
    return step;
  };
}
export function safeDiagnostic(e,stage){
  const allowed=/^(?:provider_[a-z_]+|unreadable_provider_response|unexpected_provider_redirect)$/;
  const site=e.stack?.split('\n').map(line=>line.match(/\/([a-z0-9-]+\.mjs):(\d+):(\d+)/i)).find(Boolean);
  return {reason:allowed.test(e.message??'')?e.message:'local_validation_or_catalog_failure_no_retry',
    errorClass:['Error','AssertionError','TypeError','TimeoutError'].includes(e.name)?e.name:'Error',
    code:/^[A-Z0-9_]{2,40}$/.test(e.code??'')?e.code:null,stage,
    ...(site?{site:{file:site[1],line:Number(site[2]),column:Number(site[3])}}:{})};
}
export async function ledgerProof(c,cfg){
  const run=(await c.query(`SELECT * FROM ${cfg.runs} WHERE id=$1`,[cfg.id])).rows[0];
  const admissions=(await c.query(`SELECT * FROM ${cfg.admissions} WHERE campaign_id=$1 ORDER BY operation_key`,[cfg.id])).rows;
  const artists=(await c.query(`SELECT * FROM ${cfg.artists} WHERE campaign_id=$1 ORDER BY ordinal`,[cfg.id])).rows;
  assert.equal(run.status,'stopped','Only an ended worker can be handed off.');
  assert.equal(run.maximum_spend_cents,null);
  assert.equal(artists.length,run.total_artists);
  assert.ok(artists.every(a=>a.status!=='in_progress'),'Unfinished artist needs explicit recovery, not reset.');
  assert.ok(admissions.every(a=>a.status==='returned'),'Uncertain paid requests cannot be replayed.');
  assert.equal(Number(run.reserved_cents),admissions.reduce((n,a)=>n+a.reserved_cents,0));
  const paid=new Set(admissions.map(a=>a.profile_id));
  assert.ok(artists.every(a=>a.status!=='queued'||!paid.has(a.profile_id)),'Queued artist already has a paid admission.');
  return {run,admissions,artists,proof:{owner:run.owner,reservedCents:Number(run.reserved_cents),
    scopeSha256:run.scope_sha256,approvalSha256:run.approval_sha256,
    ledgerSha256:hash(admissions),artistsSha256:hash(artists)}};
}
export async function verifyArchive(cfg,ledger){
  const journal=(await fs.readFile(cfg.root+'/admissions.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ops=new Map(ledger.admissions.map(a=>[a.operation_key,a]));
  assert.equal(journal.length,ops.size,'Local and shared admission histories differ.');
  const seen=new Set();
  for(const j of journal){
    const a=ops.get(j.key);assert.ok(a);assert.ok(!seen.has(j.key));seen.add(j.key);
    assert.equal(j.profileId,a.profile_id);assert.equal(j.inputSha256,a.input_sha256);
    assert.equal(j.kind,a.kind);assert.equal(j.reservedCents,a.reserved_cents);
    const receipt=await readJson(cfg.root+'/receipts/'+hash(j.key)+'.json');
    assert.equal(hash(receipt),a.receipt_sha256);
    assert.equal(receipt.operationKey,j.key);assert.equal(receipt.kind,j.kind);
    assert.equal(receipt.inputSha256,j.inputSha256);assert.equal(hash(receipt.request),j.inputSha256);
    assert.equal(receipt.status,a.http_status);
  }
  let baseline=new Map();
  if(cfg.runs==='instagram_priority_runs'){
    const saved=await readJson(cfg.root+'/baseline.json'),approval=await readJson(cfg.root+'/approval.json');
    assert.equal(hash(saved),approval.baselineSha256,'Legacy baseline changed.');
    baseline=new Map(saved.map(a=>[a.profileId,a]));
  }
  for(const a of ledger.artists.filter(a=>a.status==='completed')){
    const result=baseline.get(a.profile_id)??await readJson(cfg.root+'/artists/'+a.profile_id+'.json');
    if(baseline.has(a.profile_id)&&a.result_sha256===null){
      // Imported historical counters were bound to the whole baseline rather
      // than individual result hashes. Never relax checks for new results.
      assert.equal(result.cmArtist,a.cm_artist);continue;
    }
    assert.equal(hash(result),a.result_sha256,'Completed evidence changed.');
  }
}
