// Separate fresh 20-artist search stage. No provider calls during preparation.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {stagedSearchPlan,validateStagedSearchPlan,approveStagedSearch,assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {campaignTransport} from './youtube-campaign-core.mjs';
import {boundedYoutubeGate} from './youtube-bounded-test-gate.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
export function stagedCatalogRoot(catalogId='youtube-test-20-staged-catalog-2026-11-13'){
  assert.match(catalogId,/^youtube-test-[a-z0-9-]{4,100}$/);
  return 'generated-artifacts/'+catalogId;
}
const read=async file=>JSON.parse(await fs.readFile(file));

export async function searchReadiness(client,artists,parentId){
  assert.equal((await client.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[parentId])).rows[0]?.status,'stopped');
  for(const sql of [
    "SELECT count(*)::int n FROM youtube_discovery_test_runs WHERE status='running'",
    "SELECT count(*)::int n FROM youtube_video_stage_runs WHERE status='running'",
    "SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE status='admitted'",
    "SELECT count(*)::int n FROM youtube_bounded_test_admissions WHERE status='admitted'",
    "SELECT count(*)::int n FROM youtube_video_stage_admissions WHERE status='admitted'",
  ])assert.equal((await client.query(sql)).rows[0].n,0,'Other active or uncertain YouTube work blocks this test');
  const ids=artists.map(a=>a.profile_id);
  for(const table of ['youtube_link_campaign_admissions','youtube_discovery_test_results',
    'youtube_bounded_test_admissions','youtube_video_stage_admissions'])
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${table} WHERE profile_id=ANY($1::text[])`,[ids])).rows[0].n,0,
      'A selected artist has previous YouTube attempt history');
  const cms=artists.map(a=>a.cm_artist);
  for(const table of ['youtube_discovery_test_results','youtube_video_stage_admissions'])
    assert.equal((await client.query(`SELECT count(*)::int n FROM ${table}
      WHERE cm_artist=ANY($1::text[])`,[cms])).rows[0].n,0,'Previous Chartmetric artist attempt');
  assert.equal((await client.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions d
    INNER JOIN youtube_link_campaign_artists a ON a.campaign_id=d.campaign_id AND a.profile_id=d.profile_id
    WHERE a.cm_artist=ANY($1::text[])`,[cms])).rows[0].n,0,'Previous campaign artist attempt');
  const tables=(await client.query(`SELECT to_regclass('youtube_video_identity_runs') runs,
    to_regclass('youtube_video_identity_admissions') admissions`)).rows[0];
  if(tables.runs||tables.admissions){
    assert.ok(tables.runs&&tables.admissions,'Partly installed identity coordinator');
    for(const sql of [
      "SELECT count(*)::int n FROM youtube_video_identity_runs WHERE status='running'",
      "SELECT count(*)::int n FROM youtube_video_identity_admissions WHERE status='admitted'",
    ])assert.equal((await client.query(sql)).rows[0].n,0,'Other active or uncertain identity work');
    assert.equal((await client.query(`SELECT count(*)::int n FROM youtube_video_identity_admissions
      WHERE profile_id=ANY($1::text[]) OR cm_artist=ANY($2::text[])`,[ids,cms])).rows[0].n,0,
    'A selected profile or artist has previous identity-stage history');
  }else{
    assert.equal(tables.runs,null);assert.equal(tables.admissions,null);
  }
}
async function assertEligibility(artists){
  const eligible=await currentEligible(artists.map(a=>({profileId:a.profile_id,cmArtist:a.cm_artist,name:a.artist})));
  assert.ok(artists.every(a=>eligible.get(a.profile_id)?.tier===a.tier),'Current tier/catalog eligibility changed');
}
export async function prepareStagedSearch(id,catalogId){
  const catalogRoot=stagedCatalogRoot(catalogId);
  const root='generated-artifacts/'+id,parent=await read(catalogRoot+'/plan.json');
  const packets=await read(catalogRoot+'/supplemental-catalog/packets.json');
  assert.equal(parent.explicitApproval,false);assert.equal(digest(packets),parent.catalogEvidenceSha256);
  await assertEligibility(parent.artists);
  const pool=await connectSavedBatchPool();let client;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await searchReadiness(client,parent.artists,'full-tiers-1-5-no-youtube-uncapped');
    await client.query('COMMIT');
  }catch(error){if(client)await client.query('ROLLBACK');throw error;}
  finally{client?.release();await pool.end();}
  await fs.mkdir(root);
  for(const dir of ['evidence','inputs','receipts','artists','supplemental-catalog'])await fs.mkdir(root+'/'+dir);
  const evidenceFiles={};
  const evidence=async(name,value)=>{
    const bytes=JSON.stringify(value);await durableStageFile(root+'/'+name,bytes);evidenceFiles[name]=digest(bytes);
  };
  await evidence('evidence/catalog-preparation.json',parent);
  await evidence('supplemental-catalog/packets.json',packets);
  const modules=await freezeLocalModules(fileURLToPath(import.meta.url),root+'/runtime'),runtimeFiles={};
  for(const file of modules){
    const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));
  }
  const plan=stagedSearchPlan({id,preparedAt:new Date().toISOString(),artists:parent.artists,packets,
    evidenceFiles,runtimeFiles});
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=plan.artists.map(a=>{
    const op=plan.operations.find(o=>o.profileId===a.profile_id);
    return [a.artist,a.tier,a.profile_id,a.cm_artist,op.request.body.q,2,'Search only — all links require later identity checks'];
  });
  await durableStageFile(root+'/proposed-test.csv','\ufeff'+[
    ['artist','tier','profile_id','cm_artist','exact_search_query','reservation_cents','scope'],
    ...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  return {status:'prepared_not_approved',id,artists:20,searchCalls:20,maximumUsd:.4,
    laterStagesSeparatelyApproved:true,planSha256:digest(plan),paidCalls:0};
}
export async function assertStagedSearchFrozen(root,plan){
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Use sealed runtime');
  validateStagedSearchPlan(plan);assert.equal(digest(await read(root+'/plan.json')),digest(plan));
  for(const [file,sha] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(await fs.readFile(root+'/'+file)),sha);
}
async function run(root,plan,approval){
  assertStagedSearchApproval(plan,approval);await assertEligibility(plan.artists);
  const pool=await connectSavedBatchPool(),owner=randomUUID();let started=false,status='stopped',completed=0;
  const assertFrozen=async()=>{
    await assertStagedSearchFrozen(root,plan);assert.equal(digest(await read(root+'/approval.json')),digest(approval));
  };
  try{
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT id FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[plan.parentId]);
      await searchReadiness(client,plan.artists,plan.parentId);
      await client.query(`INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status)
        VALUES($1,$2,$3,40,'running')`,[plan.id,owner,plan.scopeSha256]);
      for(const a of plan.artists)await client.query(`INSERT INTO youtube_discovery_test_results
        (run_id,profile_id,cm_artist,artist,tier,status,metadata_json)
        VALUES($1,$2,$3,$4,$5,'search_prepared',$6::jsonb)`,
      [plan.id,a.profile_id,a.cm_artist,a.artist,a.tier,JSON.stringify({approvalSha256:digest(approval),searchOnly:true})]);
      await client.query('COMMIT');started=true;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const gate=boundedYoutubeGate({pool,id:plan.id,owner,scope:approval,parentId:plan.parentId});
    const transport=campaignTransport({root,assertFrozen,credentials:{serper:process.env.SERPERDEV_API_KEY},
      admit:async op=>{
        const exact=plan.operations.find(o=>o.key===op.key);
        assert.ok(exact&&exact.kind===op.kind&&exact.profileId===op.profileId&&exact.inputSha256===op.inputSha256);
        await gate.admit(op);
      },returned:gate.returned});
    for(const op of plan.operations){
      const packet=plan.packets.find(p=>p.profileId===op.profileId&&p.cmArtist===op.cmArtist);
      const artist=youtubeArtistFromCatalogPacket(packet),searchPlan=youtubeSearchPlan(artist);
      await durableStageFile(root+'/inputs/'+digest(op.key)+'.json',JSON.stringify(op));
      const receipt=await transport(op.profileId,'search',op.key,op.request);
      assert.equal(receipt.status,200);assert.equal(receipt.parseFailed,false);
      assert.ok(Array.isArray(receipt.data?.organic),'Malformed search response; stop without replay');
      const discovery=rankYoutubeSearchCandidates(youtubeSearchCandidates(receipt.data),searchPlan,
        {limit:2,includeTopicChannels:true});
      const receiptPath=root+'/receipts/'+archivedSearchReceiptName(op.profileId);
      const raw=await fs.readFile(receiptPath);
      const videoPlan=planVideoDiscovery(artist,receipt.data.organic,
        {archivePath:receiptPath,receiptSha256:digest(raw)});
      const record={artist,tier:plan.artists.find(a=>a.profile_id===op.profileId).tier,searchPlan,
        ...discovery,videoPlan,candidates:discovery.candidates,
        candidateStatus:'Discovery only — no channel capture or artist ownership check',
        channelAbsenceProven:false,ownershipAccepted:false};
      await durableStageFile(root+'/artists/'+op.profileId+'.json',JSON.stringify(record));
      const updated=await pool.query(`UPDATE youtube_discovery_test_results SET status='search_returned',
        candidates_json=$3::jsonb,metadata_json=$4::jsonb
        WHERE run_id=$1 AND profile_id=$2 AND status='search_prepared'`,
      [plan.id,op.profileId,JSON.stringify(discovery.candidates),JSON.stringify({ownershipAccepted:false,
        videoLeads:videoPlan.resolutionQueue.length,approvalSha256:digest(approval)})]);
      assert.equal(updated.rowCount,1);completed++;
      console.log(JSON.stringify({phase:'search_only',completed,total:20,profileId:op.profileId,
        directChannelLeads:discovery.candidates.length,videoLeads:videoPlan.resolutionQueue.length}));
    }
    status='completed';
  }finally{
    try{
      if(started){
        const rows=(await pool.query(`SELECT operation_key,status,http_status FROM youtube_bounded_test_admissions
          WHERE run_id=$1`,[plan.id])).rows;
        if(status==='completed')assert.ok(rows.length===20&&rows.every(r=>r.status==='returned'&&r.http_status===200));
        const updated=await pool.query(`UPDATE youtube_discovery_test_runs SET status=$3
          WHERE id=$1 AND owner=$2 AND status='running'`,[plan.id,owner,status]);
        assert.equal(updated.rowCount,1);
        await durableStageFile(root+'/summary.json',JSON.stringify({id:plan.id,status,artistsSearched:completed,
          searchOnly:true,reservedCents:rows.length*2,maximumReservationCents:40,acceptedLinks:0,
          uploaderCalls:0,channelMetadataCalls:0,modelCalls:0,catalogWrites:0,
          fullCampaignResumed:false,nextStageApprovalRequired:true},null,2));
      }
    }finally{await pool.end();}
  }
}
async function main(){
  assert.notEqual(process.env.REPLIT_DEPLOYMENT,'1');
  const args=process.argv.slice(2);
  assert.equal(new Set(args.map(a=>a.split('=')[0])).size,args.length);
  assert.ok(args.every(a=>/^--(?:prepare-only|authorize-prepared|run-approved)$/.test(a)
    ||/^--(?:id|catalog-id|plan-sha256|approve-cents)=[a-z0-9-]+$/.test(a)));
  const modes=args.filter(a=>['--prepare-only','--authorize-prepared','--run-approved'].includes(a));
  assert.equal(modes.length,1);
  const value=k=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3);
  const id=value('id');assert.match(id??'',/^youtube-test-[a-z0-9-]{4,100}$/);
  const root='generated-artifacts/'+id;
  if(modes[0]==='--prepare-only'){
    assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
    console.log(JSON.stringify(await prepareStagedSearch(id,value('catalog-id'))));return;
  }
  assert.equal(value('catalog-id'),undefined,'Catalog selection is preparation-only');
  const plan=await read(root+'/plan.json');assert.equal(plan.id,id);
  await assertStagedSearchFrozen(root,plan);
  if(modes[0]==='--authorize-prepared'){
    const approval=approveStagedSearch(plan,{expectedPlanSha256:value('plan-sha256'),
      capCents:Number(value('approve-cents')),approvedAt:new Date().toISOString()});
    await durableStageFile(root+'/approval.json',JSON.stringify(approval,null,2));
    console.log(JSON.stringify({status:'approved_not_started',paidCalls:0}));return;
  }
  assert.equal(value('approve-cents'),undefined);assert.equal(value('plan-sha256'),undefined);
  assert.ok(process.env.SERPERDEV_API_KEY,'Search provider credential required');
  await run(root,plan,await read(root+'/approval.json'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
