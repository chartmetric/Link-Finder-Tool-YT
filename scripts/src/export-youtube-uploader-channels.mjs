// Export-only: one row per artist/channel; never modify an approved source archive.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {buildVideoUploaderReport} from './youtube-uploader-report.mjs';
import {mapOrHoldSavedUploader,uploaderConflictHandlingApproval} from './youtube-uploader-conflict-handling.mjs';

export async function exportUploaderChannels(sourceRoot,output){
  const source=path.resolve(sourceRoot),destination=path.resolve(output);
  assert.notEqual(source,destination);
  assert.ok(!destination.startsWith(source+path.sep),'Keep historical archives unchanged');
  const read=async name=>JSON.parse(await fs.readFile(path.join(source,name)));
  const plan=await read('plan.json');validateVideoStagePlan(plan);
  const approval=await read('approval.json');
  assertVideoStageApproval(plan,approval);
  const summary=await read('summary.json');
  assert.equal(summary.id,plan.id);assert.equal(summary.status,'completed');
  assert.equal(summary.returnedCalls,plan.operations.length);
  assert.ok(!plan.recovery,'Recovery exports require explicit source mapping');
  const artists=await Promise.all(plan.artists.map(async a=>(await read('evidence/'+a.profileId+'.json')).artist));
  const heldConflicts=[];
  const observations=await Promise.all(plan.operations.map(async op=>{
    const r=await read('results/'+digest(op.key)+'.json');
    assert.equal(r.profileId,op.profileId);assert.equal(r.cmArtist,op.cmArtist);
    assert.equal(r.videoUrl,op.videoUrl);assert.equal(r.ownershipAccepted,false);
    if(r.resultKind==='held_conflict'){
      uploaderConflictHandlingApproval(plan,approval);
      const evidence=await read('evidence/'+op.profileId+'.json');
      const receipt=await read('receipts/'+digest(op.key)+'.json');
      const rawBody=await fs.readFile(path.join(source,'receipts',digest(op.key)+'.raw'));
      const clue=evidence.videoPlan.resolutionQueue.find(v=>v.videoId===op.videoId);
      const replay=mapOrHoldSavedUploader(evidence.artist,clue,{...receipt,rawBody},
        {runId:plan.id,planSha256:digest(plan)},{holdConflicts:true});
      assert.equal(replay.kind,'held_conflict');
      assert.deepEqual(r,{...replay.result,artist:evidence.artist.name,
        tier:plan.artists.find(a=>a.profileId===op.profileId).tier});
      heldConflicts.push(r);
      return null;
    }
    return r;
  }));
  assert.equal(heldConflicts.length,summary.heldConflictCalls??0);
  const results=observations.filter(Boolean);
  const report=buildVideoUploaderReport(artists,results);
  await fs.mkdir(output);
  await fs.writeFile(path.join(output,'youtube-channel-shortlist.csv'),report.candidatesCsv,{flag:'wx'});
  await fs.writeFile(path.join(output,'youtube-channels-excluded.csv'),report.excludedCsv,{flag:'wx'});
  await fs.writeFile(path.join(output,'youtube-channels-all.csv'),report.evidenceCsv,{flag:'wx'});
  if(heldConflicts.length)await fs.writeFile(path.join(output,'held-uploader-conflicts.json'),
    JSON.stringify({note:'No selected channel; excluded from every channel CSV.',heldConflicts},null,2),{flag:'wx'});
  const exported={sourceRunId:plan.id,...report.summary,heldSavedResponses:heldConflicts.length,paidCalls:0,catalogWrites:0,
    note:'Use youtube-channel-shortlist.csv for possible artist channels only; these still require identity verification. youtube-channels-excluded.csv is not a matches list. youtube-channels-all.csv is the audit trail. One row per artist/channel. Historical sources unchanged.'};
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(exported,null,2),{flag:'wx'});
  return exported;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,4,'Supply completed source archive and NEW export directory');
  console.log(JSON.stringify(await exportUploaderChannels(process.argv[2],process.argv[3])));
}
