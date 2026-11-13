// Export-only: one row per artist/channel; never modify an approved source archive.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {validateVideoStagePlan,assertVideoStageApproval} from './youtube-video-stage.mjs';
import {buildVideoUploaderReport} from './youtube-uploader-report.mjs';

export async function exportUploaderChannels(sourceRoot,output){
  const source=path.resolve(sourceRoot),destination=path.resolve(output);
  assert.notEqual(source,destination);
  assert.ok(!destination.startsWith(source+path.sep),'Keep historical archives unchanged');
  const read=async name=>JSON.parse(await fs.readFile(path.join(source,name)));
  const plan=await read('plan.json');validateVideoStagePlan(plan);
  assertVideoStageApproval(plan,await read('approval.json'));
  const summary=await read('summary.json');
  assert.equal(summary.id,plan.id);assert.equal(summary.status,'completed');
  assert.equal(summary.returnedCalls,plan.operations.length);
  assert.ok(!plan.recovery,'Recovery exports require explicit source mapping');
  const artists=await Promise.all(plan.artists.map(async a=>(await read('evidence/'+a.profileId+'.json')).artist));
  const results=await Promise.all(plan.operations.map(async op=>{
    const r=await read('results/'+digest(op.key)+'.json');
    assert.equal(r.profileId,op.profileId);assert.equal(r.cmArtist,op.cmArtist);
    assert.equal(r.videoUrl,op.videoUrl);assert.equal(r.ownershipAccepted,false);
    return r;
  }));
  const report=buildVideoUploaderReport(artists,results);
  await fs.mkdir(output);
  await fs.writeFile(path.join(output,'youtube-channel-shortlist.csv'),report.candidatesCsv,{flag:'wx'});
  await fs.writeFile(path.join(output,'youtube-channels-all.csv'),report.evidenceCsv,{flag:'wx'});
  const exported={sourceRunId:plan.id,...report.summary,paidCalls:0,catalogWrites:0,
    note:'One row per catalog artist and canonical channel URL. Videos are supporting evidence only. Historical source files unchanged.'};
  await fs.writeFile(path.join(output,'summary.json'),JSON.stringify(exported,null,2),{flag:'wx'});
  return exported;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,4,'Supply completed source archive and NEW export directory');
  console.log(JSON.stringify(await exportUploaderChannels(process.argv[2],process.argv[3])));
}
