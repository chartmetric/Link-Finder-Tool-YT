// Saved-result screening plus read-only catalog/coordinator checks. No dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {mixedCapturePlan,DIRECT_CAPTURE_POLICY} from './youtube-mixed-channel-captures.mjs';
import {mixedCaptureReadiness} from './youtube-mixed-capture-readiness.mjs';
import {mixedClaims} from './run-youtube-mixed-captures.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {channelCheckBundle} from './youtube-channel-check-bundle.mjs';
const sourceId='youtube-batch-100-staged-2026-11-13';
const id='youtube-batch-channel-checks-direct-100-2026-11-13',root='generated-artifacts/'+id;
const save=async(file,value)=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const csv=(columns,rows)=>'\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n');
export async function prepareBatchChannelChecks(){
  try{await fs.lstat(root);assert.fail('Fresh preparation required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceFiles={},bytes=async file=>{const b=await fs.readFile(file);sourceFiles[file]=digest(b);return b;};
  const read=async file=>JSON.parse(await bytes(file));
  const parent=await read('generated-artifacts/'+sourceId+'/plan.json');
  const parentSummary=await read('generated-artifacts/'+sourceId+'/summary.json');
  assert.equal(parentSummary.status,'completed');assert.equal(parentSummary.searchCalls,100);
  const groups=[],allRecords=[],claims=[];
  for(const child of parent.children){
    const sourceRoot='generated-artifacts/'+child.id,p=await read(sourceRoot+'/plan.json');
    assert.equal(digest(p),child.planSha256);
    assertStagedSearchApproval(p,await read(sourceRoot+'/approval.json'));
    assert.equal((await read(sourceRoot+'/summary.json')).status,'completed');
    for(const [file,sha] of Object.entries({...p.evidenceFiles,...p.runtimeFiles}))
      assert.equal(digest(await bytes(sourceRoot+'/'+file)),sha);
    const artists=[],directLeads=[];
    for(const a of p.artists){
      const r=await read(sourceRoot+'/artists/'+a.profile_id+'.json');
      const artist=youtubeArtistFromCatalogPacket(p.packets.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist));
      assert.deepEqual(r.artist,artist);assert.equal(r.ownershipAccepted,false);
      assert.deepEqual(r.searchPlan,youtubeSearchPlan(artist));
      const receipt=await read(sourceRoot+'/receipts/'+archivedSearchReceiptName(a.profile_id));
      const op=p.operations.find(o=>o.profileId===a.profile_id);
      assert.equal(receipt.status,200);assert.equal(receipt.parseFailed,false);
      assert.equal(receipt.operationKey,op.key);assert.equal(receipt.inputSha256,op.inputSha256);
      assert.deepEqual(receipt.request,op.request);
      const ranked=rankYoutubeSearchCandidates(youtubeSearchCandidates(receipt.data),r.searchPlan,
        {limit:2,includeTopicChannels:true});
      assert.deepEqual(r.candidates,ranked.candidates);
      artists.push({...artist,tier:a.tier});
      directLeads.push({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,candidates:r.candidates});
      allRecords.push({artist:a.artist,tier:a.tier,profileId:a.profile_id,cmArtist:a.cm_artist,
        videos:r.videoPlan.resolutionQueue});
      for(const c of r.candidates)claims.push({url:c.url,profileId:a.profile_id,cmArtist:a.cm_artist,source:'current_search_cohort'});
    }
    groups.push({sourceId:p.id,artists,directLeads});
  }
  assert.equal(allRecords.length,100);
  const aliases=new Set(claims.map(c=>returnedYoutubeUrl(c.url)?.toLowerCase()).filter(Boolean));
  const add=(raw,profileId,cmArtist,source)=>{
    const url=returnedYoutubeUrl(raw);
    if(url&&aliases.has(url.toLowerCase()))claims.push({url,profileId:String(profileId),cmArtist:String(cmArtist??''),source});
  };
  // One bounded read of catalog ownership claims; retain only relevant aliases.
  const catalog=await select(`SELECT toString(l.profile_id) profile_id,toString(p.cm_source_id) cm_artist,
    a.account_url FROM new_vertical.l_profile_account l FINAL
    INNER JOIN new_vertical.account a FINAL ON a.id=l.account_id
    LEFT JOIN new_vertical.profile p FINAL ON p.id=l.profile_id
    WHERE lower(a.platform)='youtube' AND notEmpty(trim(ifNull(a.account_url,'')))`);
  for(const row of catalog)add(row.account_url,row.profile_id,row.cm_artist,'current_catalog_claim');
  const pool=await connectSavedBatchPool();let client;
  try{
    client=await pool.connect();await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for(const r of (await client.query('SELECT alias,profile_id,cm_artist FROM youtube_video_identity_claims')).rows)
      add(r.alias,r.profile_id,r.cm_artist,'historical_identity_claim');
    for(const r of (await client.query(`SELECT ch.channel_id,ch.profile_id,a.cm_artist
      FROM youtube_link_campaign_channels ch LEFT JOIN youtube_link_campaign_artists a
      ON a.campaign_id=ch.campaign_id AND a.profile_id=ch.profile_id`)).rows)
      add('https://www.youtube.com/channel/'+r.channel_id,r.profile_id,r.cm_artist,'historical_campaign_claim');
    for(const r of (await client.query('SELECT profile_id,cm_artist,candidates_json FROM youtube_discovery_test_results')).rows){
      const visit=value=>{
        if(typeof value==='string')add(value,r.profile_id,r.cm_artist,'historical_search_claim');
        else if(Array.isArray(value))value.forEach(visit);
        else if(value&&typeof value==='object'){
          if(/^UC[A-Za-z0-9_-]{22}$/.test(value.channelId??''))
            add('https://www.youtube.com/channel/'+value.channelId,r.profile_id,r.cm_artist,'historical_search_claim');
          Object.values(value).forEach(visit);
        }
      };visit(r.candidates_json);
    }
    await client.query('COMMIT');
  }catch(error){if(client)await client.query('ROLLBACK');throw error;}
  finally{client?.release();await pool.end();}
  await fs.mkdir(root);
  const context={observedAt:new Date().toISOString(),claims,
    warning:'A claim can indicate ambiguity; it is not proof of artist ownership.'};
  await save(root+'/claim-context.json',context);sourceFiles[root+'/claim-context.json']=digest(await fs.readFile(root+'/claim-context.json'));
  const children=[],selected=[],others=[];
  for(let i=0;i<groups.length;i++){
    const g=groups[i],childId='youtube-mixed-captures-direct-100-2026-11-13-part-'+(i+1);
    const input={version:DIRECT_CAPTURE_POLICY,id:childId,preparedAt:new Date().toISOString(),
      artists:g.artists,directLeads:g.directLeads,uploaderResults:[],sourceSearchId:g.sourceId,sourceUploaderIds:[],
      cohortClaims:claims,sourceFiles,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}};
    let plan=mixedCapturePlan(input);
    await identityCatalogCheck(plan)(mixedClaims(plan));
    const p=await connectSavedBatchPool();let c;
    try{
      c=await p.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await mixedCaptureReadiness(c,plan,{preparationOnly:true});await c.query('COMMIT');
    }catch(error){if(c)await c.query('ROLLBACK');throw error;}finally{c?.release();await p.end();}
    const folder='generated-artifacts/'+childId;await fs.mkdir(folder);
    const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
      'run-youtube-mixed-captures.mjs'),folder+'/runtime'),runtimeFiles={};
    for(const file of modules){const key='runtime/'+path.basename(file);runtimeFiles[key]=digest(await fs.readFile(folder+'/'+key));}
    plan=mixedCapturePlan({...input,runtimeFiles});await save(folder+'/plan.json',plan);
    children.push({id:childId,plan});
    selected.push(...plan.alternatives.filter(a=>a.disposition==='selected_for_capture'));
    others.push(...plan.alternatives.filter(a=>a.disposition!=='selected_for_capture'));
    console.log(JSON.stringify({phase:'prepared_direct_channel_checks',cohort:i+1,requests:plan.maximumCalls,paidCalls:0}));
  }
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-channel-check-bundle.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){const key='runtime/'+path.basename(file);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));}
  const plan=channelCheckBundle({id,preparedAt:new Date().toISOString(),sourceBundleId:sourceId,
    sourceBundleSha256:digest(parent),children,runtimeFiles});
  await save(root+'/plan.json',plan);
  const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_type_label','disposition','shared_channel_conflict','evidence','ownership_accepted','import_eligible'];
  const row=a=>[a.artist,a.tier,a.profileId,a.cmArtist,a.url,
    a.observations.some(o=>/\s*[-–—]\s*Topic\s*$/iu.test(o.title??''))?'Topic — auto-generated lead, association unverified':
      a.observations.some(o=>o.topicHint)?'YouTube Music lead — channel type unverified':'Channel type and artist ownership unverified',
    a.disposition,a.sharedChannelConflict,(a.sharedChannelConflict?'Shared channel claim — ownership unresolved. ':'')+
      a.observations.map(o=>o.reason).join('; '),false,false];
  await save(root+'/proposed-channel-checks.csv',csv(columns,selected.map(row)));
  await save(root+'/held-and-alternative-leads.csv',csv(columns,others.map(row)));
  const ids=new Set(selected.map(a=>a.profileId));
  const pending=allRecords.filter(a=>!ids.has(a.profileId));
  await save(root+'/remaining-artists.csv',csv(['artist','tier','profile_id','cm_artist','pending_video_leads','status'],
    pending.map(a=>[a.artist,a.tier,a.profileId,a.cmArtist,a.videos.length,
      a.videos.length?'Video fallback saved — uploader checks need a separate plan':'No selected direct channel or saved video fallback — not proof of no channel'])));
  const summary={status:'prepared_not_approved',id,sourceArtists:100,channelChecks:plan.maximumCalls,
    maximumAdditionalCents:plan.maximumSpendCents,sourceSearchReservedCents:200,
    maximumSearchPlusThisStageCents:200+plan.maximumSpendCents,heldDirectLeads:others.filter(a=>a.disposition==='held_not_established').length,
    deferredAlternatives:others.filter(a=>a.disposition==='deferred_one_channel_per_artist').length,
    remainingArtists:pending.length,artistsWithPendingVideoFallbacks:pending.filter(a=>a.videos.length).length,
    planSha256:digest(plan),paidCalls:0,ledgerWrites:0,catalogWrites:0,uploaderCalls:0,modelCalls:0};
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await save(root+'/preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareBatchChannelChecks()));
}
