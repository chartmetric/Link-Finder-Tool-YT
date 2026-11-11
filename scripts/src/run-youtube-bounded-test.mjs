// Explicit new 20-artist test. Never resumes the uncapped YouTube campaign.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {select,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';
import {youtubeMetadataQueries,bindYoutubeCatalogAccounts} from './youtube-catalog-metadata.mjs';
import {createYoutubeChannelCache} from './youtube-channel-dedup.mjs';
import {eligibilitySql} from './run-youtube-campaign.mjs';
import {youtubeTestSchema,youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {exportYoutubeCatalogEvidence} from './youtube-ownership-catalog-export.mjs';
import {youtubeArtistFromCatalogPacket,assembleYoutubeOwnershipEvidence} from './youtube-ownership-evidence.mjs';
import {MODEL_PLAN,campaignTransport,classifyYoutubeResult} from './youtube-campaign-core.mjs';
import {evidenceDigest as hash,youtubeVerificationInput,evaluateYoutubeOwnership} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision} from './youtube-ownership-transport.mjs';
import {boundedYoutubeSchema,boundedYoutubeGate} from './youtube-bounded-test-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {boundedTestOptions,approveBoundedTestPlan} from './youtube-bounded-test-plan.mjs';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
const {id,root}=boundedTestOptions(process.argv.slice(2));
const parentId='full-tiers-1-5-no-youtube-uncapped';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const save=async(name,value)=>fs.writeFile(root+'/'+name,JSON.stringify(value),{flag:'wx'});
async function prepare(){
  assert.ok(process.argv.includes('--prepare-only'),'Preparation cannot imply spending approval');
  try{await fs.access(root);throw Error('Test destination already exists; prepare a fresh ID');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const pool=await connectSavedBatchPool();
  let options;
  try{
    assert.equal((await pool.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[parentId])).rows[0]?.status,'stopped');
    options=(await pool.query(`SELECT a.profile_id,a.cm_artist,a.artist,a.tier,a.ordinal
      FROM youtube_link_campaign_artists a WHERE campaign_id=$1 AND status='queued'
      AND NOT EXISTS(SELECT 1 FROM youtube_link_campaign_admissions d WHERE d.profile_id=a.profile_id)
      AND NOT EXISTS(SELECT 1 FROM youtube_discovery_test_results d WHERE d.profile_id=a.profile_id)
      ORDER BY tier,ordinal LIMIT 60`,[parentId])).rows;
  }finally{await pool.end();}
  const eligible=await select(eligibilitySql(options.map(a=>a.profile_id)));
  const byId=new Map(eligible.map(a=>[a.profile_id,a]));
  const artists=options.filter(a=>byId.get(a.profile_id)?.cm_artist===a.cm_artist)
    .slice(0,20).map(a=>({...a,...byId.get(a.profile_id),tier:Number(byId.get(a.profile_id).tier)}))
    .sort((a,b)=>a.tier-b.tier||a.ordinal-b.ordinal);
  assert.equal(artists.length,20);
  assert.ok(artists.every(a=>Date.now()-Date.parse(a.snapshot_at.replace(' ','T')+'Z')<36*3600000));
  let manifest={artists:artists.map(a=>({...a,accounts:[],account_ids:[]}))};
  const accounts=await select(youtubeMetadataQueries(manifest).accounts);
  manifest=bindYoutubeCatalogAccounts(manifest,accounts);
  const data={accounts:manifest.artists.flatMap(a=>a.accounts)};
  for(const [name,sql] of Object.entries(youtubeMetadataQueries(manifest)))
    if(name!=='accounts')data[name]=await select(sql);
  const packets=buildMetadataOverlay(manifest,data,{queryCount:Object.keys(data).length,modelCalls:0,
    newSearches:0,scrapeCalls:0,startedAt:new Date().toISOString()}).packets;
  await fs.mkdir(root);
  for(const dir of ['receipts','metadata','artists','inputs'])await fs.mkdir(root+'/'+dir);
  for(const p of packets){
    await save('metadata/'+p.profileId+'.json',p);
  }
  await exportYoutubeCatalogEvidence(root,root+'/supplemental-catalog');
  const enriched=await read(root+'/supplemental-catalog/packets.json');
  const scope={id,artists,scopeSha256:hash(artists),discoveryPolicyVersion:1,userCapCents:null,proposedCapCents:200,operationalCapCents:200,
    candidatesPerArtist:2,maxCalls:100,explicitApproval:false,approvalStatus:'awaiting_spending_approval',
    approvedBy:null,
    noCatalogWrites:true,noAutomaticRetries:true,fullCampaignRemainsPaused:true,
    catalogEvidenceSha256:hash(enriched),model:MODEL_PLAN};
  const files=await freezeLocalModules(fileURLToPath(import.meta.url),root+'/runtime');
  scope.runtimeFiles={};
  for(const source of files){
    const name=path.basename(source);
    scope.runtimeFiles[name]=hash(await fs.readFile(root+'/runtime/'+name,'utf8'));
  }
  await save('plan.json',scope);
  console.log(JSON.stringify({status:'prepared',id,artists:20,tiers:artists.map(a=>a.tier),
    proposedMaximumUsd:2,spendingApproved:false,paidCalls:0}));
}
async function authorize(){
  assert.ok(process.argv.includes('--approve-usd=2'),'Explicit $2 spending approval required');
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Authorize the frozen runtime only');
  const plan=await read(root+'/plan.json');
  const expectedPlanSha256=process.argv.find(a=>a.startsWith('--plan-sha256='))?.slice('--plan-sha256='.length);
  assert.equal(hash(await read(root+'/supplemental-catalog/packets.json')),plan.catalogEvidenceSha256);
  for(const [name,sha] of Object.entries(plan.runtimeFiles)){
    assert.equal(path.basename(name),name);
    assert.equal(hash(await fs.readFile(root+'/runtime/'+name,'utf8')),sha);
  }
  await save('approval.json',approveBoundedTestPlan(plan,{id,capCents:200,approvedAt:new Date().toISOString(),expectedPlanSha256}));
  console.log(JSON.stringify({status:'authorized_not_started',id,maximumUsd:2,paidCalls:0}));
}
async function run(){
  assert.ok(process.argv.includes('--run-approved'));
  assert.equal(path.dirname(fileURLToPath(import.meta.url)),path.resolve(root,'runtime'),'Run the frozen runtime only');
  const scope=await read(root+'/approval.json'),packets=await read(root+'/supplemental-catalog/packets.json');
  assert.equal(scope.explicitApproval,true);assert.equal(scope.approvalStatus,'approved');
  assert.equal(hash(await read(root+'/plan.json')),scope.planSha256);
  assert.equal(scope.discoveryPolicyVersion,1,'Legacy approvals cannot authorize changed search wording.');
  assert.equal(scope.scopeSha256,hash(scope.artists));assert.equal(hash(packets),scope.catalogEvidenceSha256);
  assert.equal(scope.artists.length,20);assert.equal(scope.userCapCents,200);
  assert.equal(scope.operationalCapCents,200);assert.equal(scope.candidatesPerArtist,2);
  const fresh=await select(eligibilitySql(scope.artists.map(a=>a.profile_id)));
  assert.ok(scope.artists.every(a=>fresh.some(f=>f.profile_id===a.profile_id&&f.cm_artist===a.cm_artist&&Number(f.tier)===a.tier)));
  const assertFrozen=async()=>{
    assert.equal(hash(await read(root+'/approval.json')),hash(scope));
    for(const [name,sha] of Object.entries(scope.runtimeFiles))
      assert.equal(hash(await fs.readFile(root+'/runtime/'+name,'utf8')),sha);
  };
  await assertFrozen();
  for(const key of ['SERPERDEV_API_KEY','SCRAPECREATORS_API_KEY','OPENROUTER_API_KEY'])
    assert.ok(process.env[key],'Required provider credential is missing');
  const pool=await connectSavedBatchPool(),owner=randomUUID(),records=[];
  let started=false,status='stopped',stopReason=null;
  try{
    await pool.query(youtubeTestSchema);await pool.query(boundedYoutubeSchema);
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      assert.equal((await c.query('SELECT status FROM youtube_link_campaigns WHERE id=$1 FOR UPDATE',[parentId])).rows[0]?.status,'stopped');
      assert.equal((await c.query("SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE status='admitted'")).rows[0].n,0);
      for(const a of scope.artists){
        assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_link_campaign_admissions WHERE profile_id=$1`,[a.profile_id])).rows[0].n,0);
        assert.equal((await c.query(`SELECT count(*)::int n FROM youtube_discovery_test_results WHERE profile_id=$1`,[a.profile_id])).rows[0].n,0);
      }
      await c.query('INSERT INTO youtube_discovery_test_runs(id,owner,scope_sha256,cap_cents,status) VALUES($1,$2,$3,200,$4)',
        [id,owner,scope.scopeSha256,'running']);
      for(const a of scope.artists)await c.query(`INSERT INTO youtube_discovery_test_results
        (run_id,profile_id,cm_artist,artist,tier,status,metadata_json) VALUES($1,$2,$3,$4,$5,'prepared',$6::jsonb)`,
        [id,a.profile_id,a.cm_artist,a.artist,a.tier,JSON.stringify({approvalSha256:hash(scope)})]);
      await c.query('COMMIT');started=true;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
    const gate=boundedYoutubeGate({pool,id,owner,scope,parentId});
    const transport=campaignTransport({root,assertFrozen,admit:gate.admit,returned:gate.returned,
      credentials:{serper:process.env.SERPERDEV_API_KEY,scrapecreators:process.env.SCRAPECREATORS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY}});
    const request=async(profileId,kind,key,body)=>{
      await save('inputs/'+hash(key)+'.json',{profileId,kind,key,request:body,inputSha256:hash(body)});
      return transport(profileId,kind,key,body);
    };
    // Capture the whole small cohort before deciding, so reused channels within
    // the test cannot silently pass merely because their artist was first.
    for(const a of scope.artists){
      const packet=packets.find(p=>p.profileId===a.profile_id);assert.ok(packet);
      const artist=youtubeArtistFromCatalogPacket(packet);
      const searchPlan=youtubeSearchPlan(artist);
      const response=await request(a.profile_id,'search','search-'+a.profile_id+'-0',{
        method:'POST',url:'https://google.serper.dev/search',body:searchPlan.request});
      assert.equal(response.status,200);
      const discovery=rankYoutubeSearchCandidates(youtubeSearchCandidates(response.data),searchPlan,{limit:2});
      const candidates=[],channelCache=createYoutubeChannelCache(artist);
      for(const candidate of discovery.candidates){
        if(channelCache.reuse(artist,candidate))continue;
        const response=await request(a.profile_id,'metadata','metadata-'+a.profile_id+'-'+hash(candidate.url),{
          method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?'+new URLSearchParams({url:candidate.url})});
        candidate.capture=normalizeYoutubeChannel(response,candidate.url);
        if(!channelCache.observe(artist,candidate))candidates.push(candidate);
      }
      const record={artist,tier:a.tier,searchPlan,...discovery,
        relatedTopicCandidates:discovery.topicCandidates,candidates};
      records.push(record);await save('artists/'+a.profile_id+'-captures.json',record);
      console.log(JSON.stringify({phase:'captures',artists:records.length,total:20,candidates:candidates.length}));
    }
    const ownership=new Map();
    for(const r of records)for(const candidate of r.candidates){
      const channel=candidate.capture?.body.channelId;if(!channel)continue;
      const owners=ownership.get(channel)??new Set();owners.add(r.artist.profileId);ownership.set(channel,owners);
    }
    for(const r of records){
      const packet=packets.find(p=>p.profileId===r.artist.profileId);
      for(const candidate of r.candidates){
        const channel=candidate.capture?.body.channelId;
        const prior=channel?(await pool.query('SELECT DISTINCT profile_id FROM youtube_link_campaign_channels WHERE channel_id=$1 AND profile_id<>$2',
          [channel,r.artist.profileId])).rows:[];
        const shared=Boolean(prior.length||(channel&&ownership.get(channel).size>1));
        const artist={...r.artist,ownershipEvidence:assembleYoutubeOwnershipEvidence(r.artist,packet,candidate)};
        let decision=evaluateYoutubeOwnership(artist,candidate,{sharedChannel:shared,contradictoryPair:candidate.contradictoryPair===true});
        if(decision.status==='needs_identity_check'){
          const input=youtubeVerificationInput(artist,candidate),prepared=youtubeDecisionRequest(input,MODEL_PLAN);
          candidate.metadataActuallyUsed=input;
          if(!prepared.ready)decision={...decision,reason:'model_request_exceeds_approved_byte_limit'};
          else{
            const reply=await request(r.artist.profileId,'model','model-'+r.artist.profileId+'-'+hash(candidate.url),prepared.request);
            candidate.recordedAnswer=parseYoutubeDecision(reply,input,MODEL_PLAN,prepared.inputSha256);
            decision=evaluateYoutubeOwnership(artist,candidate,{sharedChannel:shared,
              contradictoryPair:candidate.contradictoryPair===true,answer:candidate.recordedAnswer});
          }
        }
        candidate.decision=decision;
      }
      const classification=classifyYoutubeResult(r);r.classification=classification;
      await save('artists/'+r.artist.profileId+'.json',r);
      const updated=await pool.query(`UPDATE youtube_discovery_test_results d SET status=$4,candidates_json=$5::jsonb,metadata_json=$6::jsonb,checked_at=now()
        FROM youtube_discovery_test_runs r WHERE d.run_id=$1 AND d.profile_id=$2 AND r.id=d.run_id AND r.owner=$3 AND r.status='running'`,
        [id,r.artist.profileId,owner,r.searchStatus,JSON.stringify(r.candidates),JSON.stringify(r.artist)]);
      assert.equal(updated.rowCount,1);
      console.log(JSON.stringify({phase:'reviewed',profileId:r.artist.profileId,artist:r.artist.name,...classification}));
    }
    status='completed';
  }catch(error){stopReason=String(error.message).replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,180);throw error;}
  finally{
    if(started){
      await pool.query("UPDATE youtube_discovery_test_runs SET status=$3 WHERE id=$1 AND owner=$2 AND status='running'",[id,owner,status]);
      const budget=(await pool.query('SELECT status,reserved_cents,cap_cents FROM youtube_discovery_test_runs WHERE id=$1',[id])).rows[0];
      const admissions=(await pool.query('SELECT kind,status,count(*)::int calls FROM youtube_bounded_test_admissions WHERE run_id=$1 GROUP BY kind,status',[id])).rows;
      const completed=records.filter(r=>r.classification),checked=completed.filter(r=>r.classification.checked),likely=completed.filter(r=>r.classification.likely);
      const summary={id,status,stopReason,artistsCompleted:completed.length,artistsCaptured:records.length,
        checkedArtists:checked.length,likelyMatches:likely.length,successRate:checked.length?likely.length/checked.length:null,
        noChannelFound:completed.filter(r=>!r.allSearchCandidates.length).length,
        noArtistChannelSelected:completed.filter(r=>r.allSearchCandidates.length&&!r.candidates.length).length,
        noChannelResult:completed.filter(r=>r.searchStatus==='no_match').length,
        offTargetOnly:completed.filter(r=>r.outcome==='off_target_results_only').length,
        topicOnly:completed.filter(r=>r.outcome==='topic_only').length,channelAbsenceProven:false,
        checkedNotAccepted:checked.filter(r=>!r.classification.likely).length,
        reservedUsd:Number(budget.reserved_cents)/100,operationalMaximumUsd:2,userMaximumUsd:scope.userCapCents/100,admissions,
        catalogWrites:0,fullYoutubeCampaignResumed:false,instagramChanged:false,recordedAt:new Date().toISOString()};
      await save('summary.json',summary);
      if(completed.length){
        const rows=completed.flatMap(r=>r.candidates.length?r.candidates.map(c=>({
          artist:r.artist.name,tier:r.tier,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,youtube_url:c.url,
          ...c.decision,search_title:c.title,search_snippet:c.snippet,
          recorded_answer:c.recordedAnswer??null,metadata_actually_used:c.metadataActuallyUsed??null,
          captured_channel:c.capture?.body??null,artist_catalog_metadata:r.artist,
        })):[{artist:r.artist.name,tier:r.tier,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,youtube_url:'',status:r.outcome,channelAbsenceProven:false}]);
        const columns=[...new Set(rows.flatMap(Object.keys))],cell=v=>{
          let s=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);
          if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';
        };
        await fs.writeFile(root+'/youtube-test-findings.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\r\n'),{flag:'wx'});
      }
      console.log(JSON.stringify(summary));
    }
    await pool.end();
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--prepare-only'))await prepare();
  else if(process.argv.includes('--authorize-prepared'))await authorize();
  else if(process.argv.includes('--run-approved'))await run();
  else throw Error('Use --prepare-only, --authorize-prepared, or --run-approved; preparation never authorizes paid work');
}
