// Read-only readiness shared by preparation and the locked metadata gate.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveMixedCaptures,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {assertNoNewIdentityClaims} from './youtube-video-identity-execution.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
export const MIXED_PARENT='full-tiers-1-5-no-youtube-uncapped';
export function assertMixedApproval(plan,approval){
  assert.deepEqual(approveMixedCaptures(plan,approval),approval);
}
export async function mixedHistoricalClaims(c,claims,{identityInstalled=true}={}){
  if(identityInstalled)assertNoNewIdentityClaims(claims,
    (await c.query('SELECT * FROM youtube_video_identity_claims')).rows.map(r=>({
      alias:r.alias,channelId:r.channel_id,profileId:r.profile_id,cmArtist:r.cm_artist})));
  const historical=(await c.query(`SELECT ch.channel_id,ch.profile_id,a.cm_artist
    FROM youtube_link_campaign_channels ch LEFT JOIN youtube_link_campaign_artists a
      ON a.campaign_id=ch.campaign_id AND a.profile_id=ch.profile_id
    WHERE ch.channel_id=ANY($1::text[])`,[claims.map(x=>x.channelId).filter(Boolean)])).rows;
  assertNoNewIdentityClaims(claims,historical.map(r=>({alias:'',channelId:r.channel_id,
    profileId:r.profile_id,cmArtist:r.cm_artist})));
  const rows=(await c.query('SELECT profile_id,cm_artist,candidates_json FROM youtube_discovery_test_results')).rows;
  for(const r of rows){
    const found=[],visit=value=>{
      if(typeof value==='string'){
        const alias=returnedYoutubeUrl(value);
        if(alias)found.push({alias,channelId:alias.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
          profileId:r.profile_id,cmArtist:r.cm_artist});
      }else if(Array.isArray(value))value.forEach(visit);
      else if(value&&typeof value==='object'){
        if(/^UC[A-Za-z0-9_-]{22}$/.test(value.channelId??''))found.push({
          alias:'',channelId:value.channelId,profileId:r.profile_id,cmArtist:r.cm_artist});
        Object.values(value).forEach(visit);
      }
    };
    visit(r.candidates_json);assertNoNewIdentityClaims(claims,found);
  }
}
export async function mixedCaptureReadiness(c,plan,{ownRun=false,preparationOnly=false}={}){
  const tables=(await c.query(`SELECT to_regclass('youtube_video_identity_runs') runs,
    to_regclass('youtube_video_identity_admissions') admissions,to_regclass('youtube_video_identity_claims') claims`)).rows[0];
  const installed=Boolean(tables.runs&&tables.admissions&&tables.claims);
  if(!installed){
    assert.ok(preparationOnly&&!tables.runs&&!tables.admissions&&!tables.claims,
      'Identity coordinator missing or partly installed');
  }
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',
    [MIXED_PARENT])).rows[0]?.status,'stopped');
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
  [ownRun?plan.id:'',profiles,artists,channels])).rows[0].n,0,'Previous identity-stage metadata allocation');
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
      WHERE kind='metadata' AND profile_id=ANY($1::text[])`,[profiles])).rows[0].n,0,
    'Previous campaign/test channel lookup');
  const urls=plan.selections.map(s=>s.url.toLowerCase());
  if(installed)assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_claims
    WHERE lower(alias)=ANY($1::text[]) AND profile_id<>ALL($2::text[])`,[urls,profiles])).rows[0].n,0,
  'Another artist has a historical channel claim');
  // Verify every charge in the completed search and split uploader chain.
  const search=(await c.query('SELECT status,reserved_cents FROM youtube_discovery_test_runs WHERE id=$1',
    [plan.sourceSearchId])).rows[0];
  assert.equal(search?.status,'completed');assert.equal(search.reserved_cents,40);
  const searchRows=(await c.query(`SELECT operation_key,profile_id,input_sha256,receipt_sha256,status,http_status
    FROM youtube_bounded_test_admissions WHERE run_id=$1 AND kind='search'`,[plan.sourceSearchId])).rows;
  assert.equal(searchRows.length,20);
  for(const row of searchRows){
    assert.equal(row.status,'returned');assert.equal(row.http_status,200);
    const receipt=JSON.parse(await fs.readFile('generated-artifacts/'+plan.sourceSearchId+
      '/receipts/'+archivedSearchReceiptName(row.profile_id)));
    assert.equal(row.operation_key,receipt.operationKey);
    assert.equal(row.input_sha256,receipt.inputSha256);
    assert.equal(row.receipt_sha256,digest(receipt));
  }
  const uploaderKeys=new Set();
  for(const id of plan.sourceUploaderIds){
    const root='generated-artifacts/'+id;
    const p=JSON.parse(await fs.readFile(root+'/plan.json'));
    const run=(await c.query('SELECT status,plan_sha256,approval_sha256,reserved_cents FROM youtube_video_stage_runs WHERE id=$1',[id])).rows[0];
    assert.ok(run&&['stopped','completed'].includes(run.status));assert.equal(run.plan_sha256,digest(p));
    assert.equal(run.approval_sha256,digest(JSON.parse(await fs.readFile(root+'/approval.json'))));
    const rows=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1',[id])).rows;
    assert.equal(rows.length*2,run.reserved_cents);
    for(const row of rows){
      assert.equal(row.status,'returned');assert.equal(row.http_status,200);
      assert.ok(!uploaderKeys.has(row.operation_key));uploaderKeys.add(row.operation_key);
      const op=p.operations.find(o=>o.key===row.operation_key);assert.ok(op);
      const receipt=JSON.parse(await fs.readFile(root+'/receipts/'+digest(op.key)+'.json'));
      assert.equal(row.input_sha256,op.inputSha256);assert.equal(row.receipt_sha256,digest(receipt));
      assert.equal(row.raw_sha256,receipt.rawBodySha256);
    }
  }
  if(plan.version===DIRECT_CAPTURE_POLICY){
    assert.deepEqual(plan.sourceUploaderIds,[]);assert.deepEqual(plan.uploaderResults,[]);
    assert.equal(uploaderKeys.size,0);
  }else{
    assert.equal(uploaderKeys.size,24);
    const original=JSON.parse(await fs.readFile('generated-artifacts/'+plan.sourceUploaderIds[0]+'/plan.json'));
    assert.equal(original.operations.length,24);
    assert.ok(original.operations.every(o=>uploaderKeys.has(o.key)));
  }
  await mixedHistoricalClaims(c,plan.selections.map(s=>({
    alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist})),{identityInstalled:installed});
  return {identityCoordinatorInstalled:installed,requiresCoordinatorSetup:!installed};
}
