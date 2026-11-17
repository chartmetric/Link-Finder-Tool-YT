// Read-only databases and saved evidence only; no paid transports or approvals.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,SMALL_VIDEO_STAGE_POLICY,archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE} from './youtube-uploader-conflict-handling.mjs';
import {sparseUploaderPlan} from './youtube-sparse-uploader-plan.mjs';
import {SPARSE_ID,SPARSE_SOURCE,sparseSources,assertSourceFiles,
  uploaderCoordinatorSnapshot,validateSparseReceipts,uploaderIdleBlockers,historicalUploaderConflict} from './youtube-sparse-uploader-source.mjs';
import {currentEligible} from './run-youtube-video-stage.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
import {durableStageFile} from './youtube-video-stage-execution.mjs';
const root='generated-artifacts/'+SPARSE_ID;
const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
const csv=rows=>'\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
async function freeze(folder){
  const modules=await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-sparse-uploaders.mjs'),folder+'/runtime'),hashes={};
  for(const f of modules){const name='runtime/'+path.basename(f);hashes[name]=digest(await fs.readFile(folder+'/'+name));}
  return hashes;
}
export function selectSparseCases(sources,history,eligible){
  return sources.cases.map(c=>({...c,disposition:c.directSelected?'deferred_direct_capture_selected':
    !c.resolutionQueue.length?'deferred_no_saved_video_request':
    historicalUploaderConflict(c,history)?'deferred_historical_uploader_allocation':
    !eligible.has(c.profileId)?'deferred_current_catalog_eligibility':
    'proposed_saved_uploader_discovery'}));
}
export async function prepareSparseUploaders(){
  try{await fs.lstat(root);assert.fail('Fresh preparation required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sources=await sparseSources();
  const candidates=sources.cases.filter(c=>!c.directSelected&&c.resolutionQueue.length);
  const eligible=await currentEligible(candidates.map(c=>({profileId:c.profileId,cmArtist:c.cmArtist,name:c.artist})));
  const pool=await connectSavedBatchPool();let client,snapshot,blockers;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    blockers=await uploaderIdleBlockers(client);
    snapshot=await uploaderCoordinatorSnapshot(client);await validateSparseReceipts(sources,snapshot);
    await client.query('COMMIT');
  }catch(e){if(client)await client.query('ROLLBACK');throw e;}
  finally{client?.release();await pool.end();}
  const cases=selectSparseCases(sources,snapshot.history,eligible);
  const chosen=cases.filter(c=>c.disposition==='proposed_saved_uploader_discovery')
    .sort((a,b)=>eligible.get(a.profileId).tier-eligible.get(b.profileId).tier||a.sourceOrdinal-b.sourceOrdinal);
  assert.ok(chosen.length,'No eligible untouched saved-video fallback');
  await fs.mkdir(root);await fs.mkdir(root+'/evidence');
  const evidenceFiles={};
  const save=async(folder,hashes,name,value)=>{
    const raw=JSON.stringify(value);await durableStageFile(folder+'/'+name,raw);hashes[name]=digest(raw);
  };
  await save(root,evidenceFiles,'evidence/source-bindings.json',sources);
  await save(root,evidenceFiles,'evidence/readiness.json',{observedAt:new Date().toISOString(),snapshot,blockers,
    eligibility:[...eligible.values()],paidCalls:0,ledgerWrites:0,catalogWrites:0});
  // Includes direct/Topic/distributor clues, held credits, snippets and every deferred video.
  await save(root,evidenceFiles,'evidence/all-dispositions.json',cases);
  const children=[];
  // Keep bounded unchanged small-stage policies. Never widen old validators or DB limits.
  for(let offset=0;offset<chosen.length;offset+=20){
    const group=chosen.slice(offset,offset+20),id=`youtube-video-review-sparse-100-2026-11-16-part-${children.length+1}`;
    const folder='generated-artifacts/'+id;await fs.mkdir(folder);
    for(const dir of ['evidence','receipts','inputs','results'])await fs.mkdir(folder+'/'+dir);
    const hashes={};
    await save(folder,hashes,CONFLICT_HANDLING_FILE,CONFLICT_HANDLING_SCOPE);
    await save(folder,hashes,'evidence/bundle-binding.json',{id:SPARSE_ID,sourceId:SPARSE_SOURCE,
      sourcePlanSha256:digest(sources.parent),sourceBindingsSha256:evidenceFiles['evidence/source-bindings.json']});
    for(const c of group){
      const sourceRoot='generated-artifacts/'+c.sourceId;
      const record=JSON.parse(await fs.readFile(sourceRoot+'/artists/'+c.profileId+'.json'));
      const raw=await fs.readFile(sourceRoot+'/receipts/'+archivedSearchReceiptName(c.profileId));
      await save(folder,hashes,'evidence/'+c.profileId+'.json',{artist:record.artist,videoPlan:record.videoPlan,
        catalogPacket:c.catalogPacket,sourceArtist:c.sourceArtist,sourceRunId:c.sourceId,
        sourceSearchReceipt:JSON.parse(raw),sourceSearchReceiptBytesBase64:raw.toString('base64')});
    }
    const plan=videoStagePlan({version:SMALL_VIDEO_STAGE_POLICY,id,preparedAt:new Date().toISOString(),
      sourceRunId:SPARSE_SOURCE,sourcePlanSha256:digest(sources.parent),
      artists:group.map(c=>eligible.get(c.profileId)),
      operations:group.flatMap(c=>c.resolutionQueue.map(v=>({...v.operation,profileId:c.profileId,
        cmArtist:c.cmArtist,videoId:v.videoId,videoUrl:v.url}))),
      evidenceFiles:hashes,runtimeFiles:await freeze(folder)});
    await durableStageFile(folder+'/plan.json',JSON.stringify(plan,null,2));children.push({id,plan});
  }
  const plan=sparseUploaderPlan({id:SPARSE_ID,preparedAt:new Date().toISOString(),
    sourcePlanSha256:digest(sources.parent),children,evidenceFiles,runtimeFiles:await freeze(root)});
  await assertSourceFiles(sources.sourceFiles);
  await durableStageFile(root+'/plan.json',JSON.stringify(plan,null,2));
  const rows=chosen.flatMap(c=>c.resolutionQueue.map(v=>[c.artist,eligible.get(c.profileId).tier,c.profileId,
    c.cmArtist,c.sourceId,v.url,v.sources[0].title,v.sources.map(s=>s.roleHint).join('; '),
    v.operation.request.url,digest(v.operation.request),2,false,false]));
  await durableStageFile(root+'/proposed-uploader-requests.csv',csv([
    ['artist','current_tier','profile_id','cm_artist','source_search_cohort','saved_video_url','saved_title',
      'discovery_role_hints','exact_request_url','request_sha256','reservation_cents','ownership_accepted','import_eligible'],...rows]));
  const allRows=cases.flatMap(c=>c.videoClues.length?c.videoClues.map(v=>[c.artist,c.profileId,c.cmArtist,v.url,
    c.disposition==='proposed_saved_uploader_discovery'&&c.resolutionQueue.some(s=>s.videoId===v.videoId)
      ?'proposed_saved_uploader_discovery':c.disposition==='proposed_saved_uploader_discovery'
        ?v.eligible?'deferred_two_video_limit':'held_weak_or_conflicting_credit':c.disposition,
    v.sources.map(s=>s.roleHint).join('; '),v.sources.map(s=>s.videoMentionHold).filter(Boolean).join('; '),false,false]):
    [[c.artist,c.profileId,c.cmArtist,'',c.disposition,'','',false,false]]);
  await durableStageFile(root+'/all-video-dispositions.csv',csv([
    ['artist','profile_id','cm_artist','saved_video_url','disposition','role_hints','holds','ownership_accepted','import_eligible'],...allRows]));
  const result={id:SPARSE_ID,status:'prepared_not_approved',originalArtists:100,excludedDirectArtists:55,
    savedVideoArtists:24,proposedArtists:chosen.length,deferredVideoArtists:24-chosen.length,
    historicalUploaderAllocations:snapshot.history.length,requests:plan.maximumCalls,
    maximumAdditionalCents:plan.maximumSpendCents,planSha256:digest(plan),
    paidCalls:0,searchReplays:0,ledgerWrites:0,catalogWrites:0,approvedArtistChannels:0,
    executionBlockers:blockers,channelAndIdentityApprovalRequired:true};
  await durableStageFile(root+'/preparation.json',JSON.stringify(result,null,2));
  await durableStageFile(root+'/readiness.md',[
    '# Saved-video uploader fallback — awaiting approval','',
    `${chosen.length} of 24 saved-video artists; ${plan.maximumCalls} exact GET requests; new maximum $${(plan.maximumSpendCents/100).toFixed(2)}.`,
    `Plan SHA-256: ${digest(plan)}`,'',
    `Execution blockers at preparation: ${blockers.length?JSON.stringify(blockers):'none'}. Preparation does not clear or acknowledge them.`,
    'Five completed search cohorts and all 100 acknowledged receipt/catalog bindings checked. No searches repeated.',
    'The original 55 direct-capture selections and all historical uploader identities/videos are excluded.',
    'At most two saved videos per artist; a supported Topic/distributor slot is retained within that limit.',
    'All alternatives, held credits, direct clues and deferred evidence are preserved in the frozen evidence.',
    'Known fully validated, validly billed uploader-ID conflicts are held without choosing a channel; untouched requests may continue.',
    'Malformed responses, unknown billing, missing IDs and bad video bindings still stop dispatch. No retries.',
    'No paid calls or database writes were made. No approval was created.',
    'Uploaders are discovery only, never approved artist channels. Exact channel and identity requests require subsequent approval.',
    'Execution must use the frozen runtime with this exact plan hash and cap, following fresh eligibility and locked non-replay checks.',
  ].join('\n'));
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);console.log(JSON.stringify(await prepareSparseUploaders()));
}
