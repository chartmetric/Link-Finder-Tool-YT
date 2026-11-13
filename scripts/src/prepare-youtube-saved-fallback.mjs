// Offline preparation only. No provider, database, environment or authorization.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {validateStagedSearchPlan,assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';

export async function buildSavedFallback(sourceRoot,{includeDirectChannelCases=false}={}){
  const bytes=new Map();
  async function read(relative){
    const b=await fs.readFile(path.join(sourceRoot,relative));
    bytes.set(relative,digest(b));return JSON.parse(b);
  }
  const source=await read('plan.json'),approval=await read('approval.json');
  const summary=await read('summary.json');
  assert.equal(approval.planSha256,digest(source));
  assert.equal(approval.explicitApproval,true);
  assert.equal(summary.status,'completed');
  assert.equal(summary.id,source.id);
  assert.equal(digest(source.artists),source.scopeSha256);
  if(includeDirectChannelCases){
    validateStagedSearchPlan(source);assertStagedSearchApproval(source,approval);
    assert.equal(summary.artistsSearched,20);assert.equal(summary.reservedCents,40);
    assert.equal(summary.searchOnly,true);assert.equal(summary.catalogWrites,0);
    for(const [file,sha] of Object.entries({...source.evidenceFiles,...source.runtimeFiles})){
      const b=await fs.readFile(path.join(sourceRoot,file));
      assert.equal(digest(b),sha,'Changed sealed search evidence/runtime');
      bytes.set(file,sha);
    }
  }
  const cases=[];
  for(const a of source.artists){
    const record=await read('artists/'+a.profile_id+'.json');
    assert.equal(record.artist.profileId,a.profile_id);
    assert.equal(record.artist.cmArtist,a.cm_artist);
    if(includeDirectChannelCases){
      const packet=source.packets.find(p=>p.profileId===a.profile_id&&p.cmArtist===a.cm_artist);
      assert.deepEqual(record.artist,JSON.parse(JSON.stringify(youtubeArtistFromCatalogPacket(packet))),
        'Changed catalog identity');
      assert.equal(record.artist.name,a.artist);
    }
    // Missing direct captures trigger fallback, never "artist has no channel."
    if(record.candidates.length&&!includeDirectChannelCases)continue;
    const files=(await fs.readdir(path.join(sourceRoot,'receipts'))).filter(f=>f.endsWith('.json'));
    let saved;
    for(const file of files){
      const receipt=JSON.parse(await fs.readFile(path.join(sourceRoot,'receipts',file)));
      if(receipt.kind==='search'&&receipt.operationKey==='search-'+a.profile_id+'-0'){
        assert.equal(saved,undefined,'Duplicate search receipt');
        saved={file,receipt};
      }
    }
    assert.ok(saved,'Missing exact saved search');
    const relative='receipts/'+saved.file,r=await read(relative);
    assert.equal(r.status,200);assert.equal(r.parseFailed,false);
    assert.equal(r.request.method,'POST');
    assert.equal(r.request.url,'https://google.serper.dev/search');
    assert.equal(r.inputSha256,digest(r.request));
    assert.deepEqual(r.request.body,record.searchPlan.request);
    assert.equal(record.searchPlan.profileId,a.profile_id);
    assert.equal(record.searchPlan.cmArtist,a.cm_artist);
    const plan=planVideoDiscovery(record.artist,r.data.organic,{
      archivePath:path.join(sourceRoot,relative),receiptSha256:bytes.get(relative)});
    if(includeDirectChannelCases){
      const op=source.operations.find(o=>o.profileId===a.profile_id);
      assert.deepEqual(r.request,op.request);assert.equal(r.inputSha256,op.inputSha256);
      assert.deepEqual(record.videoPlan,plan,'Changed saved video selection');
    }
    cases.push({artist:record.artist.name,tier:a.tier,profileId:a.profile_id,
      cmArtist:a.cm_artist,sourceOrdinal:a.ordinal,...plan});
  }
  cases.sort((a,b)=>a.tier-b.tier||a.sourceOrdinal-b.sourceOrdinal);
  const operations=cases.flatMap(c=>c.resolutionQueue.map(v=>({...v.operation,
    profileId:c.profileId,cmArtist:c.cmArtist,videoId:v.videoId,videoUrl:v.url})));
  assert.equal(new Set(operations.map(o=>o.key)).size,operations.length);
  const sourceFiles=Object.fromEntries(bytes);
  // Fingerprint the files actually consumed; never alter sealed source archives.
  for(const [file,sha] of bytes)
    assert.equal(digest(await fs.readFile(path.join(sourceRoot,file))),sha);
  return {version:includeDirectChannelCases?'staged-search-video-uploaders-v1':'saved-search-video-fallback-v1',sourceRunId:source.id,
    sourcePlanSha256:digest(source),sourceFiles,cases,operations,
    ...(includeDirectChannelCases?{includesDirectChannelCases:true,sourceArtists:source.artists.length}:{}),
    artistsWithoutDirectCaptures:includeDirectChannelCases?undefined:cases.length,
    artistsWithEligibleVideos:cases.filter(c=>c.resolutionQueue.length).length,
    maximumUploaderRequests:operations.length,
    proposedUploaderReservationCents:operations.length*2,
    reservationPerRequestCents:2,paidCalls:0,catalogWrites:0,
    acceptedLinks:0,executable:false,explicitApproval:false,
    requiresEligibilityRecheck:true,requiresCoordinatorNonReplayCheck:true,
    requiresNewSealedExecutionPlan:true,requiresSeparateIdentityApproval:true,
    inheritsPriorApproval:false,
    warning:'Offline proposal only, not authority to spend. Distribution text is not a confirmed Topic channel. Uploader identity is not artist ownership.'};
}

