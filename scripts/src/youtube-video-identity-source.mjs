// Offline receipt verification. No provider, database or campaign runner imports.
import assert from 'node:assert/strict';
import {TextDecoder} from 'node:util';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';

export function identityArchivePath(name){
  assert.ok(typeof name==='string'&&/^[A-Za-z0-9_./-]+$/.test(name)
    &&!name.startsWith('/')&&!name.split('/').some(p=>['','.','..'].includes(p)),
  'Unsafe archive path');
  return name;
}
export function identityBytes(base64){
  assert.equal(typeof base64,'string');
  const bytes=Buffer.from(base64,'base64');
  assert.equal(bytes.toString('base64'),base64,'Original bytes must use canonical base64');
  return bytes;
}
export const identityJson=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
export function sourceFile(source,name){
  identityArchivePath(name);
  assert.ok(Object.hasOwn(source.files,name),'Missing immutable source file: '+name);
  return identityBytes(source.files[name]);
}

// Reconstruct discoveries from original response bytes, never from editable results.
export function verifyIdentityUploaderSource(source){
  const plan=identityJson(sourceFile(source,'plan.json'));
  validateVideoStagePlan(plan);
  const approval=identityJson(sourceFile(source,'approval.json'));
  assertVideoStageApproval(plan,approval);
  const summary=identityJson(sourceFile(source,'summary.json'));
  assert.equal(summary.id,plan.id);assert.equal(summary.status,'completed','Uploader stage has not completed');
  assert.equal(summary.returnedCalls,plan.operations.length);
  for(const [name,hash] of Object.entries({...plan.evidenceFiles,...plan.runtimeFiles}))
    assert.equal(digest(sourceFile(source,name)),hash,'Changed source evidence/runtime: '+name);
  const parent=identityJson(sourceFile(source,'evidence/source-plan.json'));
  assert.equal(digest(parent),plan.sourcePlanSha256);assert.equal(parent.id,plan.sourceRunId);
  const artists=plan.artists.map(a=>{
    const name='evidence/'+a.profileId+'.json';
    assert.ok(Object.hasOwn(plan.evidenceFiles,name));
    const e=identityJson(sourceFile(source,name));
    assert.equal(e.artist.profileId,a.profileId);assert.equal(e.artist.cmArtist,a.cmArtist);
    assert.equal(e.artist.name,a.name);
    assert.deepEqual(youtubeArtistFromCatalogPacket(e.catalogPacket),e.artist,'Catalog identity/context changed');
    assert.ok(parent.artists.some(p=>p.profile_id===a.profileId&&p.cm_artist===a.cmArtist));
    const searchBytes=identityBytes(e.sourceSearchReceiptBytesBase64);
    const search=identityJson(searchBytes);
    assert.deepEqual(search,e.sourceSearchReceipt);
    assert.equal(search.operationKey,'search-'+a.profileId+'-0');
    assert.equal(search.kind,'search');assert.equal(search.status,200);
    assert.equal(search.inputSha256,digest(search.request));
    const provenance=e.videoPlan.resolutionQueue[0]?.sources[0];
    assert.ok(provenance);
    assert.equal(provenance.receiptSha256,digest(searchBytes));
    identityArchivePath(provenance.archivePath);
    assert.deepEqual(planVideoDiscovery(e.artist,search.data.organic,{
      receiptSha256:digest(searchBytes),archivePath:provenance.archivePath}),e.videoPlan);
    const operations=plan.operations.filter(o=>o.profileId===a.profileId);
    assert.deepEqual(operations.map(o=>o.key),e.videoPlan.resolutionQueue.map(v=>v.operation.key));
    return {...a,artist:e.artist,catalogPacket:e.catalogPacket,evidenceSha256:digest(sourceFile(source,name)),
      clues:e.videoPlan.resolutionQueue};
  });
  const observations=plan.operations.map((op,index)=>{
    const a=artists.find(a=>a.profileId===op.profileId);
    const receiptPath='receipts/'+digest(op.key)+'.json';
    const receiptBytes=sourceFile(source,receiptPath),receipt=identityJson(receiptBytes);
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const rawBody=sourceFile(source,receipt.rawPath);
    const clue=a.clues.find(v=>v.videoId===op.videoId);assert.ok(clue);
    assert.deepEqual(clue.operation.request,op.request);
    const mapped=mapSavedVideoUploader(a.artist,clue,{...receipt,rawBody},{
      runId:plan.id,planSha256:digest(plan)});
    return {profileId:op.profileId,cmArtist:op.cmArtist,sourceOperationIndex:index,
      videoId:op.videoId,videoUrl:op.videoUrl,channelId:mapped.canonicalMapping.uploader.channelId,
      url:mapped.url,uploaderName:mapped.uploaderName,providerAliases:mapped.providerAliases,
      sources:mapped.sources,discoveryRoleHint:mapped.discoveryRoleHint,
      receiptPath,receiptFileSha256:digest(receiptBytes),receiptSha256:digest(receipt),
      rawPath:receipt.rawPath,rawBodySha256:digest(rawBody),
      inputSha256:op.inputSha256,ownershipEvidence:false};
  });
  return {id:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
    summarySha256:digest(sourceFile(source,'summary.json')),artists,observations,
    filesSha256:Object.fromEntries(Object.keys(source.files).sort().map(name=>[name,digest(sourceFile(source,name))]))};
}
