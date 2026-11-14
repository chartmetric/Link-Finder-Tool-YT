// New local preparation only; all database/catalog operations are read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {mapOrHoldSavedUploader} from './youtube-uploader-conflict-handling.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {mixedCapturePlan} from './youtube-mixed-channel-captures.mjs';
import {mixedCaptureReadiness} from './youtube-mixed-capture-readiness.mjs';
import {mixedClaims} from './run-youtube-mixed-captures.mjs';
import {identityCatalogCheck} from './youtube-video-identity-catalog.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const sourceSearchId='youtube-test-20-review-search-2026-11-13';
const sourceUploaderIds=['youtube-video-review-fresh-twenty-2026-11-13',
  'youtube-video-review-fresh-eight-continuation-2026-11-13','youtube-video-review-fresh-six-hold-2026-11-13'];
export async function prepareMixedCaptures(id){
  assert.match(id,/^youtube-mixed-captures-[a-z0-9-]{4,80}$/);
  const sourceFiles={},readBytes=async file=>{const b=await fs.readFile(file);sourceFiles[file]=digest(b);return b;};
  const read=async file=>JSON.parse(await readBytes(file));
  const searchRoot='generated-artifacts/'+sourceSearchId;
  const search=await read(searchRoot+'/plan.json');
  assertStagedSearchApproval(search,await read(searchRoot+'/approval.json'));
  assert.equal((await read(searchRoot+'/summary.json')).status,'completed');
  for(const [name,sha] of Object.entries({...search.evidenceFiles,...search.runtimeFiles}))
    assert.equal(digest(await readBytes(searchRoot+'/'+name)),sha);
  // Preserve all catalog context, not just the artist name.
  const artists=search.artists.map(a=>({...youtubeArtistFromCatalogPacket(
    search.packets.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist)),tier:a.tier}));
  const directLeads=[];
  for(const a of search.artists){
    const record=await read(searchRoot+'/artists/'+a.profile_id+'.json');
    const exact=artists.find(x=>x.profileId===a.profile_id);
    const {tier,...withoutTier}=exact;assert.deepEqual(record.artist,withoutTier);
    const op=search.operations.find(o=>o.profileId===a.profile_id);
    const receiptNames=(await fs.readdir(searchRoot+'/receipts')).filter(f=>f.endsWith('.json'));
    let receipt;
    for(const name of receiptNames){
      const r=JSON.parse(await fs.readFile(searchRoot+'/receipts/'+name));
      if(r.operationKey===op.key){assert.equal(receipt,undefined);receipt=await read(searchRoot+'/receipts/'+name);}
    }
    assert.ok(receipt);assert.equal(receipt.status,200);
    assert.deepEqual(receipt.request,op.request);assert.equal(receipt.inputSha256,op.inputSha256);
    const ranked=rankYoutubeSearchCandidates(youtubeSearchCandidates(receipt.data),record.searchPlan,
      {limit:2,includeTopicChannels:true});
    assert.deepEqual(record.candidates,ranked.candidates);
    directLeads.push({profileId:a.profile_id,cmArtist:a.cm_artist,artist:a.artist,candidates:record.candidates});
  }
  const uploaderResults=[],seen=new Set();let heldResponses=0;
  for(const sourceId of sourceUploaderIds){
    const root='generated-artifacts/'+sourceId,p=await read(root+'/plan.json');
    assertVideoStageApproval(p,await read(root+'/approval.json'));
    await read(root+'/summary.json');
    for(const [name,sha] of Object.entries({...p.evidenceFiles,...p.runtimeFiles}))
      assert.equal(digest(await readBytes(root+'/'+name)),sha);
    for(const file of (await fs.readdir(root+'/receipts')).filter(f=>f.endsWith('.json'))){
      const receipt=await read(root+'/receipts/'+file);
      assert.ok(!seen.has(receipt.operationKey));seen.add(receipt.operationKey);
      const op=p.operations.find(o=>o.key===receipt.operationKey);assert.ok(op);
      const e=await read(root+'/evidence/'+op.profileId+'.json');
      const rawBody=await readBytes(root+'/'+receipt.rawPath);
      const clue=e.videoPlan.resolutionQueue.find(v=>v.videoId===op.videoId);
      const reviewed=mapOrHoldSavedUploader(e.artist,clue,{...receipt,rawBody},
        {runId:p.id,planSha256:digest(p)},{holdConflicts:true});
      if(reviewed.kind==='held_conflict'){heldResponses++;continue;}
      const result=await read(root+'/results/'+digest(op.key)+'.json');
      for(const [key,value] of Object.entries(reviewed.result))assert.deepEqual(result[key],value);
      uploaderResults.push(result);
    }
  }
  assert.equal(seen.size,24);assert.equal(heldResponses,2);
  const input={id,preparedAt:new Date().toISOString(),artists,directLeads,uploaderResults,
    sourceFiles,sourceSearchId,sourceUploaderIds,runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}};
  let plan=mixedCapturePlan(input);
  await identityCatalogCheck(plan)(mixedClaims(plan));
  const pool=await connectSavedBatchPool();let c,readiness;
  try{c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    readiness=await mixedCaptureReadiness(c,plan,{preparationOnly:true});await c.query('COMMIT');
  }catch(error){if(c)await c.query('ROLLBACK');throw error;}finally{c?.release();await pool.end();}
  const root='generated-artifacts/'+id;await fs.mkdir(root);
  const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'run-youtube-mixed-captures.mjs');
  const modules=await freezeLocalModules(entry,root+'/runtime'),runtimeFiles={};
  for(const file of modules){const name='runtime/'+path.basename(file);runtimeFiles[name]=digest(await fs.readFile(root+'/'+name));}
  plan=mixedCapturePlan({...input,runtimeFiles});
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  for(const [name,alternatives] of [
    ['proposed-channel-checks.csv',plan.alternatives.filter(a=>a.disposition==='selected_for_capture')],
    ['deferred-and-held-leads.csv',plan.alternatives.filter(a=>a.disposition!=='selected_for_capture')],
  ]){
    const columns=['artist','tier','profile_id','cm_artist','youtube_url','channel_type_label','disposition','evidence','ownership_accepted','import_eligible'];
    const rows=alternatives.map(a=>[a.artist,a.tier,a.profileId,a.cmArtist,a.url,a.disposition,
      a.observations.map(o=>o.reason).join('; '),false,false]);
    for(let i=0;i<rows.length;i++)rows[i].splice(5,0,
      alternatives[i].observations.some(o=>/\s*[-–—]\s*Topic\s*$/iu.test(o.title??''))
        ?'Topic — auto-generated lead, association unverified':
        alternatives[i].observations.some(o=>o.topicHint)
          ?'YouTube Music lead — channel type unverified':'Uploader — channel type and ownership unverified');
    await durableStageFile(root+'/'+name,'\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
  }
  const summary={status:'prepared_not_approved',id,selectedArtists:plan.selections.length,
    maximumCalls:plan.maximumCalls,maximumSpendCents:plan.maximumSpendCents,
    heldOrDeferred:plan.alternatives.length-plan.selections.length,conflictingResponsesExcluded:heldResponses,
    planSha256:digest(plan),readiness,paidCalls:0,ledgerWrites:0,catalogWrites:0};
  await durableStageFile(root+'/summary.json',JSON.stringify(summary,null,2));return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  assert.equal(args.length,2);assert.ok(args.includes('--prepare-only'));
  const id=args.find(a=>a.startsWith('--id='))?.slice(5);
  console.log(JSON.stringify(await prepareMixedCaptures(id)));
}
