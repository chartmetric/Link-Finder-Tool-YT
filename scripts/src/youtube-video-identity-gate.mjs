// PostgreSQL admission is mandatory; there is no local-lock fallback.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {sourceFile,identityJson} from './youtube-video-identity-source.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {assertIdentityExecutionApproval,identityClaims,assertNoNewIdentityClaims,
  identityCapturePlan,IDENTITY_PARENT} from './youtube-video-identity-execution.mjs';

export const videoIdentitySchema=`
CREATE TABLE IF NOT EXISTS youtube_video_identity_runs(
 id text PRIMARY KEY,owner text NOT NULL,plan_sha256 text NOT NULL,approval_sha256 text NOT NULL,
 execution_sha256 text NOT NULL,cap_cents int NOT NULL CHECK(cap_cents>=0 AND cap_cents<=40),
 reserved_cents int NOT NULL DEFAULT 0 CHECK(reserved_cents>=0 AND reserved_cents<=cap_cents),
 status text NOT NULL CHECK(status IN ('running','stopped','completed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS youtube_video_identity_admissions(
 run_id text NOT NULL REFERENCES youtube_video_identity_runs(id),operation_key text NOT NULL,
 profile_id text NOT NULL,cm_artist text NOT NULL,channel_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('metadata','model')),input_sha256 text NOT NULL,
 reserved_cents int NOT NULL CHECK(reserved_cents=2),
 status text NOT NULL DEFAULT 'admitted' CHECK(status IN ('admitted','returned')),
 receipt_sha256 text,raw_sha256 text,http_status int,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,operation_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS youtube_video_identity_profile_kind_once
 ON youtube_video_identity_admissions(profile_id,kind);
CREATE UNIQUE INDEX IF NOT EXISTS youtube_video_identity_artist_kind_once
 ON youtube_video_identity_admissions(cm_artist,kind);
CREATE UNIQUE INDEX IF NOT EXISTS youtube_video_identity_channel_kind_once
 ON youtube_video_identity_admissions(channel_id,kind);
CREATE TABLE IF NOT EXISTS youtube_video_identity_claims(
 alias text NOT NULL,channel_id text NOT NULL,profile_id text NOT NULL,cm_artist text NOT NULL,
 PRIMARY KEY(alias,channel_id,profile_id,cm_artist)
);`;
async function transaction(pool,fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}
  catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
