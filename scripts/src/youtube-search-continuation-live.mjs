// Live read-only readiness plus a transactionally fenced, exact-search gate.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertBoundedYoutubeAdmission,boundedYoutubeGate} from './youtube-bounded-test-gate.mjs';
export const SEARCH_PARENT='full-tiers-1-5-no-youtube-uncapped';
export async function readSearchSourceLedger(c,plan){
  const ids=plan.children.flatMap(ch=>ch.plan.children.map(l=>l.id));
  const runs=(await c.query(`SELECT id,owner,scope_sha256,cap_cents,reserved_cents,status
    FROM youtube_discovery_test_runs WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows;
  const admissions=(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,
    reserved_cents,status,receipt_sha256,http_status FROM youtube_bounded_test_admissions
    WHERE run_id=ANY($1::text[]) ORDER BY run_id,operation_key`,[ids])).rows;
  const results=(await c.query(`SELECT run_id,profile_id,cm_artist,artist,tier,status,metadata_json,candidates_json
    FROM youtube_discovery_test_results WHERE run_id=ANY($1::text[]) ORDER BY run_id,profile_id`,[ids])).rows;
  return {runs,admissions,results};
}
export async function assertSearchContinuationReady(c,source,group,{ownRunId=''}={}){
  const live=await readSearchSourceLedger(c,source.plan);
  for(const key of ['runs','admissions','results'])
    assert.deepEqual(live[key],source[key],'Original source ledger changed: '+key);
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[SEARCH_PARENT])).rows[0]?.status,'stopped');
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_discovery_test_runs
    WHERE status='running' AND id<>$1`,[ownRunId])).rows[0].n,0,'Other active search work');
  for(const table of ['youtube_video_stage_runs','youtube_video_identity_runs','youtube_link_campaigns'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions',
    'youtube_video_stage_admissions','youtube_video_identity_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0,
      'Uncertain request blocks continuation');
  const ids=group.artists.map(a=>a.profile_id),cms=group.artists.map(a=>a.cm_artist);
  const historical=(await c.query(`SELECT run_id,profile_id,cm_artist,artist,tier,status,metadata_json,candidates_json
    FROM youtube_discovery_test_results WHERE (profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[]))
    AND run_id<>$3 ORDER BY run_id,profile_id`,[ids,cms,ownRunId])).rows;
  const allowed=source.results.filter(r=>ids.includes(r.profile_id)||cms.includes(r.cm_artist));
  assert.ok(allowed.every(r=>r.status==='search_prepared'&&group.operations.some(o=>
    r.run_id===group.sourceRunId&&o.profileId===r.profile_id&&o.cmArtist===r.cm_artist)));
  assert.deepEqual(historical,allowed,'Only exact, unspent source placeholders may remain');
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
      WHERE profile_id=ANY($1::text[]) AND ${table==='youtube_bounded_test_admissions'?'run_id<>$2':'$2::text IS NOT NULL'}`,
    [ids,ownRunId])).rows[0].n,0,'Previous paid search or campaign attempt');
  for(const table of ['youtube_video_stage_admissions','youtube_video_identity_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table}
      WHERE profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[])`,[ids,cms])).rows[0].n,0);
  assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions d
    INNER JOIN youtube_link_campaign_artists a ON a.campaign_id=d.campaign_id AND a.profile_id=d.profile_id
    WHERE a.cm_artist=ANY($1::text[])`,[cms])).rows[0].n,0);
}
export function continuationGroupScope(plan,group,approval){
  assert.equal(approval.explicitApproval,true);assert.equal(approval.planSha256,digest(plan));
  assert.equal(approval.capCents,plan.maximumSpendCents);
  assert.ok(plan.groups.some(g=>digest(g)===digest(group)));
  return {artists:group.artists,scopeSha256:group.scopeSha256,
    operationalCapCents:group.maximumSpendCents,userCapCents:group.maximumSpendCents,
    proposedCapCents:group.maximumSpendCents,maxCalls:group.operations.length,
    explicitApproval:true,approvalStatus:'approved'};
}
export function searchContinuationGate({pool,plan,source,group,approval,owner,assertFrozen}){
  const scope=continuationGroupScope(plan,group,approval);
  const base=boundedYoutubeGate({pool,id:group.id,owner,scope,parentId:SEARCH_PARENT});
  return {
    async admit(op){
      const exact=group.operations.find(o=>o.key===op.key);
      assert.ok(exact&&exact.kind==='search'&&op.kind==='search'&&exact.profileId===op.profileId
        &&exact.inputSha256===op.inputSha256,'Only the exact unspent search is approved');
      await assertFrozen();
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
          [SEARCH_PARENT])).rows[0]?.status,'stopped');
        const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[group.id])).rows[0];
        await assertSearchContinuationReady(c,source,group,{ownRunId:group.id});
        assertBoundedYoutubeAdmission(run,scope,op,0,owner);
        const total=(await c.query(`SELECT COALESCE(sum(reserved_cents),0)::int n FROM youtube_discovery_test_runs
          WHERE id=ANY($1::text[])`,[plan.groups.map(g=>g.id)])).rows[0].n;
        assert.ok(total+2<=plan.maximumSpendCents);
        assert.ok(source.runs.reduce((n,r)=>n+r.reserved_cents,0)+total+2<=plan.combinedMaximumCents);
        await c.query(`INSERT INTO youtube_bounded_test_admissions
          (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,'search',$4,2)`,
        [group.id,op.key,op.profileId,op.inputSha256]);
        const updated=await c.query(`UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND owner=$2 AND status='running' AND reserved_cents+2<=cap_cents`,[group.id,owner]);
        assert.equal(updated.rowCount,1);await c.query('COMMIT');
      }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    },
    returned:base.returned,
  };
}
