// Explicit paid-work handoff preparation: local evidence + read-only catalog
// and ledger reconciliation, then development-only coordination setup.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {digest} from './instagram-next-saved-batch.mjs';
import {readCampaignLedger,reconcileCampaignArchive} from './instagram-campaign-recovery.mjs';
import {LEGACY_ROOT,PRIORITY_ROOT} from './instagram-tier-handoff.mjs';
import {PRIORITY_ID,priorityOrder,prioritySchema,legacyCounts} from './instagram-tier-priority-core.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {retireStoppedMetadataBudget} from './instagram-stopped-batch-recovery.mjs';

const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
export async function reconcilePriorityLegacy({root=LEGACY_ROOT,handoff,pool}){
  const progress=await read(root+'/progress.json');assert.equal(progress.status,'stopped');
  const approval=await read(root+'/uncapped-approval.json'),original=await read(root+'/approval.json');
  assert.equal(approval.originalApprovalSha256,digest(original));
  assert.equal(approval.maximumSpendCents,null);assert.equal(approval.uncappedExplicitlyApproved,true);
  const queue=await read(root+'/queue.json');assert.equal(digest(queue),original.queueSha256);
  const ledger=await readCampaignLedger(pool,PRIORITY_ID);
  assert.equal(ledger.parent.owner,handoff.parentOwner);
  assert.equal(ledger.parent.scope_sha256,digest(approval));assert.equal(ledger.parent.cap_cents,null);
  const chunks=await read(root+'/chunks.json');assert.equal(chunks.length,ledger.children.length);
  const baseline=new Map(),proofs=[],knownPaid=new Set();
  for(const chunk of chunks){
    const scope=await read(chunk.dir+'/approved-scope.json');
    const budget=ledger.children.find(b=>b.id===scope.authorization.budgetId);assert.ok(budget);
    const all=(await fs.readFile(chunk.dir+'/execution/admissions.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const sent=new Set(all.filter(j=>j.phase==='admitted').map(j=>j.key));
    const excluded=all.filter(j=>j.phase==='stopped_no_retry'&&!sent.has(j.key));
    if(excluded.length){
      assert.equal(chunk.dir,handoff.childDirectory);assert.equal(excluded.length,1);
      assert.equal(digest(scope),handoff.childScopeSha256);
      assert.ok(Date.parse(excluded[0].at)>=Date.parse(handoff.at));
      const fenced=(await pool.query('SELECT owner,reserved_cents FROM instagram_saved_batch_budgets WHERE id=$1',[budget.id])).rows[0];
      assert.equal(fenced.owner,handoff.parentOwner);
      assert.equal(fenced.reserved_cents,handoff.reservedAtFenceCents);
      assert.equal(budget.reserved_cents,all.filter(j=>j.phase==='admitted').length*2);
    }
    const journal=all.filter(j=>!excluded.includes(j)),packets={};
    let abandonment=null;
    try{abandonment=await read(chunk.dir+'/retired-unused-allocation.json');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    for(const j of journal.filter(j=>j.phase==='admitted')){
      assert.match(j.key,/^[A-Za-z0-9_-]+$/);
      const folder=j.request.kind==='scrapecreators_candidate'?'metadata-responses':'model-responses';
      try{packets[j.key]=await read(chunk.dir+'/execution/'+folder+'/'+j.key+'.json');}
      catch(e){if(e.code!=='ENOENT'||!abandonment?.uncertainKeysPermanentlySkipped?.includes(j.key))throw e;}
    }
    // Verify all receipts BEFORE retiring unused allowance. This never reduces
    // reservations and never reopens an old admission.
    const reconcileBudget=chunk.dir===handoff.childDirectory?{...budget,cap_cents:budget.reserved_cents}:budget;
    const reconciled=reconcileCampaignArchive({scope,journal,packets,budget:reconcileBudget,
      admissions:ledger.admissions.filter(a=>a.budget_id===budget.id),abandonment});
    if(budget.cap_cents!==budget.reserved_cents){
      assert.equal(chunk.dir,handoff.childDirectory);
      assert.equal(journal.filter(j=>j.phase==='returned').length,sent.size);
      const retirement=await retireStoppedMetadataBudget(pool,{scope,scopeSha256:digest(scope),
        receipts:[...sent].map(key=>({key,httpStatus:packets[key].status}))});
      await fs.writeFile(chunk.dir+'/retired-unused-allocation.json',JSON.stringify({...retirement,
        scopeSha256:digest(scope),journalSha256:digest(journal),approvedTierHandoff:true}),{flag:'wx'});
      budget.cap_cents=retirement.retiredCeilingCents;
    }
    reconciled.profileIds.forEach(p=>knownPaid.add(p));
    const checkpoints=(await fs.readFile(chunk.dir+'/execution/artist-checkpoints.jsonl','utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const latest=new Map();
    for(const checkpoint of checkpoints)for(const artist of checkpoint.changes??[])latest.set(String(artist.profileId),artist);
    for(const [id,a] of latest){
      const counts=legacyCounts(a);if(!counts.processed)continue;
      assert.ok(!baseline.has(id),'Repeated completed artist in legacy archive.');
      baseline.set(id,{profileId:id,cmArtist:String(a.cmArtist),artist:a.artist,
        ...counts,candidates:a.candidates,source:chunk.dir});
    }
    proofs.push({directory:chunk.dir,scopeSha256:digest(scope),journalSha256:digest(all),
      budgetId:budget.id,reservedCents:budget.reserved_cents,paidRequests:reconciled.admissions,
      preDispatchFenceKeys:excluded.map(x=>x.key)});
  }
  assert.ok([...knownPaid].every(id=>baseline.has(id)),'A previously paid artist must never return to untouched work.');
  const bindings=new Map(queue.map(a=>[String(a.profile_id),a]));
  for(const a of baseline.values())assert.equal(String(bindings.get(a.profileId)?.cm_artist),a.cmArtist);
  return {queue,baseline:[...baseline.values()],proofs,originalApproval:original,spendingApproval:approval,
    ledgerSha256:digest(ledger),legacyReservedCents:ledger.children.reduce((n,c)=>n+c.reserved_cents,0)};
}
async function main(){
  assert.deepEqual(process.argv.slice(2),['--prepare-approved']);
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const handoff=await read(PRIORITY_ROOT+'/handoff.json'),pool=await connectSavedBatchPool();
  try{
    const state=await reconcilePriorityLegacy({handoff,pool});
    const queue=priorityOrder(state.queue),scopeSha256=digest(queue),baselineSha256=digest(state.baseline);
    assert.equal(queue.length,76068);assert.equal(new Set(queue.map(a=>a.profile_id)).size,queue.length);
    for(const dir of ['receipts','artists','metadata','normalized','inputs'])await fs.mkdir(PRIORITY_ROOT+'/'+dir,{recursive:false});
    const modules=await freezeLocalModules('scripts/src/run-instagram-tier-priority.mjs',path.resolve(PRIORITY_ROOT,'runtime'));
    const runtimeFiles={};
    for(const source of modules)runtimeFiles[path.basename(source)]=digest(await fs.readFile(source,'utf8'));
    const approval={version:1,id:PRIORITY_ID,at:new Date().toISOString(),
      approvedBy:'User selected Switch to strict tier order.',
      order:'tier_1_then_2_then_3_then_4_then_5',scopeSha256,originalQueueSha256:state.originalApproval.queueSha256,
      originalQueueArtists:queue.length,maximumSpendCents:null,parentOwner:handoff.parentOwner,
      parentScopeSha256:digest(state.spendingApproval),baselineSha256,
      baselineArtists:state.baseline.length,legacyReservedCents:state.legacyReservedCents,
      ledgerSha256:state.ledgerSha256,runtimeFiles,noCatalogWrites:true,noAutomaticRetries:true,
      freshSearchesForHigherTierMissingCandidates:true,automaticContinuation:true};
    for(const [name,value] of Object.entries({approval,queue,baseline:state.baseline,legacyProofs:state.proofs}))
      await fs.writeFile(PRIORITY_ROOT+'/'+name+'.json',JSON.stringify(value),{flag:'wx'});
    await pool.query(prioritySchema);
    const historical=new Map(state.baseline.map(a=>[a.profileId,a])),c=await pool.connect();
    try{
      await c.query('BEGIN');
      const locked=await readCampaignLedger(c,PRIORITY_ID,true);
      assert.equal(digest(locked),state.ledgerSha256,'Legacy spending changed after reconciliation.');
      await c.query(`INSERT INTO instagram_priority_runs
        (id,owner,scope_sha256,approval_sha256,maximum_spend_cents,total_artists,status)
        VALUES($1,$2,$3,$4,NULL,$5,'prepared')`,[PRIORITY_ID,randomUUID(),scopeSha256,digest(approval),queue.length]);
      for(let at=0;at<queue.length;at+=1000){
        const rows=queue.slice(at,at+1000).map((a,i)=>{
          const prior=historical.get(String(a.profile_id));
          return {profile_id:String(a.profile_id),cm_artist:String(a.cm_artist),artist:prior?.artist??'Profile '+a.profile_id,
            tier:Number(a.tier),ordinal:at+i,status:prior?'completed':'queued',
            searched:!!prior,checked:prior?.checked??false,likely:prior?.likely??false,
            candidates:prior?.candidates?.length??0,reason:prior?'legacy_paid_work_preserved':null};
        });
        await c.query(`INSERT INTO instagram_priority_artists
          (campaign_id,profile_id,cm_artist,artist,tier,ordinal,status,searched,checked,likely,candidates,reason)
          SELECT $1,x.* FROM jsonb_to_recordset($2::jsonb) AS x(profile_id text,cm_artist text,artist text,tier int,
            ordinal int,status text,searched boolean,checked boolean,likely boolean,candidates int,reason text)`,
          [PRIORITY_ID,JSON.stringify(rows)]);
      }
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    console.log(JSON.stringify({status:'prepared',artists:queue.length,preservedArtists:state.baseline.length,
      reservedUsd:state.legacyReservedCents/100,nextTier:Number(queue.find(a=>!historical.has(String(a.profile_id))).tier),
      strictTierOrder:true,paidCalls:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
