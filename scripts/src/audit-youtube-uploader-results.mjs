// Offline-only review of saved results. No DB, credential access, or transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {buildVideoUploaderReport} from './youtube-uploader-report.mjs';

async function fingerprint(root){
  const files={};
  async function walk(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink()){
        // Sealed workers contain exactly this dependency link. Record it but
        // never traverse it or fingerprint dependencies outside the archive.
        assert.equal(path.relative(root,file),'runtime/node_modules');
        const target=await fs.readlink(file);
        assert.equal(path.resolve(path.dirname(file),target),path.resolve('scripts/node_modules'));
        files[path.relative(root,file)]='symlink:'+target;
      }else if(entry.isDirectory())await walk(file);
      else{assert.ok(entry.isFile());files[path.relative(root,file)]=digest(await fs.readFile(file));}
    }
  }
  await walk(root);return files;
}
export async function auditSavedUploaderResults(root,out){
  const source=await fs.realpath(root),parent=await fs.realpath(path.dirname(out));
  const destination=path.join(parent,path.basename(out));
  assert.ok(destination!==source&&!destination.startsWith(source+path.sep));
  const before=await fingerprint(source),plan=JSON.parse(await fs.readFile(source+'/plan.json','utf8'));
  const artists=[],planning=[];
  for(const a of plan.artists){
    const file='evidence/'+a.profileId+'.json',bytes=await fs.readFile(source+'/'+file);
    assert.equal(digest(bytes),plan.evidenceFiles[file]);
    const evidence=JSON.parse(bytes);artists.push(evidence.artist);
    const updated=planVideoDiscovery(evidence.artist,evidence.sourceSearchReceipt.data.organic,
      {archivePath:'saved-search/'+a.profileId,receiptSha256:digest(evidence.sourceSearchReceipt)});
    planning.push({artist:a.name,profileId:a.profileId,
      oldVideoIds:evidence.videoPlan.resolutionQueue.map(v=>v.videoId),
      proposedVideoIds:updated.resolutionQueue.map(v=>v.videoId),
      heldVideos:updated.videoClues.filter(v=>!v.eligible).map(v=>({
        videoId:v.videoId,reasons:v.sources.map(s=>s.videoMentionHold).filter(Boolean)}))});
  }
  const results=[];
  for(const file of (await fs.readdir(source+'/results')).filter(f=>f.endsWith('.json')).sort()){
    const result=JSON.parse(await fs.readFile(source+'/results/'+file,'utf8'));
    const receipt=result.rawReceipt;
    assert.ok(receipt&&receipt.profileId===result.profileId&&receipt.cmArtist===result.cmArtist);
    assert.equal(digest(Buffer.from(receipt.rawBodyBase64,'base64')),receipt.rawBodySha256);
    assert.match(receipt.runId,/^youtube-video-review-[a-z0-9-]{4,80}$/);
    const originalRoot=path.join(path.dirname(source),receipt.runId);
    assert.match(receipt.rawPath,/^receipts\/[a-f0-9]{64}\.raw$/);
    assert.equal(digest(await fs.readFile(originalRoot+'/'+receipt.rawPath)),receipt.rawBodySha256);
    const originalPlan=JSON.parse(await fs.readFile(originalRoot+'/plan.json','utf8'));
    assert.equal(digest(originalPlan),receipt.planSha256);
    const op=originalPlan.operations.find(o=>o.key===receipt.operationKey);
    assert.ok(op&&op.profileId===result.profileId&&op.cmArtist===result.cmArtist);
    assert.equal(op.inputSha256,receipt.inputSha256);assert.equal(op.videoUrl,result.videoUrl);
    assert.equal(receipt.status,200);assert.equal(result.ownershipAccepted,false);
    results.push(result);
  }
  const report=buildVideoUploaderReport(artists,results);
  const after=await fingerprint(source);assert.deepEqual(after,before,'Original saved stage changed');
  await fs.mkdir(destination);
  const outputs={
    'review-candidates.csv':report.candidatesCsv,
    'all-uploader-evidence-reviewed.csv':report.evidenceCsv,
    'summary.json':JSON.stringify({...report.summary,offlineOnly:true,paidCalls:0,catalogWrites:0,
      archiveUnchanged:true,originalPlanSha256:digest(plan),planning},null,2),
    'archive-proof.json':JSON.stringify({before,after},null,2),
  };
  for(const [name,bytes] of Object.entries(outputs))await fs.writeFile(destination+'/'+name,bytes,{flag:'wx'});
  return {...report.summary,offlineOnly:true,paidCalls:0,catalogWrites:0,archiveUnchanged:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.equal(args.length,2);
  assert.ok(args.every(a=>/^generated-artifacts\/[a-z0-9-]+$/.test(a)));
  console.log(JSON.stringify(await auditSavedUploaderResults(args[0],args[1])));
}
