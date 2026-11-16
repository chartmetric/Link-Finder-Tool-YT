// A new exact approval, not a restart of a historical worker.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {digest} from './youtube-video-discovery-offline.mjs';
import {searchContinuationPlan,approveSearchContinuation,searchRecordFromReceipt} from './youtube-search-continuation.mjs';
import {assertSearchContinuationReady,searchContinuationGate,SEARCH_PARENT} from './youtube-search-continuation-live.mjs';
import {identityEligibilitySql,assertCurrentIdentityEligibility} from './youtube-video-identity-catalog.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {campaignTransport} from './youtube-campaign-core.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
export const read=async file=>JSON.parse(await fs.readFile(file));
async function hashedFile(file,sha){
  assert.equal(await fs.realpath(file),path.resolve(file),'Symlink inputs are not allowed');
  assert.equal(digest(await fs.readFile(file)),sha,'Frozen file changed: '+file);
}
export async function assertSearchContinuationFrozen(root,plan,{fullSource=true}={}){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [name,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    await hashedFile(root+'/'+name,sha);
  if(fullSource){
    const manifest=await read(root+'/evidence/source-files.json');
    for(const [name,sha] of Object.entries(manifest)){
      assert.match(name,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);
      assert.ok(!name.split('/').includes('..'));await hashedFile(name,sha);
    }
  }
}
export async function checkContinuationEligibility(artists,{query=select,now=Date.now()}={}){
  const selections=artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,tier:a.tier}));
  const rows=await catalogReadWithOneTimeoutRetry(query,identityEligibilitySql(selections));
  assertCurrentIdentityEligibility(selections,rows,now);
  return rows;
}
export async function runSearchContinuationGroup({root,plan,source,approval,group,pool,assertFrozen,
  eligibilityCheck=checkContinuationEligibility,transportFactory=campaignTransport}){
  const folder='generated-artifacts/'+group.id,owner=randomUUID();
  await fs.mkdir(folder);
  for(const dir of ['receipts','inputs','artists'])await fs.mkdir(folder+'/'+dir);
  await durableStageFile(folder+'/plan.json',JSON.stringify({
    ...group,version:plan.version,parentContinuationId:plan.id,parentPlanSha256:digest(plan),
    sourcePlanId:plan.sourcePlanId,explicitApproval:false,allowedKinds:['search'],
  }));
  await durableStageFile(folder+'/approval.json',JSON.stringify({
    ...approval,groupId:group.id,groupScopeSha256:group.scopeSha256,
    groupCapCents:group.maximumSpendCents,
  }));
  await eligibilityCheck(group.artists);await assertFrozen(true);
  let started=false,status='stopped',completed=0;
  try{
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',
        [SEARCH_PARENT])).rows[0]?.status,'stopped');
      await assertSearchContinuationReady(c,source,group);
      await c.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
        VALUES($1,$2,$3,$4,'running')`,[group.id,owner,group.scopeSha256,group.maximumSpendCents]);
      for(const a of group.artists)await c.query(`INSERT INTO youtube_discovery_test_results
        (run_id,profile_id,cm_artist,artist,tier,status,metadata_json)
        VALUES($1,$2,$3,$4,$5,'search_prepared',$6::jsonb)`,
      [group.id,a.profile_id,a.cm_artist,a.artist,a.tier,JSON.stringify({
        approvalSha256:digest(approval),searchOnly:true,sourceRunId:group.sourceRunId})]);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    const gate=searchContinuationGate({pool,plan,source,group,approval,owner,
      assertFrozen:()=>assertFrozen(false)});
    const transport=transportFactory({root:folder,assertFrozen:()=>assertFrozen(false),
      credentials:{serper:process.env.SERPERDEV_API_KEY},admit:gate.admit,returned:gate.returned});
    for(const operation of group.operations){
      await durableStageFile(folder+'/inputs/'+digest(operation.key)+'.json',JSON.stringify(operation));
      const receipt=await transport(operation.profileId,'search',operation.key,operation.request);
      const receiptPath=folder+'/receipts/'+archivedSearchReceiptName(operation.profileId);
      const record=searchRecordFromReceipt({
        artist:group.artists.find(a=>a.profile_id===operation.profileId),
        packet:group.packets.find(p=>p.profileId===operation.profileId),operation,receipt,receiptPath,
        receiptBytes:await fs.readFile(receiptPath)});
      await durableStageFile(folder+'/artists/'+operation.profileId+'.json',JSON.stringify(record));
      const updated=await pool.query(`UPDATE youtube_discovery_test_results SET status='search_returned',
        candidates_json=$3::jsonb,metadata_json=$4::jsonb
        WHERE run_id=$1 AND profile_id=$2 AND status='search_prepared'`,
      [group.id,operation.profileId,JSON.stringify(record.candidates),JSON.stringify({
        ownershipAccepted:false,videoLeads:record.videoPlan.resolutionQueue.length,
        approvalSha256:digest(approval),sourceRunId:group.sourceRunId})]);
      assert.equal(updated.rowCount,1);completed++;
      console.log(JSON.stringify({phase:'continued_searches',group:group.id,completed,
        total:group.operations.length,profileId:operation.profileId}));
    }
    status='completed';
  }finally{
    if(started){
      const rows=(await pool.query(`SELECT status,http_status FROM youtube_bounded_test_admissions
        WHERE run_id=$1`,[group.id])).rows;
      if(status==='completed')assert.ok(rows.length===group.operations.length&&
        rows.every(r=>r.status==='returned'&&r.http_status===200));
      const updated=await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3
        WHERE id=$1 AND owner=$2 AND status='running'`,[group.id,owner,status]);
      assert.equal(updated.rowCount,1);
      await durableStageFile(folder+'/summary.json',JSON.stringify({id:group.id,status,completed,
        reservedCents:rows.length*2,maximumSpendCents:group.maximumSpendCents,noRetries:true,catalogWrites:0}));
    }
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2),value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--authorize-prepared','--run-approved'].includes(a));assert.equal(modes.length,1);
  const id=value('id');assert.match(id??'',/^youtube-search-continuation-[a-z0-9-]{4,65}$/);
  const root='generated-artifacts/'+id,plan=await read(root+'/plan.json');
  const source=await read(root+'/evidence/source.json');
  assert.equal(id,plan.id);assert.deepEqual(searchContinuationPlan(plan,source),plan);
  await assertSearchContinuationFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveSearchContinuation(plan,source,{planSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('plan-sha256'),undefined);assert.equal(value('approve-cents'),undefined);
  assert.ok(process.env.SERPERDEV_API_KEY,'Search provider credential required');
  const approval=await read(root+'/approval.json');
  assert.deepEqual(approveSearchContinuation(plan,source,approval),approval);
  await durableStageFile(root+'/run-started.json',JSON.stringify({at:new Date().toISOString(),planSha256:digest(plan)}));
  const assertFrozen=async fullSource=>{
    await assertSearchContinuationFrozen(root,plan,{fullSource});
    assert.deepEqual(await read(root+'/approval.json'),approval);
  };
  const pool=await connectSavedBatchPool();
  try{
    for(const group of plan.groups)await runSearchContinuationGroup({root,plan,source,approval,group,pool,assertFrozen});
    await durableStageFile(root+'/summary.json',JSON.stringify({id,status:'completed',
      searches:plan.maximumCalls,maximumSpendCents:plan.maximumSpendCents,
      priorReservedCents:plan.priorReservedCents,combinedMaximumCents:plan.combinedMaximumCents,
      paidReplays:0,modelCalls:0,channelCalls:0,catalogWrites:0}));
  }finally{await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
