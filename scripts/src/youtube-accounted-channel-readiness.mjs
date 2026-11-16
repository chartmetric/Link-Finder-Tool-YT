import assert from 'node:assert/strict';
import {inspectIdentityConflict,HOLD_CHANNEL_CONFLICTS} from './youtube-identity-conflict-hold.mjs';
import {assertAccountedLedger} from './youtube-accounted-search-source.mjs';
import {mixedHistoricalClaims,MIXED_PARENT} from './youtube-mixed-capture-readiness.mjs';
export async function accountedChannelReadiness(c,plan,{ownRun=false,preparationOnly=false,holdIdentityConflicts=false}={}){
  if(holdIdentityConflicts)assert.equal(plan.identityConflictPolicy,HOLD_CHANNEL_CONFLICTS);
  await assertAccountedLedger(c,plan.sourceRoot);
  const tables=(await c.query(`SELECT to_regclass('youtube_video_identity_runs') runs,
    to_regclass('youtube_video_identity_admissions') admissions,to_regclass('youtube_video_identity_claims') claims`)).rows[0];
  const installed=Boolean(tables.runs&&tables.admissions&&tables.claims);
  assert.ok(installed||(preparationOnly&&!tables.runs&&!tables.admissions&&!tables.claims),
    'Identity coordinator missing or partly installed');
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[MIXED_PARENT])).rows[0]?.status,'stopped');
  for(const table of ['youtube_discovery_test_runs','youtube_video_stage_runs','youtube_link_campaigns'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  if(installed)assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_runs
    WHERE status='running' AND id<>$1`,[ownRun?plan.id:''])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions','youtube_video_stage_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
  if(installed)assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE status='admitted' AND run_id<>$1`,[ownRun?plan.id:''])).rows[0].n,0);
  const profiles=plan.selections.map(s=>s.profileId),artists=plan.selections.map(s=>s.cmArtist);
  const channels=plan.operations.map(o=>o.allocationChannelKey);
  if(installed)assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE kind='metadata' AND run_id<>$1 AND
    (profile_id=ANY($2::text[]) OR cm_artist=ANY($3::text[]) OR channel_id=ANY($4::text[]))`,
  [ownRun?plan.id:'',profiles,artists,channels])).rows[0].n,0,'Previously allocated channel check');
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
      WHERE kind='metadata' AND profile_id=ANY($1::text[])`,[profiles])).rows[0].n,0);
  // Campaign cm_artist exclusions are independent of profile IDs.
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions d
    INNER JOIN youtube_link_campaign_artists a ON a.campaign_id=d.campaign_id AND a.profile_id=d.profile_id
    WHERE d.kind='metadata' AND a.cm_artist=ANY($1::text[])`,[artists])).rows[0].n,0);
  await inspectIdentityConflict(()=>mixedHistoricalClaims(c,plan.selections.map(s=>({
    alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist})),{identityInstalled:installed}),holdIdentityConflicts);
}
