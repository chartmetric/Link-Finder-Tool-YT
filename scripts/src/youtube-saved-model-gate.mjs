import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {MIXED_PARENT,mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
const transaction=async(pool,fn)=>{
  const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}
  catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
};
export async function savedModelReadiness(c,plan,source,{ownRun,group,approval}={}){
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[MIXED_PARENT])).rows[0]?.status,'stopped');
  for(const table of ['youtube_link_campaigns','youtube_discovery_test_runs','youtube_video_stage_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running' AND id<>$1",
    [ownRun?group.id:''])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions',
    'youtube_video_stage_admissions','youtube_video_identity_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0,
      'Uncertain prior paid request blocks spending');
  assert.deepEqual(await sourceChannelSnapshot(c,{groups:source.sourceLedgerSnapshot.runs.map(r=>({id:r.id}))}),
    source.sourceLedgerSnapshot,'Saved channel allocations changed');
  const snapshot=await sourceChannelSnapshot(c,plan);
  let spent=0;
  for(const r of snapshot.runs){
    const g=plan.groups.find(g=>g.id===r.id);assert.ok(g);
    assert.ok(group&&g.groupIndex<=group.groupIndex);
    assert.equal(r.plan_sha256,digest(g));
    if(approval)assert.equal(r.approval_sha256,digest(approval));
    assert.equal(r.execution_sha256,digest(plan.runtimeFiles));
    assert.equal(r.cap_cents,g.maximumSpendCents);
    const rows=snapshot.admissions.filter(a=>a.run_id===g.id);
    assert.equal(r.reserved_cents,rows.length*2);spent+=r.reserved_cents;
    if(g.id===group.id)assert.ok(ownRun&&r.status==='running');
    else{assert.equal(r.status,'completed');assert.equal(rows.length,g.operations.length);}
    for(const row of rows){
      const op=g.operations.find(o=>o.key===row.operation_key);assert.ok(op);
      for(const [k,v] of Object.entries({profile_id:op.profileId,cm_artist:op.cmArtist,channel_id:op.channelId,
        kind:'model',input_sha256:op.inputSha256,reserved_cents:2,status:'returned',http_status:200}))assert.equal(row[k],v);
      assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);assert.match(row.raw_sha256,/^[a-f0-9]{64}$/);
    }
  }
  if(group)for(const g of plan.groups.slice(0,group.groupIndex))
    assert.ok(snapshot.runs.some(r=>r.id===g.id&&r.status==='completed'));
  assert.ok(spent<=plan.maximumSpendCents);
  return snapshot;
}
export async function rejectSavedModelReplay(c,operations,ownRun=''){
  for(const op of operations){
    assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE kind='model' AND run_id<>$1 AND (profile_id=$2 OR cm_artist=$3 OR channel_id=$4)`,
    [ownRun,op.profileId,op.cmArtist,op.channelId])).rows[0].n,0,'Previously allocated model identity');
    for(const table of ['youtube_link_campaign_admissions','youtube_bounded_test_admissions'])
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE kind='model' AND profile_id=$1`,
      [op.profileId])).rows[0].n,0,'Prior historical model allocation');
  }
}
export function savedModelClaims(op){
  const capture=op.request.body.state.candidate.channelCapture;
  return capture.aliases.map(alias=>({alias,channelId:op.channelId,profileId:op.profileId,cmArtist:op.cmArtist}));
}
export function savedModelGate({pool,plan,source,approval,owner,checkCatalog,rejectReplay=rejectSavedModelReplay}){
  const boundary=async c=>{
    assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
      [MIXED_PARENT])).rows[0]?.status,'stopped');
  };
  const locked=async(c,g)=>{
    await boundary(c);
    const r=(await c.query('SELECT * FROM youtube_video_identity_runs WHERE id=$1 FOR UPDATE',[g.id])).rows[0];
    assert.ok(r&&r.owner===owner&&r.status==='running');
    assert.equal(r.plan_sha256,digest(g));assert.equal(r.approval_sha256,digest(approval));
    assert.equal(r.execution_sha256,digest(plan.runtimeFiles));assert.equal(r.cap_cents,g.maximumSpendCents);
    return r;
  };
  const claims=async(c,ops)=>{
    for(const op of ops){await checkCatalog(op);await mixedHistoricalClaims(c,savedModelClaims(op));}
  };
  return {
    async start(g){await transaction(pool,async c=>{
      await boundary(c);await savedModelReadiness(c,plan,source,{group:g,approval});
      await rejectReplay(c,g.operations);await claims(c,g.operations);
      await c.query(`INSERT INTO youtube_video_identity_runs
        (id,owner,plan_sha256,approval_sha256,execution_sha256,cap_cents,status)
        VALUES($1,$2,$3,$4,$5,$6,'running')`,
      [g.id,owner,digest(g),digest(approval),digest(plan.runtimeFiles),g.maximumSpendCents]);
    });},
    async admit(g,op){
      assert.deepEqual(g.operations.find(o=>o.key===op.key),op);
      await transaction(pool,async c=>{
        const r=await locked(c,g),snapshot=await savedModelReadiness(c,plan,source,{ownRun:true,group:g,approval});
        const rows=snapshot.admissions.filter(a=>a.run_id===g.id);
        assert.equal(rows.length,g.operations.findIndex(o=>o.key===op.key));
        await rejectReplay(c,[op]);
        await claims(c,[op]);assert.ok(r.reserved_cents+2<=g.maximumSpendCents);
        await c.query(`INSERT INTO youtube_video_identity_admissions
          (run_id,operation_key,profile_id,cm_artist,channel_id,kind,input_sha256,reserved_cents)
          VALUES($1,$2,$3,$4,$5,'model',$6,2)`,
        [g.id,op.key,op.profileId,op.cmArtist,op.channelId,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_video_identity_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2<=cap_cents`,[g.id])).rowCount,1);
      });
    },
    async returned(g,op,receipt,raw){
      await transaction(pool,async c=>{
        await locked(c,g);await claims(c,[op]);
        assert.equal((await c.query(`UPDATE youtube_video_identity_admissions SET status='returned',
          receipt_sha256=$3,raw_sha256=$4,http_status=200 WHERE run_id=$1 AND operation_key=$2
          AND profile_id=$5 AND cm_artist=$6 AND channel_id=$7 AND kind='model' AND input_sha256=$8 AND status='admitted'`,
        [g.id,op.key,digest(receipt),digest(raw),op.profileId,op.cmArtist,op.channelId,op.inputSha256])).rowCount,1);
      });
    },
    async finish(g,status){assert.ok(['completed','stopped'].includes(status));
      await transaction(pool,async c=>{
        await locked(c,g);
        if(status==='completed'){
          const snapshot=await savedModelReadiness(c,plan,source,{ownRun:true,group:g,approval});
          assert.equal(snapshot.admissions.filter(a=>a.run_id===g.id).length,g.operations.length);
        }
        assert.equal((await c.query('UPDATE youtube_video_identity_runs SET status=$2 WHERE id=$1 AND owner=$3',
          [g.id,status,owner])).rowCount,1);
      });
    },
  };
}
