// Local files plus read-only catalog/coordinator queries. No authorizations,
// schema changes, paid provider calls, identity claims or catalog writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {auditAccountedSearches} from './youtube-accounted-search-source.mjs';
import {accountedChannelPlan} from './youtube-accounted-channel-plan.mjs';
import {accountedChannelReadiness} from './youtube-accounted-channel-readiness.mjs';
import {identityEligibilitySql,identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {catalogLinkedYoutubeClaims} from './youtube-catalog-linked-claims.mjs';
import {catalogReadWithOneTimeoutRetry} from './youtube-catalog-read-retry.mjs';
import {returnedYoutubeUrl} from './youtube-ownership-policy.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const id='youtube-accounted-channel-checks-500-2026-11-16',root='generated-artifacts/'+id;
const continuationRoot='generated-artifacts/youtube-search-continuation-410-ready-2026-11-16';
const exportRoot='generated-artifacts/youtube-search-results-500-completed-2026-11-16';
const save=async(name,value)=>fs.writeFile(root+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const csv=rows=>'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
export async function prepareAccountedChannels(){
  try{await fs.lstat(root);assert.fail('A fresh preparation is required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const pool=await connectSavedBatchPool();let c,audit;const claims=[];
  try{
    c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    audit=await auditAccountedSearches(c,{continuationRoot,exportRoot});
    const aliases=new Set(audit.records.flatMap(r=>r.record.candidates.map(c=>returnedYoutubeUrl(c.url).toLowerCase())));
    const add=(raw,profileId,cmArtist,source)=>{
      const url=returnedYoutubeUrl(raw);
      if(url&&aliases.has(url.toLowerCase()))claims.push({url,profileId:String(profileId),
        cmArtist:String(cmArtist??''),source});
    };
    const installed=(await c.query("SELECT to_regclass('youtube_video_identity_claims') claims")).rows[0].claims;
    if(installed)for(const r of (await c.query('SELECT alias,profile_id,cm_artist FROM youtube_video_identity_claims')).rows)
      add(r.alias,r.profile_id,r.cm_artist,'historical_identity_claim');
    for(const r of (await c.query(`SELECT ch.channel_id,ch.profile_id,a.cm_artist
      FROM youtube_link_campaign_channels ch LEFT JOIN youtube_link_campaign_artists a
      ON a.campaign_id=ch.campaign_id AND a.profile_id=ch.profile_id`)).rows)
      add('https://www.youtube.com/channel/'+r.channel_id,r.profile_id,r.cm_artist,'historical_campaign_claim');
    for(const r of (await c.query('SELECT profile_id,cm_artist,candidates_json FROM youtube_discovery_test_results')).rows){
      const visit=v=>{
        if(typeof v==='string')add(v,r.profile_id,r.cm_artist,'historical_search_claim');
        else if(Array.isArray(v))v.forEach(visit);
        else if(v&&typeof v==='object'){
          if(/^UC[A-Za-z0-9_-]{22}$/.test(v.channelId??''))
            add('https://www.youtube.com/channel/'+v.channelId,r.profile_id,r.cm_artist,'historical_search_claim');
          Object.values(v).forEach(visit);
        }
      };visit(r.candidates_json);
    }
    await c.query('COMMIT');
  }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
  const selections=audit.records.map(({record:r})=>({profileId:r.artist.profileId,cmArtist:r.artist.cmArtist,
    artist:r.artist.name,tier:r.tier}));
  const currentRows=await catalogReadWithOneTimeoutRetry(select,identityEligibilitySql(selections));
  const direct=audit.records.flatMap(({record:r})=>r.candidates.map(c=>({
    alias:returnedYoutubeUrl(c.url),channelId:returnedYoutubeUrl(c.url).match(/\/channel\/(UC[A-Za-z0-9_-]{22})$/)?.[1]??null,
    profileId:r.artist.profileId,cmArtist:r.artist.cmArtist})));
  for(const r of await catalogLinkedYoutubeClaims(direct,select))claims.push({
    url:returnedYoutubeUrl(r.account_url),profileId:r.profile_id,cmArtist:r.cm_artist,source:'current_catalog_claim'});
  // Exact source accounting is separate from the original, honestly stopped run.
  await fs.mkdir(root);
  await save('source-ledger.json',{continuationRoot,exportRoot,observedAt:new Date().toISOString(),ledger:audit.ledger});
  await save('current-context.json',{observedAt:new Date().toISOString(),currentRows,claims});
  const sourceFiles={...audit.sourceFiles};
  for(const file of ['source-ledger.json','current-context.json'])
    sourceFiles[root+'/'+file]=digest(await fs.readFile(root+'/'+file));
  const input={id,sourceRoot:root,preparedAt:new Date().toISOString(),records:audit.records,claims,currentRows,
    sourceFiles,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}};
  let plan=accountedChannelPlan(input);
  await identityCatalogCheck(plan)(plan.selections.map(s=>({
    alias:s.url,channelId:s.channelId,profileId:s.profileId,cmArtist:s.cmArtist})));
  const p=await connectSavedBatchPool();let client;
  try{
    client=await p.connect();await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await accountedChannelReadiness(client,plan,{preparationOnly:true});await client.query('COMMIT');
  }catch(e){if(client)await client.query('ROLLBACK');throw e;}finally{client?.release();await p.end();}
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-accounted-channel-checks.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){
    const key='runtime/'+path.basename(file);runtimeFiles[key]=digest(await fs.readFile(root+'/'+key));
  }
  plan=accountedChannelPlan({...input,runtimeFiles});await save('plan.json',plan);
  const columns=['artist','starting_tier','current_tier','profile_id','cm_artist','youtube_url','channel_type_label',
    'status','reason','ownership_accepted','import_eligible'];
  const row=a=>[a.artist,a.startingTier,a.tier,a.profileId,a.cmArtist,a.url,a.topicLabel,
    a.disposition,a.reason??'Catalog-bound name agreement only; metadata and artist identity still unverified',false,false];
  await save('proposed-channel-checks.csv',csv([columns,...plan.alternatives.filter(a=>
    a.disposition==='selected_for_capture').map(row)]));
  await save('held-and-alternative-leads.csv',csv([columns,...plan.alternatives.filter(a=>
    a.disposition!=='selected_for_capture').map(row)]));
  await save('remaining-artists.csv',csv([
    ['artist','starting_tier','profile_id','cm_artist','saved_video_leads','reason','processed','no_match'],
    ...plan.remaining.map(r=>[r.artist,r.startingTier,r.profileId,r.cmArtist,r.savedVideoLeads,r.reason,false,false])]));
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  const summary={id,status:'prepared_not_approved',sourceArtists:500,channelChecks:plan.maximumCalls,
    maximumAdditionalCents:plan.maximumSpendCents,priorSearchReservedCents:1000,
    heldDirectLeads:plan.alternatives.filter(a=>a.disposition==='held_not_established').length,
    deferredAlternatives:plan.alternatives.filter(a=>a.disposition==='deferred_one_channel_per_artist').length,
    topicLabelledLeads:plan.selections.filter(s=>s.topicLabel.startsWith('Topic')).length,
    remainingArtists:plan.remaining.length,planSha256:digest(plan),
    paidCalls:0,ledgerWrites:0,catalogWrites:0,uploaderCalls:0,modelCalls:0,ownershipAccepted:0};
  await save('preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareAccountedChannels()));
}
