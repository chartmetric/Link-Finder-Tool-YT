// Use the existing bounded YouTube ledger for separately approved experiments.
// Do not remove the identity ledger's global once-per-artist safeguards.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {sourceChannelSnapshot} from './youtube-channel-fast-live.mjs';
import {MIXED_PARENT,mixedHistoricalClaims} from './youtube-mixed-capture-readiness.mjs';
import {savedModelClaims} from './youtube-saved-model-gate.mjs';
import {rejectComparisonReplay} from './youtube-ownership-comparison.mjs';

export async function boundedComparisonSchema(c){
  const tables=['youtube_discovery_test_runs','youtube_bounded_test_admissions'];
  const columns=(await c.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position`,[tables])).rows;
  const constraints=(await c.query(`SELECT conrelid::regclass::text table_name,conname,
    pg_get_constraintdef(oid) definition FROM pg_constraint
    WHERE conrelid=ANY($1::regclass[]) ORDER BY conrelid::regclass::text,conname`,[tables])).rows;
  const indexes=(await c.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`,[tables])).rows;
  for(const table of tables)assert.ok(columns.some(x=>x.table_name===table),'Existing coordinator missing');
  assert.ok(indexes.some(x=>x.tablename==='youtube_bounded_test_admissions'&&
    /UNIQUE INDEX/.test(x.indexdef)&&/\(run_id, operation_key\)/.test(x.indexdef)));
  assert.ok(!indexes.some(x=>x.tablename==='youtube_bounded_test_admissions'&&/UNIQUE INDEX/.test(x.indexdef)&&
    !/\(run_id, operation_key\)/.test(x.indexdef)),'Unexpected global experiment exclusion');
  return {columns,constraints,indexes};
}
export async function zeroSpendComparisonLaunch(c,proof){
  const rows=(await c.query('SELECT id,status,reserved_cents,scope_sha256 FROM youtube_discovery_test_runs WHERE id=$1',
    [proof.id])).rows;
  // The failed original launch used the identity coordinator, not bounded runs.
  assert.equal(rows.length,0,'Failed launch must not have bounded allocations');
  const old=(await c.query('SELECT id,status,reserved_cents,plan_sha256 FROM youtube_video_identity_runs WHERE id=$1',
    [proof.id])).rows;
  assert.equal(old.length,1);assert.equal(old[0].status,'stopped');
  assert.equal(old[0].plan_sha256,proof.scopeSha256);assert.equal(old[0].reserved_cents,0);
  assert.equal((await c.query('SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE run_id=$1',
    [proof.id])).rows[0].n,0);
}
export async function comparisonReadiness(c,plan,{group,approval,own=false,returningOp=null}={}){
  assert.equal(digest(await boundedComparisonSchema(c)),plan.coordinatorSchemaSha256);
  assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[MIXED_PARENT])).rows[0]?.status,'stopped');
  for(const table of ['youtube_link_campaigns','youtube_video_stage_runs','youtube_video_identity_runs'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='running'`)).rows[0].n,0);
  const ownId=own?group.id:'';
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running' AND id<>$1",
    [ownId])).rows[0].n,0);
  for(const table of ['youtube_link_campaign_admissions','youtube_video_stage_admissions','youtube_video_identity_admissions'])
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${table} WHERE status='admitted'`)).rows[0].n,0);
  assert.equal((await c.query("SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted' AND run_id<>$1",
    [ownId])).rows[0].n,0);
  await zeroSpendComparisonLaunch(c,plan.failedLaunch);
  assert.deepEqual(await sourceChannelSnapshot(c,{groups:plan.baselineLedgerSnapshot.runs.map(r=>({id:r.id}))}),
    plan.baselineLedgerSnapshot,'Historical baseline allocations changed');
  if(!group)return [];
  const run=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1',[group.id])).rows[0];
  const rows=(await c.query(`SELECT run_id,operation_key,profile_id,kind,input_sha256,reserved_cents,
    status,receipt_sha256,http_status FROM youtube_bounded_test_admissions WHERE run_id=$1 ORDER BY operation_key`,
  [group.id])).rows;
  if(!own){assert.equal(run,undefined);assert.equal(rows.length,0);return rows;}
  assert.equal(run.status,'running');assert.equal(run.scope_sha256,digest({group,approval,runtimeFiles:plan.runtimeFiles}));
  assert.equal(run.cap_cents,group.maximumSpendCents);assert.equal(run.reserved_cents,rows.length*2);
  assert.ok(run.reserved_cents<=plan.maximumSpendCents);
  let pending=0;
  for(const row of rows){
    const op=group.operations.find(o=>o.key===row.operation_key);assert.ok(op);
    for(const [key,v] of Object.entries({run_id:group.id,profile_id:op.profileId,kind:'model',
      input_sha256:op.inputSha256,reserved_cents:2}))assert.equal(row[key],v);
    if(row.status==='admitted'){
      assert.equal(op.key,returningOp?.key,'Uncertain comparison blocks further spending');pending++;
    }else{
      assert.equal(row.status,'returned');assert.equal(row.http_status,200);
      assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);
    }
  }
  assert.equal(pending,returningOp?1:0);return rows;
}
export function boundedComparisonGate({pool,plan,approval,owner,checkCatalog}){
  const transaction=async fn=>{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [MIXED_PARENT])).rows[0]?.status,'stopped');
      const value=await fn(c);await c.query('COMMIT');return value;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  };
  const locked=async(c,g)=>{
    const row=(await c.query('SELECT * FROM youtube_discovery_test_runs WHERE id=$1 FOR UPDATE',[g.id])).rows[0];
    assert.ok(row&&row.owner===owner&&row.status==='running');
    assert.equal(row.scope_sha256,digest({group:g,approval,runtimeFiles:plan.runtimeFiles}));
    assert.equal(row.cap_cents,g.maximumSpendCents);return row;
  };
  const claims=async(c,ops)=>{
    for(const op of ops){await checkCatalog(op);await mixedHistoricalClaims(c,savedModelClaims(op));}
  };
  return {
    async start(g){await transaction(async c=>{
      await comparisonReadiness(c,plan,{group:g,approval});
      await rejectComparisonReplay(c,g.operations);await claims(c,g.operations);
      await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
        VALUES($1,$2,$3,$4,'running')`,[g.id,owner,digest({group:g,approval,runtimeFiles:plan.runtimeFiles}),g.maximumSpendCents]);
    });},
    async admit(g,op){assert.deepEqual(g.operations.find(o=>o.key===op.key),op);
      await transaction(async c=>{
        await locked(c,g);const rows=await comparisonReadiness(c,plan,{group:g,approval,own:true});
        assert.equal(rows.length,g.operations.findIndex(o=>o.key===op.key));
        await rejectComparisonReplay(c,[op]);await claims(c,[op]);
        await c.query(`INSERT INTO youtube_bounded_test_admissions
          (run_id,operation_key,profile_id,kind,input_sha256,reserved_cents) VALUES($1,$2,$3,'model',$4,2)`,
        [g.id,op.key,op.profileId,op.inputSha256]);
        assert.equal((await c.query(`UPDATE youtube_discovery_test_runs SET reserved_cents=reserved_cents+2
          WHERE id=$1 AND reserved_cents+2<=cap_cents`,[g.id])).rowCount,1);
      });
    },
    async returned(g,op,receipt,raw){await transaction(async c=>{
      await locked(c,g);await comparisonReadiness(c,plan,{group:g,approval,own:true,returningOp:op});
      await claims(c,[op]);assert.equal(receipt.rawBodySha256,digest(raw));
      for(const [key,v] of Object.entries({runId:g.id,parentId:plan.id,planSha256:digest(g),
        approvalSha256:digest(approval),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
        channelId:op.channelId,kind:'model',inputSha256:op.inputSha256,status:200}))assert.equal(receipt[key],v);
      assert.deepEqual(receipt.request,op.request);
      assert.equal((await c.query(`UPDATE youtube_bounded_test_admissions SET status='returned',
        receipt_sha256=$5,http_status=200 WHERE run_id=$1 AND operation_key=$2 AND profile_id=$3
        AND input_sha256=$4 AND kind='model' AND status='admitted'`,
      [g.id,op.key,op.profileId,op.inputSha256,digest(receipt)])).rowCount,1);
    });},
    async finish(g,status){assert.ok(['stopped','completed'].includes(status));
      await transaction(async c=>{
        await locked(c,g);
        if(status==='completed'){
          const rows=await comparisonReadiness(c,plan,{group:g,approval,own:true});
          assert.equal(rows.length,g.operations.length);
        }
        assert.equal((await c.query('UPDATE youtube_discovery_test_runs SET status=$2 WHERE id=$1 AND owner=$3',
          [g.id,status,owner])).rowCount,1);
      });
    },
  };
}
