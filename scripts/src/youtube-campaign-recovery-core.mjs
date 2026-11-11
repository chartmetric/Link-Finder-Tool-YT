// Recovery never erases admissions, refunds reservations, or repairs receipts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {validateQueue,validateRequest} from './youtube-campaign-core.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';

export const recoverySchema=`
CREATE TABLE IF NOT EXISTS youtube_link_campaign_recoveries (
 campaign_id text NOT NULL REFERENCES youtube_link_campaigns(id),
 prior_owner uuid NOT NULL,owner uuid NOT NULL UNIQUE,plan_sha256 text NOT NULL,
 status text NOT NULL CHECK(status IN ('prepared','approved','running','stopped','completed')),
 approval jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(campaign_id,prior_owner)
);`;
export const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export async function optionalJson(file){
  try{return await readJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function immutableJson(file,value){
  try{await fs.writeFile(file,JSON.stringify(value),{flag:'wx'});}
  catch(e){if(e.code!=='EEXIST')throw e;assert.equal(evidenceDigest(await readJson(file)),evidenceDigest(value),
    'Existing evidence differs; preserve it and stop.');}
}
// Sort SQL snapshots so driver row ordering cannot create or hide a change.
export function canonicalSnapshot(s){
  const rows=(items,key)=>items.map(x=>({...x})).sort((a,b)=>key(a).localeCompare(key(b)));
  return {campaign:{...s.campaign},
    artists:rows(s.artists,a=>String(a.ordinal).padStart(12,'0')),
    admissions:rows(s.admissions,a=>a.operation_key),
    channels:rows(s.channels,a=>a.channel_id+':'+a.profile_id)};
}
export const snapshotHash=s=>evidenceDigest(canonicalSnapshot(s));

export function assertReceipt(a,packet){
  assert.ok(packet,'Missing committed receipt; no retry.');
  assert.equal(packet.operationKey,a.operation_key);
  assert.equal(packet.kind,a.kind);
  assert.equal(packet.inputSha256,a.input_sha256);
  assert.equal(evidenceDigest(packet.request),a.input_sha256,'Exact paid request changed.');
  validateRequest(a.kind,packet.request);
  assert.equal(evidenceDigest(packet),a.receipt_sha256,'Saved receipt hash changed.');
  assert.equal(packet.status,a.http_status);
  assert.ok(Number.isFinite(Date.parse(packet.at)));
}
export async function reconcileRecovery({root,snapshot,queue,approval}){
  validateQueue(queue);
  const s=canonicalSnapshot(snapshot),p=s.campaign;
  assert.ok(p&&['running','stopped'].includes(p.status),'Only an interrupted campaign can be recovered.');
  assert.equal(p.scope_sha256,evidenceDigest(queue));
  assert.equal(p.approval_sha256,evidenceDigest(approval));
  assert.equal(approval.scopeSha256,evidenceDigest(queue));
  assert.equal(approval.explicitApproval,true);assert.equal(approval.maximumSpendCents,null);
  assert.equal(approval.id,p.id);assert.equal(approval.totalArtists,queue.length);
  assert.equal(p.maximum_spend_cents,null);assert.equal(p.total_artists,queue.length);
  assert.equal(s.artists.length,queue.length);
  for(const [i,a] of s.artists.entries()){
    const q=queue[i];
    for(const k of ['profile_id','cm_artist','artist','tier'])assert.equal(a[k],q[k]);
    assert.equal(a.ordinal,i);
    assert.equal(a.campaign_id,p.id);
  }
  const artists=new Map(s.artists.map(a=>[a.profile_id,a]));
  const seen=new Set(),receipts=[],blockers=[],metadata=[],results=[];
  let reserved=0;
  for(const a of s.admissions){
    assert.equal(a.campaign_id,p.id);assert.ok(artists.has(a.profile_id));
    assert.ok(!seen.has(a.operation_key));seen.add(a.operation_key);
    assert.equal(Number(a.reserved_cents),2);reserved+=2;
    assert.match(a.input_sha256,/^[a-f0-9]{64}$/);
    const packet=await optionalJson(root+'/receipts/'+evidenceDigest(a.operation_key)+'.json');
    if(a.status==='admitted'){
      // Even a locally present orphan receipt is NOT a committed returned
      // receipt. Freeze its hash, but never promote or replay the admission.
      blockers.push({key:a.operation_key,reason:'uncertain_admission_no_retry'});
      if(packet&&(packet.operationKey!==a.operation_key||packet.kind!==a.kind
        ||packet.inputSha256!==a.input_sha256||evidenceDigest(packet.request)!==a.input_sha256))
        blockers.push({key:a.operation_key,reason:'unbound_orphan_receipt_preserved'});
      receipts.push({key:a.operation_key,status:'admitted',localSha256:packet?evidenceDigest(packet):null});
    }else{
      assert.equal(a.status,'returned');
      try{assertReceipt(a,packet);}
      catch{blockers.push({key:a.operation_key,reason:'missing_or_mismatched_committed_receipt'});}
      receipts.push({key:a.operation_key,status:'returned',localSha256:packet?evidenceDigest(packet):null});
      if(packet&&(providerStopReason(packet)||packet.status!==200))
        blockers.push({key:a.operation_key,reason:'returned_provider_failure_no_retry'});
    }
  }
  assert.equal(Number(p.reserved_cents),reserved,'Every committed reservation must be retained.');
  for(const a of s.artists){
    const packet=await optionalJson(root+'/metadata/'+a.profile_id+'.json');
    if(packet){
      assert.equal(packet.profileId,a.profile_id);assert.equal(packet.cmArtist,a.cm_artist);
      metadata.push({profileId:a.profile_id,sha256:evidenceDigest(packet)});
    }else if(s.admissions.some(op=>op.profile_id===a.profile_id))
      blockers.push({profileId:a.profile_id,reason:'missing_original_artist_metadata'});
    const result=await optionalJson(root+'/artists/'+a.profile_id+'.json');
    if(a.status==='completed'){
      assert.ok(result,'Completed result is missing.');
      assert.equal(result.artist.profileId,a.profile_id);assert.equal(result.artist.cmArtist,a.cm_artist);
      assert.equal(evidenceDigest(result),a.result_sha256,'Committed artist result changed.');
    }
    if(result)results.push({profileId:a.profile_id,sha256:evidenceDigest(result)});
  }
  for(const channel of s.channels){
    assert.equal(channel.campaign_id,p.id);assert.ok(artists.has(channel.profile_id));
  }
  return {snapshotSha256:snapshotHash(s),reservedCents:reserved,receipts,metadata,results,blockers};
}
export function assertRecoveryClaim(plan,state){
  assert.equal(state.campaign.owner,plan.priorOwner,'Prior owner changed; prepare a new generation.');
  assert.equal(snapshotHash(state),plan.reconciliation.snapshotSha256,'Campaign changed after preparation.');
  assert.equal(plan.drained.priorOwner,plan.priorOwner);
  assert.equal(plan.drained.confirmed,true,'Prior worker must be drained, not merely stale.');
  assert.ok(plan.drained.operator.trim()&&plan.drained.evidence.trim());
  assert.ok(Number.isFinite(Date.parse(plan.drained.at)));
}
export function assertRecoveryApproval(plan,claim,approval){
  assert.equal(claim.owner,plan.owner);assert.equal(claim.plan_sha256,evidenceDigest(plan));
  assert.equal(claim.prior_owner,plan.priorOwner);
  assert.equal(plan.reconciliation.blockers.length,0,'Recovery blocked; uncertain work cannot be retried.');
  assert.equal(approval.planSha256,evidenceDigest(plan));
  assert.equal(approval.owner,plan.owner);assert.equal(approval.priorOwner,plan.priorOwner);
  assert.equal(approval.explicitApproval,true);assert.equal(approval.uncappedApproved,true);
  assert.ok(approval.approvedBy.trim());assert.ok(Number.isFinite(Date.parse(approval.at)));
}

// The campaign row lock serializes recovery claims with the legacy worker's
// admission fence. A stale heartbeat is deliberately not a drain signal.
export function recoveryStore(pool,id){
  return {transaction:async fn=>{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const campaign=(await c.query('SELECT * FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const artists=(await c.query('SELECT * FROM youtube_link_campaign_artists WHERE campaign_id=$1 ORDER BY ordinal',[id])).rows;
      const admissions=(await c.query('SELECT * FROM youtube_link_campaign_admissions WHERE campaign_id=$1 ORDER BY operation_key',[id])).rows;
      const channels=(await c.query('SELECT * FROM youtube_link_campaign_channels WHERE campaign_id=$1 ORDER BY channel_id,profile_id',[id])).rows;
      const claims=(await c.query('SELECT * FROM youtube_link_campaign_recoveries WHERE campaign_id=$1',[id])).rows;
      const state={campaign,artists,admissions,channels,claims};
      const value=await fn(state);
      // Only recovery ownership/authorization fields can be changed here.
      // Never rewrite admissions, reservation totals, artist evidence or channels.
      for(const claim of state.claims){
        await c.query(`INSERT INTO youtube_link_campaign_recoveries
          (campaign_id,prior_owner,owner,plan_sha256,status,approval) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(campaign_id,prior_owner) DO UPDATE SET status=EXCLUDED.status,approval=EXCLUDED.approval
          WHERE youtube_link_campaign_recoveries.owner=EXCLUDED.owner
          AND youtube_link_campaign_recoveries.plan_sha256=EXCLUDED.plan_sha256`,
        [id,claim.prior_owner,claim.owner,claim.plan_sha256,claim.status,claim.approval??null]);
      }
      if(campaign.owner!==state.nextOwner&&state.nextOwner){
        await c.query(`UPDATE youtube_link_campaigns SET owner=$2,status='running',stop_reason=NULL,updated_at=now()
          WHERE id=$1`,[id,state.nextOwner]);
      }
      await c.query('COMMIT');return value;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }};
}
export async function claimRecovery(store,plan){
  return store.transaction(state=>{
    assertRecoveryClaim(plan,state);
    const old=state.claims.find(c=>c.prior_owner===plan.priorOwner);
    if(old){
      assert.equal(old.owner,plan.owner,'Another recovery owns this generation.');
      assert.equal(old.plan_sha256,evidenceDigest(plan));return;
    }
    state.claims.push({prior_owner:plan.priorOwner,owner:plan.owner,plan_sha256:evidenceDigest(plan),status:'prepared'});
  });
}
export async function approveRecovery(store,plan,approval,verify=async()=>{}){
  return store.transaction(async state=>{
    assertRecoveryClaim(plan,state);
    await verify(state);
    const claim=state.claims.find(c=>c.prior_owner===plan.priorOwner);assert.ok(claim);
    assertRecoveryApproval(plan,claim,approval);
    if(claim.status==='approved'){assert.deepEqual(claim.approval,approval);return;}
    assert.equal(claim.status,'prepared');
    claim.status='approved';claim.approval=approval;
  });
}
export async function startRecovery(store,plan,verify=async()=>{}){
  return store.transaction(async state=>{
    assertRecoveryClaim(plan,state);
    await verify(state);
    const claim=state.claims.find(c=>c.prior_owner===plan.priorOwner);assert.ok(claim);
    assert.equal(claim.status,'approved','A separately recorded approval is required; never auto-resume.');
    assertRecoveryApproval(plan,claim,claim.approval);
    claim.status='running';state.nextOwner=plan.owner;
  });
}
export async function verifyRecoveryEvidence(root,plan,state){
  const reconciliation=await reconcileRecovery({root,snapshot:state,
    queue:await readJson(root+'/queue.json'),approval:await readJson(root+'/approval.json')});
  assert.deepEqual(reconciliation,plan.reconciliation,'Evidence changed; do not use stale recovery approval.');
}
export function recoveryTransport({admissions,readReceipt,assertFrozen,dispatch}){
  const saved=new Map(admissions.map(a=>[a.operation_key,a]));
  return async(profileId,kind,key,request)=>{
    validateRequest(kind,request);await assertFrozen();
    const a=saved.get(key);
    if(!a)return dispatch(profileId,kind,key,request);
    assert.equal(a.profile_id,profileId);assert.equal(a.kind,kind);
    assert.equal(a.input_sha256,evidenceDigest(request),'Reconstructed request differs; do not spend again.');
    assert.equal(a.status,'returned','Uncertain admission cannot be replayed.');
    const packet=await readReceipt(key);assertReceipt(a,packet);
    const reason=providerStopReason(packet);
    assert.ok(!reason&&packet.status===200,'Returned failure cannot be retried.');
    return packet;
  };
}