export async function writeSavedFallback(sourceRoot,output){
  assert.ok(!path.resolve(output).startsWith(path.resolve(sourceRoot)+path.sep));
  assert.notEqual(path.resolve(output),path.resolve(sourceRoot));
  const plan=await buildSavedFallback(sourceRoot);
  await fs.mkdir(output); // Refuse replacement of an existing preparation.
  const rows=plan.cases.flatMap(c=>c.videoClues.map(v=>({
    artist:c.artist,tier:c.tier,profile_id:c.profileId,cm_artist:c.cmArtist,
    video_url:v.url,selected_for_proposal:c.resolutionQueue.some(s=>s.videoId===v.videoId),
    selection_status:c.resolutionQueue.some(s=>s.videoId===v.videoId)?'proposed_uploader_request':
      v.eligible?'deferred_by_two_video_limit':'held_for_weak_or_conflicting_credit',
    title:v.sources[0].title,role_hint:v.sources[0].roleHint,
    hold_reasons:[...new Set(v.sources.map(s=>s.videoMentionHold).filter(Boolean))].join('; '),
    channel_type:'Not captured — distribution text is only a clue',
    ownership_status:'Not checked — no accepted link'
  })));
  const columns=Object.keys(rows[0]??{artist:'',video_url:''});
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;
    return '"'+s.replaceAll('"','""')+'"';};
  await fs.writeFile(path.join(output,'fallback-evidence.csv'),
    '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
  await fs.writeFile(path.join(output,'proposal.json'),JSON.stringify(plan,null,2),{flag:'wx'});
  return plan;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  assert.equal(args.length,2,'Supply saved source archive and NEW output directory');
  const p=await writeSavedFallback(...args);
  console.log(JSON.stringify({artists:p.artistsWithoutDirectCaptures,
    artistsWithEligibleVideos:p.artistsWithEligibleVideos,proposedRequests:p.maximumUploaderRequests,
    proposedUploaderReservationCents:p.proposedUploaderReservationCents,
    paidCalls:0,executable:false,requiresNewSealedExecutionPlan:true}));
}
