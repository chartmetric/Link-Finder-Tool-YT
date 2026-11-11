import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evidenceDigest,boundYoutubeCapture,youtubeVerificationInput,youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {assembleYoutubeOwnershipEvidence,assertYoutubeCatalogBinding} from './youtube-ownership-evidence.mjs';

const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const bytesHash=b=>createHash('sha256').update(b).digest('hex');
const list=async d=>(await fs.readdir(d)).filter(f=>f.endsWith('.json')).sort();

// There is intentionally no transport, coordinator or database import here.
// Only local files are read; each output is exclusively created.
export async function prepareYoutubeOwnershipEvidence({source,output,catalogFile=null}){
  assert.notEqual(path.resolve(source),path.resolve(output));
  assert.ok(!path.resolve(output).startsWith(path.resolve(source)+path.sep),'Never write within the frozen campaign.');
  // The continuous campaign has its own allowance; do not substitute a smaller
  // pilot's cap or infer permission to raise it from this preparation.
  const {model}=await read(source+'/approval.json');
  assert.equal(model?.endpoint,'https://openrouter.ai/api/alpha/decisions');
  assert.equal(model?.expectedModel,'typesafe/jev-1.13');
  assert.ok(Number.isSafeInteger(model?.maxRequestBytes)&&model.maxRequestBytes>0);
  const supplemental=catalogFile?await read(catalogFile):[];
  assert.ok(Array.isArray(supplemental));
  assert.equal(new Set(supplemental.map(p=>p.profileId)).size,supplemental.length,'Duplicate supplemental artist.');
  const metadataFiles=new Set(await list(source+'/metadata'));
  for(const p of supplemental)assert.ok(metadataFiles.has(p.profileId+'.json'),
    'Supplemental artist is outside the archived catalog scope.');
  await fs.mkdir(output,{recursive:false});
  for(const d of ['originals','artists'])await fs.mkdir(output+'/'+d);
  const manifest=[],receipts=[],inputFiles=[];
  for(const dir of ['artists','inputs','metadata','receipts']){
    await fs.mkdir(output+'/originals/'+dir);
    for(const file of await list(source+'/'+dir)){
      const relative=dir+'/'+file,bytes=await fs.readFile(source+'/'+relative);
      await fs.writeFile(output+'/originals/'+relative,bytes,{flag:'wx'});
      manifest.push({path:relative,bytes:bytes.length,sha256:bytesHash(bytes)});
      const value=JSON.parse(bytes);
      if(dir==='receipts')receipts.push({path:relative,value});
      if(dir==='inputs')inputFiles.push({path:relative,value});
    }
  }
  for(const file of ['approval.json','queue.json','stopped.json','user-pause.json','progress.json','admissions.jsonl']){
    const bytes=await fs.readFile(source+'/'+file);
    await fs.writeFile(output+'/originals/'+file,bytes,{flag:'wx'});
    manifest.push({path:file,bytes:bytes.length,sha256:bytesHash(bytes)});
  }
  const catalogSources=[];
  if(catalogFile){
    const bytes=await fs.readFile(catalogFile);
    await fs.writeFile(output+'/catalog-packets.json',bytes,{flag:'wx'});
    catalogSources.push({source:catalogFile,output:'catalog-packets.json',sha256:bytesHash(bytes)});
    for(const file of ['accountSnapshots.json','releases.json','catalogTracks.json']){
      const sourceFile=path.join(path.dirname(catalogFile),file);
      let bytes;try{bytes=await fs.readFile(sourceFile);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      await fs.writeFile(output+'/catalog-'+file,bytes,{flag:'wx'});
      catalogSources.push({source:sourceFile,output:'catalog-'+file,sha256:bytesHash(bytes)});
    }
  }
  const metadataReceipts=new Map();
  for(const r of receipts.filter(r=>r.value.kind==='metadata')){
    assert.equal(evidenceDigest(r.value.request),r.value.inputSha256,'Archived receipt request hash differs.');
    assert.ok(!metadataReceipts.has(r.value.operationKey),'Duplicate archived operation key.');
    metadataReceipts.set(r.value.operationKey,r);
  }
  const rows=[];
  for(const file of await list(source+'/artists')){
    const original=await read(source+'/artists/'+file),artist=original.artist;
    const baseline=await read(source+'/metadata/'+file);
    assertYoutubeCatalogBinding(artist,baseline);
    const packet=supplemental.find(p=>p.profileId===artist.profileId)??baseline;
    assertYoutubeCatalogBinding(artist,packet);
    if(packet!==baseline)assert.equal(packet.baselineCatalogPacketSha256,evidenceDigest(baseline),'Supplement differs from frozen catalog basis.');
    const candidates=original.candidates.map(c=>{
      const key='channel-'+artist.profileId+'-'+evidenceDigest(youtubeOwnershipUrl(c.url)),receipt=metadataReceipts.get(key);
      assert.ok(receipt,'Missing original metadata receipt for '+key);
      if(c.capture)assert.equal(c.capture.rawReceiptSha256,evidenceDigest(receipt.value),'Capture is not bound to archived receipt.');
      const reconstructed=receipt?normalizeYoutubeChannel(receipt.value,c.url):null;
      const evidence=assembleYoutubeOwnershipEvidence(artist,packet,{...c,capture:reconstructed});
      const proposedArtist={...artist,ownershipEvidence:evidence};
      const proposed=youtubeVerificationInput(proposedArtist,{...c,capture:reconstructed});
      const prepared=proposed.readyForModel?youtubeDecisionRequest(proposed,{model}):null;
      const historicalModelReceipt=c.recordedAnswer?receipts.find(r=>
        evidenceDigest(r.value)===c.recordedAnswer.receiptSha256):null;
      if(c.recordedAnswer){
        assert.ok(historicalModelReceipt,'Missing original model receipt.');
        assert.equal(evidenceDigest(historicalModelReceipt.value.request),c.recordedAnswer.requestSha256);
        assert.equal(c.metadataActuallyUsed.inputSha256,c.recordedAnswer.inputSha256);
      }
      return {url:c.url,originalCandidate:c,originalModelReceipt:historicalModelReceipt,
        metadataReceipt:receipt??null,reconstructedCapture:reconstructed,
        legacyCaptureRecovered:!boundYoutubeCapture(c.url,c.capture)&&!!reconstructed,
        observedEvidence:evidence,
        proposedInput:{label:'offline_proposal_never_sent',value:proposed,
          originalAnswerNotApplicable:true,requestBytes:prepared?.bytes??null,
          requestSha256:prepared?.inputSha256??null,
          withinExistingByteLimit:prepared?.ready??false},
        originalDecision:c.decision,proposedDecision:null,verificationRerun:false,liveLinkAccepted:false};
    });
    const row={profileId:artist.profileId,cmArtist:artist.cmArtist,name:artist.name,
      originalRecord:original,catalogPacket:packet,originalInputFiles:inputFiles.filter(f=>f.path.startsWith('inputs/'+artist.profileId+'-')),
      nonaccepted:!original.candidates.some(c=>c.decision?.reviewSuggestion),
      unresolved:original.candidates.some(c=>c.decision?.reason==='recorded_model_uncertain_or_unresolved_channel_type'),
      candidates};
    rows.push(row);
  }
  // Scope/reuse is computed across every saved occurrence, not just held artists.
  const owners=new Map();
  for(const r of rows)for(const c of r.candidates){
    const keys=boundYoutubeCapture(c.url,c.reconstructedCapture)?.aliases??[youtubeOwnershipUrl(c.url)].filter(Boolean);
    for(const key of keys){if(!owners.has(key))owners.set(key,new Set());owners.get(key).add(r.profileId);}
  }
  for(const row of rows){
    for(const c of row.candidates){
      const keys=boundYoutubeCapture(c.url,c.reconstructedCapture)?.aliases??[youtubeOwnershipUrl(c.url)].filter(Boolean);
      c.reusedAcrossCatalogArtists=keys.some(k=>owners.get(k).size>1);
      c.exclusionsPreserved={originalReason:c.originalDecision?.reason??null,
        reusedChannel:c.reusedAcrossCatalogArtists,policyUnchanged:true,
        note:'No new decision was made. Topic/fan/organization/Spotify conflicts remain excluded by existing policy.'};
    }
    await fs.writeFile(output+'/artists/'+row.profileId+'.json',JSON.stringify(row),{flag:'wx'});
  }
  const all=rows.flatMap(r=>r.candidates),recovered=rows.filter(r=>r.candidates.some(c=>c.legacyCaptureRecovered));
  const targeted=rows.filter(r=>r.nonaccepted&&r.unresolved);
  const summary={mode:'offline_preparation_only',artists:rows.length,candidateOccurrences:all.length,
    nonacceptedUnresolvedArtists:targeted.length,
    likelyUnknownRoleCandidates:all.filter(c=>c.originalCandidate.recordedAnswer?.answer.verdict==='likely'
      &&c.originalCandidate.recordedAnswer?.answer.channelType==='unknown').length,
    recoveredCaptures:all.filter(c=>c.legacyCaptureRecovered).length,recoveredArtists:recovered.length,
    newlyUsableArtists:rows.filter(r=>!r.candidates.some(c=>boundYoutubeCapture(c.url,c.originalCandidate.capture))
      &&r.candidates.some(c=>c.reconstructedCapture)).length,
    declarations:all.reduce((n,c)=>n+c.observedEvidence.declarations.length,0),
    artistsWithDeclarations:rows.filter(r=>r.candidates.some(c=>c.observedEvidence.declarations.length)).length,
    artistsWithMusicIds:rows.filter(r=>r.candidates.some(c=>c.observedEvidence.musicIds.length)).length,
    artistsWithReleaseFacts:rows.filter(r=>r.candidates.some(c=>c.observedEvidence.releases.length)).length,
    targetedArtistsWithMusicIds:targeted.filter(r=>r.candidates.some(c=>c.observedEvidence.musicIds.length)).length,
    targetedArtistsWithReleaseFacts:targeted.filter(r=>r.candidates.some(c=>c.observedEvidence.releases.length)).length,
    channelAttributedVideos:all.reduce((n,c)=>n+c.observedEvidence.channelAttributedVideos.length,0),
    existingRequestByteLimit:model.maxRequestBytes,
    proposedRequestsOverExistingLimit:all.filter(c=>c.proposedInput.requestBytes>model.maxRequestBytes).length,
    originalInputFiles:inputFiles.length,originalReceipts:receipts.length,
    paidCalls:0,sourceFetches:0,modelCalls:0,acceptancesChanged:0,campaignResumed:false};
  const scope=targeted.flatMap(r=>r.candidates.map(c=>({profileId:r.profileId,cmArtist:r.cmArtist,url:c.url,
    proposedInputSha256:c.proposedInput.value.inputSha256,originalInputSha256:c.originalCandidate.metadataActuallyUsed?.inputSha256??null,
    proposedRequestSha256:c.proposedInput.requestSha256,requestBytes:c.proposedInput.requestBytes,
    evidenceSha256:evidenceDigest(c.observedEvidence),
    referenceTargets:(r.originalRecord.artist.accounts??[]).filter(a=>
      String(a.profile_id)===r.profileId&&String(a.cm_artist)===r.cmArtist&&a.wasInFrozenBatch===true)
      .map(a=>({catalogAccountId:String(a.account_id),platform:a.platform,sourceUrl:a.account_url,
        sourceUpdatedAt:a.source_updated_at,action:'proposed_reference_capture_not_executed'})),
    videoTarget:{channelId:c.reconstructedCapture?.body.channelId??null,channelUrl:c.url,
      action:'proposed_channel_attributed_video_capture_not_executed'},
    historicalExclusion:['related_catalog_channel','not_artist_owned','ownership_conflict'].includes(c.originalDecision?.status),
    originalReason:c.originalDecision?.reason??null,reusedAcrossCatalogArtists:c.reusedAcrossCatalogArtists})));
  const plan={version:1,status:'unexecuted_requires_separate_explicit_approval',executable:false,
    scope,scopeSha256:evidenceDigest(scope),sourceManifestSha256:evidenceDigest({manifest,catalogSources}),
    approvalRequiredFor:['Exact reference-page URLs and accounts, videos and candidate scope',
      'Budget cap, provider limits, fresh eligibility and shared-spending reconciliation',
      'Model, rules, transport, request hashes and request size; no threshold change',
      'Exclusive non-replayable admissions; preserve every original answer alongside comparisons',
      'Separate authorization for any campaign resume or catalog write'],
    stages:['Review exact bound catalog declarations offline; catalog links are not independently verified.',
      'Only after approval, capture references that can explicitly declare these candidate aliases.',
      'Only after approval, capture videos with explicit publishing channel IDs; do not use snippets as videos.',
      'Rebuild and bind exact requests, then seek approval for model comparison under existing exclusions.',
      'Report ownership quality separately from operational success; no acceptance or recovery merge is authorized.'],
    model:{...model,thresholdsUnchanged:true},
    estimatedSpendUsd:null,approvedBudgetUsd:null,approved:false};
  const report=[
    '# Offline YouTube ownership evidence preparation',
    '',
    'The campaign remains paused. No paid calls, new source fetches, model evaluations, recovery merges, catalog writes or acceptance changes were performed.',
    '',
    '## Scope and preservation',
    `- ${summary.artists} completed artists, ${summary.candidateOccurrences} candidate occurrences.`,
    `- ${summary.nonacceptedUnresolvedArtists} nonaccepted artists have unresolved candidates; ${summary.likelyUnknownRoleCandidates} likely verdicts still have unknown channel role.`,
    `- Preserved all ${summary.originalInputFiles} original candidate input files and ${summary.originalReceipts} full provider receipts byte-for-byte, plus all completed artist records and catalog packets.`,
    '- Original answers and complete outgoing model requests remain under originals; reconstructed inputs have no attached answers or proposed decisions. The source manifest records exact file hashes and was rechecked after preparation.',
    '',
    '## Actual observations from saved material',
    `- Reconstructed ${summary.recoveredCaptures} usable legacy channel captures for ${summary.recoveredArtists} artists using the merged URL resolver. ${summary.newlyUsableArtists} artists previously had no usable capture.`,
    '- One formerly rejected capture remains unbound. Recovered metadata is not ownership proof, a fresh capture or acceptance.',
    `- ${summary.artistsWithMusicIds} artists have exact catalog Spotify artist IDs; ${summary.artistsWithReleaseFacts} have release facts with available Spotify track/album IDs, catalog track IDs or ISRCs.`,
    `- Within the unresolved nonaccepted cohort: ${summary.targetedArtistsWithMusicIds} artists have music IDs and ${summary.targetedArtistsWithReleaseFacts} have release facts.`,
    `- ${summary.artistsWithDeclarations} artists have eligible source-bound YouTube declarations in the material examined; ${summary.channelAttributedVideos} attributable video records were available.`,
    '- Account-level catalog snapshots were bound by exact artist/catalog account ID and platform. Profile/platform-only bios, resolved profile metadata, search snippets, and unresolved shortened links are retained separately. They are not official source-page captures.',
    '- Read-only catalog exports retain their SQL, observation time and source update times. Existing linked catalog accounts are not independently verified official ownership.',
    '- Saved Instagram reference receipts were checked only against exact frozen catalog accounts, requested/returned handles and artist occurrences; unbound search candidates were not promoted to official accounts.',
    '- No missing Official Artist Channel or auto-generation field is inferred false. Generic verification is not an Official Artist Channel badge.',
    '',
    '## Proposed inputs, not observed improvements',
    `- All reconstructed/supplemented requests are marked offline proposals; ${summary.proposedRequestsOverExistingLimit} exceed the unchanged ${model.maxRequestBytes}-byte campaign request cap and remain held.`,
    '- Original scores and likely/unknown role holds are unchanged. No threshold has been lowered; no old answer is attributed to new evidence.',
    '- Topic, fan, organization, conflicting Spotify identity and reused-channel exclusions are preserved. Cross-artist reuse is checked across all reconstructed aliases, not only the target subset.',
    '',
    '## Approval boundary',
    '- approval-plan.json is unexecuted and non-executable, with no approved budget. It binds exact artist/candidate scope, catalog reference URLs, video channel targets, evidence/input/request hashes and the source manifest.',
    '- Any reference fetch, video fetch or model comparison needs separately reviewed exact requests, a capped budget, current eligibility, spending reconciliation, frozen code/rules and non-replayable admissions.',
    '- Requests above the cap cannot be sent. Reference/video additions would change hashes and require a new approval. Approval of evidence collection is not approval to resume the campaign, merge a recovery or change live catalog links.',
    '',
    '## Recovered metadata only',
    '| Artist | Profile | Recoverable captures |',
    '| --- | --- | ---: |',
    ...recovered.map(r=>`| ${r.name.replaceAll('|','/').replaceAll('\\n',' ')} | ${r.profileId} | ${r.candidates.filter(c=>c.legacyCaptureRecovered).length} |`),
    '',
  ].join('\n');
  await fs.writeFile(output+'/review.md',report,{flag:'wx'});
  const escaped=report.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  await fs.writeFile(output+'/review.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline YouTube ownership evidence</title><style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><pre>'+escaped+'</pre></html>',{flag:'wx'});
  await fs.writeFile(output+'/manifest.json',JSON.stringify({source,files:manifest,catalogSources,summary,planSha256:evidenceDigest(plan)},null,2),{flag:'wx'});
  await fs.writeFile(output+'/approval-plan.json',JSON.stringify(plan,null,2),{flag:'wx'});
  await fs.writeFile(output+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
  // Assert original bytes after assembling; reconstruction never edits frozen files.
  for(const f of manifest)assert.equal(bytesHash(await fs.readFile(source+'/'+f.path)),f.sha256,'Frozen source changed during preparation.');
  for(const f of catalogSources)assert.equal(bytesHash(await fs.readFile(f.source)),f.sha256,'Supplemental source changed during preparation.');
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(![4,5].includes(process.argv.length))throw Error('Use SOURCE OUTPUT [CATALOG_PACKETS]; no execution flags supported.');
  console.log(JSON.stringify(await prepareYoutubeOwnershipEvidence({source:process.argv[2],output:process.argv[3],catalogFile:process.argv[4]??null})));
}
