// Read-only diagnosis/export. No worker resume, provider calls or result updates.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {catalogSelect} from './campaign-parallel-catalog.mjs';
const id='full-tiers-1-5-no-ig-usd100';
const out='generated-artifacts/instagram-deferred-review-2026-11-11';
const useSaved=process.argv.includes('--use-saved-deferrals');
const pool=await connectSavedBatchPool();
let deferred,statuses;
try{
  await pool.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await pool.query("SET LOCAL statement_timeout='30s'");
  statuses=(await pool.query(`SELECT status,count(*)::int artists FROM instagram_priority_artists
    WHERE campaign_id=$1 GROUP BY status`,[id])).rows;
  if(useSaved)deferred=JSON.parse(await fs.readFile(out+'/recorded-deferrals.json','utf8'));
  else{
  deferred=(await pool.query(`SELECT a.profile_id,a.cm_artist,a.artist,a.tier,a.reason,a.updated_at
    FROM instagram_priority_artists a WHERE a.campaign_id=$1 AND a.status='deferred'
    ORDER BY a.tier,a.ordinal`,[id])).rows;
  const prior=new Set((await pool.query(`SELECT DISTINCT d.profile_id
    FROM instagram_priority_admissions d INNER JOIN instagram_priority_artists a
      ON a.campaign_id=d.campaign_id AND a.profile_id=d.profile_id
    WHERE d.campaign_id=$1 AND a.status='deferred'`,[id])).rows.map(a=>a.profile_id));
  for(const a of deferred)a.had_priority_paid_request=prior.has(a.profile_id);
  }
  await pool.query('COMMIT');
}catch(error){await pool.query('ROLLBACK');throw error;}finally{await pool.end();}
assert.equal(deferred.length,9410);
assert.equal(new Set(deferred.map(a=>a.profile_id)).size,deferred.length);
assert.ok(deferred.every(a=>/^\d+$/.test(a.profile_id)&&/^\d+$/.test(a.cm_artist)));
if(!useSaved)await fs.mkdir(out);
const write=(name,value)=>fs.writeFile(out+'/'+name,
  typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
if(!useSaved)await write('recorded-deferrals.json',deferred);
const ids=deferred.map(a=>a.profile_id).join(',');
const snapshot=`SELECT max(computed_at) FROM new_vertical.l_profile_tier FINAL
  WHERE grain='global' AND profile_type='musician'`;
const sql=`SELECT toString(p.id) profile_id,toString(p.cm_source_id) cm_artist,
  p.cm_source AS cm_source,isNull(p.deleted_at) AS profile_is_active,
  if(t.tier_rows>0,toString(t.tier),NULL) AS current_global_tier,t.tier_rows AS current_tier_rows,
  toString((${snapshot}),'UTC') AS tier_snapshot_at
  FROM new_vertical.profile p FINAL LEFT JOIN (
    SELECT profile,argMax(tier,tuple(computed_at,updated_at)) AS tier,count() AS tier_rows
    FROM new_vertical.l_profile_tier FINAL WHERE grain='global' AND profile_type='musician'
    AND computed_at=(${snapshot}) AND profile IN (${ids}) GROUP BY profile
  ) t ON t.profile=p.id WHERE p.id IN (${ids})`;
await write('read-only-profile-tier-query.sql',sql);
const profiles=await catalogSelect(sql),byId=new Map(profiles.map(a=>[a.profile_id,a]));
await write('current-profile-tier-rows.json',profiles);
const tierEligible=deferred.filter(a=>{
  const p=byId.get(a.profile_id);
  return p?.profile_is_active===1&&p.cm_source==='cm_artist'&&p.cm_artist===a.cm_artist
    &&p.current_tier_rows>0&&Number(p.current_global_tier)>=1&&Number(p.current_global_tier)<=5;
});
let instagram=[];
if(tierEligible.length){
  const selected=tierEligible.map(a=>a.profile_id).join(',');
  // Match the frozen eligibility rule, including its treatment of active links.
  const query=`SELECT DISTINCT toString(l.profile_id) AS profile_id
    FROM (SELECT profile_id,account_id FROM new_vertical.l_profile_account FINAL
      WHERE disconnected_at IS NULL AND profile_id IN (${selected})) l
    INNER JOIN (SELECT id FROM new_vertical.account FINAL
      WHERE lower(platform)='instagram' AND notEmpty(trim(ifNull(account_url,'')))
      AND id IN (SELECT account_id FROM new_vertical.l_profile_account FINAL
        WHERE disconnected_at IS NULL AND profile_id IN (${selected}))) a ON a.id=l.account_id`;
  await write('current-instagram-link-query.sql',query);
  instagram=await catalogSelect(query);
}
const withInstagram=new Set(instagram.map(a=>a.profile_id)),linkChecked=new Set(tierEligible.map(a=>a.profile_id));
await write('current-instagram-link-rows.json',instagram);
const recordedReasons={},tiers={},currentReasons={},rows=[];
const labels={
  profile_missing:'Profile no longer found in current catalog',
  profile_inactive:'Profile is no longer active',
  identity_changed:'Catalog artist identity changed',
  missing_current_global_tier:'Missing from latest global musician tier snapshot',
  outside_tiers_1_to_5:'Currently outside tiers 1–5',
  now_has_catalog_instagram:'Currently has a catalog Instagram link',
  currently_eligible:'Currently eligible again; historical deferral cause remains combined',
};
for(const a of deferred){
  const p=byId.get(a.profile_id);let bucket;
  if(!p)bucket='profile_missing';
  else if(p.profile_is_active!==1)bucket='profile_inactive';
  else if(p.cm_source!=='cm_artist'||p.cm_artist!==a.cm_artist)bucket='identity_changed';
  else if(!p.current_tier_rows)bucket='missing_current_global_tier';
  else if(Number(p.current_global_tier)<1||Number(p.current_global_tier)>5)bucket='outside_tiers_1_to_5';
  else bucket=withInstagram.has(a.profile_id)?'now_has_catalog_instagram':'currently_eligible';
  recordedReasons[a.reason]=(recordedReasons[a.reason]??0)+1;
  tiers[a.tier]=(tiers[a.tier]??0)+1;
  currentReasons[bucket]=(currentReasons[bucket]??0)+1;
  rows.push({artist:a.artist,profile_id:a.profile_id,cm_artist_at_start:a.cm_artist,tier_at_start:a.tier,
    recorded_deferral_reason:a.reason,deferred_at:new Date(a.updated_at).toISOString(),
    had_priority_paid_request:a.had_priority_paid_request,
    current_profile_found:Boolean(p),current_profile_active:p?.profile_is_active===1,
    current_cm_source:p?.cm_source??'',current_cm_artist:p?.cm_artist??'',
    current_global_tier:p?.current_global_tier??'',current_tier_snapshot:p?.tier_snapshot_at??'',
    catalog_instagram_link_checked:linkChecked.has(a.profile_id),
    currently_has_catalog_instagram:linkChecked.has(a.profile_id)?withInstagram.has(a.profile_id):'not checked after earlier eligibility failure',
    current_eligibility_bucket:bucket,current_eligibility_description:labels[bucket]});
}
assert.equal(Object.values(currentReasons).reduce((n,x)=>n+x,0),9410);
const summary={campaignId:id,recordedAt:new Date().toISOString(),deferredArtists:deferred.length,
  savedReasons:recordedReasons,startingTierBreakdown:tiers,currentEligibilityBreakdown:currentReasons,
  bucketLabels:labels,hadPriorityPaidRequest:deferred.filter(a=>a.had_priority_paid_request).length,
  campaignStatuses:statuses,currentCatalogProfilesFound:profiles.length,
  latestTierSnapshots:[...new Set(profiles.map(p=>p.tier_snapshot_at))],
  historicalCauseDistinction:'Worker saved one combined eligibility/identity reason. Current catalog classification is a new read-only observation, not reconstruction of exact historical checks.',
  classificationOrder:'Missing profile, inactive profile, identity change, missing global tier, outside tiers 1–5, existing Instagram, currently eligible. Instagram is queried only after other eligibility checks pass.',
  paidProviderCalls:0,databaseWrites:0,campaignResumed:false};
await write('summary.json',summary);
const columns=Object.keys(rows[0]),cell=value=>{
  let s=String(value??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
await write('deferred-artists.csv','\ufeff'+[columns,...rows.map(r=>columns.map(c=>r[c]))]
  .map(r=>r.map(cell).join(',')).join('\r\n'));
console.log(JSON.stringify(summary,null,2));