export function videoIdentityGate({pool,plan,approval,manifest,executionApproval,owner,checkCatalog}){
  assertIdentityExecutionApproval(plan,approval,manifest,executionApproval);
  assert.ok(typeof checkCatalog==='function','Live read-only catalog checks required');
  const expected=identityClaims(plan);
  // A plan with repeated channels cannot satisfy globally non-replayable
  // allocations. Reject it before any calls rather than partly paying it.
  for(const field of ['profileId','cmArtist','channelId'])
    assert.equal(new Set(plan.operations.map(op=>op.kind+':'+op[field])).size,plan.operations.length,
      'Repeated '+field+' allocation requires a new plan; no slot substitution');
  async function sourceAcknowledgments(c){
    const capture=identityCapturePlan(plan),source=capture.source;
    const p=identityJson(sourceFile(source,'plan.json'));
    const a=identityJson(sourceFile(source,'approval.json'));
    const run=(await c.query('SELECT * FROM youtube_video_stage_runs WHERE id=$1',[p.id])).rows[0];
    assert.ok(run&&run.status==='completed'&&run.plan_sha256===digest(p)&&run.approval_sha256===digest(a),
      'Uploader source is not transactionally completed');
    const rows=(await c.query('SELECT * FROM youtube_video_stage_admissions WHERE run_id=$1',[p.id])).rows;
    assert.equal(rows.length,p.operations.length);
    for(const op of p.operations){
      const receipt=identityJson(sourceFile(source,'receipts/'+digest(op.key)+'.json'));
      assert.ok(rows.some(r=>r.operation_key===op.key&&r.profile_id===op.profileId&&r.cm_artist===op.cmArtist
        &&r.video_id===op.videoId&&r.input_sha256===op.inputSha256&&r.status==='returned'
        &&r.http_status===200&&r.receipt_sha256===digest(receipt)&&r.raw_sha256===receipt.rawBodySha256),
      'Uploader receipt is not acknowledged in the coordinator');
    }
    if(plan.stage==='identity_models'){
      const saved=plan.captureReturns;
      const r=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1',[capture.id])).rows[0];
      assert.ok(r&&r.status==='completed'&&r.plan_sha256===digest(capture)
        &&r.approval_sha256===digest(saved.approval),'Capture source is not transactionally completed');
      const admissions=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1',[capture.id])).rows;
      assert.equal(admissions.length,capture.operations.length);
      for(const savedReceipt of saved.receipts){
        const bytes=Buffer.from(savedReceipt.receiptBytesBase64,'base64'),receipt=identityJson(bytes);
        assert.ok(admissions.some(a=>a.operation_key===receipt.operationKey&&a.profile_id===receipt.profileId
          &&a.cm_artist===receipt.cmArtist&&a.channel_id===receipt.channelId&&a.kind===receipt.kind
          &&a.input_sha256===receipt.inputSha256&&a.status==='returned'&&a.http_status===200
          &&a.receipt_sha256===digest(bytes)&&a.raw_sha256===receipt.rawBodySha256),
        'Capture receipt is not acknowledged in the coordinator');
      }
    }
  }
  async function boundary(c){
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [IDENTITY_PARENT])).rows[0]?.status,'stopped','Parent campaign must remain stopped');
    for(const table of ['youtube_link_campaigns','youtube_discovery_test_runs','youtube_video_stage_runs'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0,
        'Another YouTube runner is active');
    for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions',
      'youtube_video_stage_admissions','youtube_video_identity_admissions'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0,
        'Uncertain prior admission blocks all spending');
  }
  async function lock(c){
    // Same parent row serializes starts, admissions, receipts and parent resume.
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [IDENTITY_PARENT])).rows[0]?.status,'stopped','Parent campaign must remain stopped');
    const r=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
    assert.ok(r&&r.owner===owner&&r.status==='running'&&r.plan_sha256===digest(plan)
      &&r.approval_sha256===digest(approval)&&r.execution_sha256===digest(executionApproval),
    'Lost identity owner, plan or execution approval fence');
    assert.equal(r.cap_cents,plan.maximumSpendCents);
    return r;
  }
  async function claims(c,extra=[]){
    const all=[...expected,...extra];
    assertNoNewIdentityClaims(all,(await c.query('SELECT * FROM youtube_video_identity_claims')).rows.map(r=>({
      alias:r.alias,channelId:r.channel_id,profileId:r.profile_id,cmArtist:r.cm_artist})));
    const historical=(await c.query(`SELECT ch.channel_id,ch.profile_id,a.cm_artist
      FROM youtube_link_campaign_channels ch
      LEFT JOIN youtube_link_campaign_artists a ON a.campaign_id=ch.campaign_id AND a.profile_id=ch.profile_id
      WHERE ch.channel_id=ANY($1::text[])`,[[...new Set(all.map(x=>x.channelId))]])).rows;
    assertNoNewIdentityClaims(all,historical.map(r=>({...r,alias:'',channelId:r.channel_id,
      profileId:r.profile_id,cmArtist:r.cm_artist})));
    // Saved bounded-test candidates also contain historical claims, even when
    // they never became catalog links or campaign channel rows.
    const saved=(await c.query(`SELECT profile_id,cm_artist,candidates_json
      FROM youtube_discovery_test_results`)).rows;
    for(const row of saved){
      const found=[];
      function visit(value){
        if(typeof value==='string'){
          const alias=returnedYoutubeUrl(value);
          if(alias)found.push({alias,channelId:alias.match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
            profileId:row.profile_id,cmArtist:row.cm_artist});
        }else if(Array.isArray(value))value.forEach(visit);
        else if(value&&typeof value==='object'){
          if(/^UC[A-Za-z0-9_-]{22}$/.test(value.channelId??''))found.push({
            alias:'',channelId:value.channelId,profileId:row.profile_id,cmArtist:row.cm_artist});
          Object.values(value).forEach(visit);
        }
      }
      visit(row.candidates_json);assertNoNewIdentityClaims(all,found);
    }
    await checkCatalog(all);
  }
  async function saveClaims(c,values){
    for(const v of values)await c.query(`INSERT INTO youtube_video_identity_claims
      (alias,channel_id,profile_id,cm_artist) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [v.alias,v.channelId,v.profileId,v.cmArtist]);
  }
  return {
    async start(){
      await pool.query(videoIdentitySchema);
      await transaction(pool,async c=>{
        await boundary(c);
        assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'")).rows[0].n,0);
        await sourceAcknowledgments(c);await claims(c);
        await c.query(`INSERT INTO youtube_video_identity_runs
          (id,owner,plan_sha256,approval_sha256,execution_sha256,cap_cents,status)
          VALUES($1,$2,$3,$4,$5,$6,'running')`,
        [plan.id,owner,digest(plan),digest(approval),digest(executionApproval),plan.maximumSpendCents]);
        await saveClaims(c,expected);
      });
    },
    async admit(op){
      assert.ok(op&&typeof op.key==='string','Operation required');
      assert.deepEqual(plan.operations.find(o=>o.key===op.key),op,'Unapproved operation');
      await transaction(pool,async c=>{
        const run=await lock(c);await boundary(c);await sourceAcknowledgments(c);await claims(c);
        const rows=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1 ORDER BY created_at,operation_key',[plan.id])).rows;
        assert.equal(rows.length,plan.operations.findIndex(o=>o.key===op.key),'Exact frozen operation order required');
        assert.ok(rows.every(r=>r.status==='returned'));
        assert.equal(run.reserved_cents,rows.length*2);
        assert.ok(run.reserved_cents+2<=run.cap_cents,'Reservation exceeds exact cap');
        assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
          WHERE kind=$1 AND (profile_id=$2 OR cm_artist=$3 OR channel_id=$4)`,
        [op.kind,op.profileId,op.cmArtist,op.channelId])).rows[0].n,0,
        'Globally non-replayable profile, Chartmetric artist or channel for this operation kind');
        // Historical exact requests, including failed/uncertain ones, never
        // become free slots merely because a different run ID was chosen.
        for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions',
          'youtube_video_identity_admissions']){
          const prior=(await c.query(`SELECT count(*)::int n FROM ${table}
            WHERE profile_id=$1 AND kind=$2 AND input_sha256=$3`,
          [op.profileId,op.kind,op.inputSha256])).rows[0].n;
          assert.equal(prior,0,'Globally non-replayable identity request');
        }
        await c.query(`INSERT INTO youtube_video_identity_admissions
          (run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,$5,$6,$7,2)`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.channelId,op.kind,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_video_identity_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2<=cap_cents`,[plan.id])).rowCount,1);
      });
    },
    async returned(op,receiptSha,rawSha,aliases=[]){
      assert.deepEqual(plan.operations.find(o=>o.key===op.key),op);
      assert.match(receiptSha,/^[a-f0-9]{64}$/);assert.match(rawSha,/^[a-f0-9]{64}$/);
      await transaction(pool,async c=>{
        await lock(c);await claims(c,aliases);
        // A newly observed handle shared within this cohort also stops the gate.
        for(const a of aliases){
          const prior=expected.filter(e=>e.alias.toLowerCase()===a.alias.toLowerCase());
          if(!prior.some(e=>e.profileId===a.profileId&&e.cmArtist===a.cmArtist))
            assertNoNewIdentityClaims([a],prior);
        }
        const r=await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
          receipt_sha256=$8,raw_sha256=$9,http_status=200
          WHERE run_id=$1 AND operation_key=$2 AND profile_id=$3 AND cm_artist=$4 AND channel_id=$5
          AND kind=$6 AND input_sha256=$7 AND status='admitted'`,
        [plan.id,op.key,op.profileId,op.cmArtist,op.channelId,op.kind,op.inputSha256,receiptSha,rawSha]);
        assert.equal(r.rowCount,1,'Lost exact receipt acknowledgment fence');
        await saveClaims(c,aliases);
      });
    },
    async finish(status){
      assert.ok(['completed','stopped'].includes(status));
      await transaction(pool,async c=>{
        if(status==='completed')assert.equal((await c.query(
          'SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[IDENTITY_PARENT])).rows[0]?.status,'stopped');
        // Stopping remains possible if the parent state changed.
        const r=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',[plan.id])).rows[0];
        assert.ok(r&&r.owner===owner&&r.status==='running'&&r.plan_sha256===digest(plan)
          &&r.approval_sha256===digest(approval)&&r.execution_sha256===digest(executionApproval),'Lost completion owner fence');
        if(status==='completed'){
          await lock(c);await boundary(c);await claims(c);
          const rows=(await c.query('SELECT * FROM youtube_video_identity_admissions WHERE run_id=$1',[plan.id])).rows;
          assert.equal(rows.length,plan.maximumCalls);assert.equal(r.reserved_cents,plan.maximumSpendCents);
          assert.ok(plan.operations.every(op=>rows.some(a=>a.operation_key===op.key&&a.status==='returned'
            &&a.input_sha256===op.inputSha256&&a.http_status===200&&a.receipt_sha256&&a.raw_sha256)));
        }
        await c.query('UPDATE youtube_video_identity_runs SET status=$2 WHERE id=$1',[plan.id,status]);
      });
    },
  };
}
