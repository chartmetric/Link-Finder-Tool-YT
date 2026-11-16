// Catalog reads and local preparation only. Never authorizes or dispatches providers.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {freshHundredArtists,hundredSearchPlan} from './youtube-hundred-search-plan.mjs';
import {youtubeEligibilitySql} from './youtube-discovery-test.mjs';
import {select} from './instagram-artist-metadata-overlay.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {collectTargetPlatformMetadata} from './target-platform-catalog-metadata.mjs';
import {exportYoutubeCatalogEvidence} from './youtube-ownership-catalog-export.mjs';
import {searchReadiness,prepareStagedSearch} from './run-youtube-staged-search.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
const parentId='full-tiers-1-5-no-youtube-uncapped';
const save=async(file,value)=>fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
async function attemptedArtists(){
  const pool=await connectSavedBatchPool();let client;
  try{
    client=await pool.connect();await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const rows=(await client.query(`WITH attempted AS (
      SELECT profile_id FROM youtube_link_campaign_admissions UNION SELECT profile_id FROM youtube_discovery_test_results
      UNION SELECT profile_id FROM youtube_bounded_test_admissions UNION SELECT profile_id FROM youtube_video_stage_admissions
      UNION SELECT profile_id FROM youtube_video_identity_admissions)
      SELECT profile_id,cm_artist FROM youtube_link_campaign_artists WHERE profile_id IN(SELECT profile_id FROM attempted)
      UNION SELECT profile_id,cm_artist FROM youtube_discovery_test_results
      UNION SELECT profile_id,cm_artist FROM youtube_video_stage_admissions
      UNION SELECT profile_id,cm_artist FROM youtube_video_identity_admissions`)).rows;
    await client.query('COMMIT');return rows;
  }catch(error){if(client)await client.query('ROLLBACK');throw error;}
  finally{client?.release();await pool.end();}
}
export async function prepareHundredSearch({
  id='youtube-batch-100-staged-2026-11-13',additionalHistory=[],
}={}){
  assert.match(id,/^youtube-batch-100-[a-z0-9-]{4,70}$/);
  const root='generated-artifacts/'+id;
  try{await fs.lstat(root);assert.fail('Fresh batch destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const history=[...await attemptedArtists(),...additionalHistory];
  const sql=youtubeEligibilitySql.replace('LIMIT 4 BY t.tier','LIMIT 1000 BY t.tier');
  const rows=await select(sql),artists=freshHundredArtists(rows,history);
  const pool=await connectSavedBatchPool();let c;
  try{
    c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await searchReadiness(c,artists,parentId);await c.query('COMMIT');
  }catch(error){if(c)await c.query('ROLLBACK');throw error;}
  finally{c?.release();await pool.end();}
  const {packets}=await collectTargetPlatformMetadata({artists:artists.map(a=>({...a,accounts:[],account_ids:[]}))},
    {targetPlatform:'youtube'});
  assert.equal(packets.length,100);
  await fs.mkdir(root);await fs.mkdir(root+'/metadata');
  for(const packet of packets)await save(root+'/metadata/'+packet.profileId+'.json',packet);
  await exportYoutubeCatalogEvidence(root,root+'/supplemental-catalog');
  const enriched=JSON.parse(await fs.readFile(root+'/supplemental-catalog/packets.json'));
  const catalog={id,explicitApproval:false,catalogPreparationOnly:true,artists,
    catalogEvidenceSha256:digest(enriched),historySha256:digest(history),
    selectionPolicy:'Equal round-robin across available fresh tiers, then frozen tier/rank order',
    selectionQuery:sql,paidCalls:0};
  await save(root+'/catalog-preparation.json',catalog);
  const children=[];
  for(let i=0;i<5;i++){
    const subset=artists.slice(i*20,(i+1)*20);
    const stem=id.replace('youtube-batch-100-','youtube-test-100-');
    const catalogId=stem+'-catalog-part-'+(i+1);
    const childId=stem+'-part-'+(i+1);
    const catalogRoot='generated-artifacts/'+catalogId;
    await fs.mkdir(catalogRoot);await fs.mkdir(catalogRoot+'/supplemental-catalog');
    const childPackets=subset.map(a=>enriched.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist));
    assert.ok(childPackets.every(Boolean));
    await save(catalogRoot+'/supplemental-catalog/packets.json',childPackets);
    await save(catalogRoot+'/plan.json',{id:catalogId,artists:subset,explicitApproval:false,
      catalogPreparationOnly:true,parentCatalogueSha256:digest(catalog),parentBundleId:id,
      catalogEvidenceSha256:digest(childPackets)});
    await prepareStagedSearch(childId,catalogId);
    children.push({id:childId,plan:JSON.parse(await fs.readFile('generated-artifacts/'+childId+'/plan.json'))});
    console.log(JSON.stringify({phase:'prepared_search_cohort',completed:(i+1)*20,total:100,paidCalls:0}));
  }
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-hundred-search.mjs'),root+'/runtime'),runtimeFiles={};
  for(const file of modules){const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));}
  const plan=hundredSearchPlan({id,preparedAt:new Date().toISOString(),children,runtimeFiles});
  await save(root+'/plan.json',plan);
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const columns=['artist','tier','profile_id','cm_artist','search_cohort','exact_search_query','search_reservation_cents','status'];
  const csvRows=children.flatMap((child,i)=>child.plan.artists.map(a=>[a.artist,a.tier,a.profile_id,a.cm_artist,i+1,
    child.plan.operations.find(o=>o.profileId===a.profile_id).request.body.q,2,'Prepared only — no requests sent']));
  await save(root+'/proposed-100-artists.csv','\ufeff'+[columns,...csvRows].map(r=>r.map(cell).join(',')).join('\r\n'));
  const summary={status:'prepared_not_approved',id,artists:100,tiers:plan.tiers,
    searchCalls:100,maximumNewSpendCents:200,planSha256:digest(plan),paidCalls:0,
    ledgerWrites:0,catalogWrites:0,fullCampaignResumed:false,laterStagesRequireSeparateApproval:true};
  await save(root+'/preparation.json',summary);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);
  console.log(JSON.stringify(await prepareHundredSearch()));
}
