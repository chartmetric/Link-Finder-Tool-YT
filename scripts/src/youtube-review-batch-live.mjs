import assert from 'node:assert/strict';
import {boundedYoutubeGate} from './youtube-bounded-test-gate.mjs';
import {boundedExperimentReadiness} from './youtube-ownership-comparison-gate.mjs';
import {searchReadiness} from './run-youtube-staged-search.mjs';

export function assertReviewBatchSchema(schema){
  const limit=schema.constraints.find(c=>c.conname==='youtube_discovery_test_runs_cap_cents_check');
  assert.equal(limit?.definition,
    "CHECK ((((cap_cents > 0) AND (cap_cents <= 200)) OR ((cap_cents = 1000) AND (id ~~ 'youtube-test-100-%'::text))))",
    'Review the actual coordinator budget constraint before preparing this run');
}
export async function reviewBatchGlobalReadiness(c,plan,ownId=''){
  for(const table of ['youtube_link_campaigns','youtube_video_stage_runs','youtube_video_identity_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_discovery_test_runs
    WHERE status='running' AND id<>$1`,[ownId])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_video_stage_admissions',
    'youtube_video_identity_admissions','youtube_bounded_test_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0,
      'Unreturned paid work blocks dispatch');
}
export async function reviewBatchStart(c,plan,approval,owner){
  await c.query('SELECT id FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[plan.parentId]);
  await boundedExperimentReadiness(c,plan);
  await searchReadiness(c,plan.artists,plan.parentId);
  const ids=plan.artists.map(a=>a.profile_id),cms=plan.artists.map(a=>a.cm_artist);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
    WHERE profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[])`,[ids,cms])).rows[0].n,0);
  await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
    VALUES($1,$2,$3,1000,'running')`,[plan.id,owner,plan.scopeSha256]);
  for(const a of plan.artists)await c.query(`INSERT INTO youtube_discovery_test_results
    (run_id,profile_id,cm_artist,artist,tier,status,metadata_json)
    VALUES($1,$2,$3,$4,$5,'review_prepared',$6::jsonb)`,
  [plan.id,a.profile_id,a.cm_artist,a.artist,a.tier,JSON.stringify({planSha256:approval.planSha256,
    reviewOnly:true,ownershipAccepted:false,importEligible:false})]);
}
export function reviewBatchGate({pool,plan,approval,owner}){
  return boundedYoutubeGate({pool,id:plan.id,owner,scope:approval,parentId:plan.parentId,
    beforeAdmission:async(c,op)=>{
      await reviewBatchGlobalReadiness(c,plan,plan.id);
      const rows=(await c.query(`SELECT operation_key,kind,status FROM youtube_bounded_test_admissions
        WHERE run_id=$1 AND profile_id=$2 ORDER BY created_at,operation_key`,[plan.id,op.profileId])).rows;
      assert.ok(rows.length<5,'Artist request allowance reached');
      assert.ok(rows.every(r=>r.status==='returned'));
      assert.ok(!rows.some(r=>r.operation_key===op.key));
      if(op.kind==='search')assert.equal(rows.length,0);
      else{
        assert.equal(rows.filter(r=>r.kind==='search').length,1);
        assert.ok(rows.filter(r=>r.kind===op.kind).length<2);
      }
    }});
}
