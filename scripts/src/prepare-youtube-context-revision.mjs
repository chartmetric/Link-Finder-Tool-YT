// Local-file preparation only; run with youtube-ownership-offline-fence.mjs.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {boundUploaderContext,revisedContextRequest} from './youtube-context-revision.mjs';

assert.deepEqual(process.argv.slice(2),['--prepare-only']);
const source='generated-artifacts/youtube-reviewed-verification-14-ready-2026-11-17';
const destination='generated-artifacts/youtube-context-revision-offline-2026-11-17';
const plan=JSON.parse(await fs.readFile(source+'/plan.json'));
const fingerprints={};
async function read(file){
  assert.ok(file.startsWith('generated-artifacts/')&&!file.split('/').includes('..'));
  const bytes=await fs.readFile(file);fingerprints[file]=digest(bytes);return bytes;
}
await read(source+'/plan.json');await read(source+'/results.json');
const proposals=[];
for(const row of plan.inputs){
  const old=plan.operations.find(o=>o.caseId===row.caseId);
  assert.ok(old);const contexts=[];
  for(const file of row.sourceRefs.filter(f=>f.includes('/results/')&&f.endsWith('.json'))){
    const result=JSON.parse(await read(file));
    const receiptFile=file.replace('/results/','/receipts/');
    const receipt=JSON.parse(await read(receiptFile));
    const rawFile=receiptFile.replace(/\.json$/,'.raw');
    assert.ok(row.sourceRefs.includes(rawFile),'Raw uploader source must be in the saved case');
    contexts.push(boundUploaderContext(row,result,receipt,await read(rawFile)));
  }
  const proposal=revisedContextRequest(old.proposal.originalOperation,row.capture,contexts);
  assert.doesNotMatch(JSON.stringify(proposal.request.body),
    /"(?:userFeedback|userReview|grading|expectedVerdict|labelScope)"\s*:/i);
  proposals.push({caseId:row.caseId,profileId:row.profileId,cmArtist:row.cmArtist,
    artist:row.artist.name,channelId:row.channelId,videoContexts:contexts.length,proposal});
}
assert.equal(proposals.length,14);
for(const [file,sha] of Object.entries(fingerprints))assert.equal(digest(await fs.readFile(file)),sha);
const output={status:'offline_proposals_not_approved',sourceFiles:fingerprints,proposals,
  paidCalls:0,databaseWrites:0,catalogWrites:0,executionEnabled:false,policyActivated:false,
  modelResultsReused:false,ownershipAccuracyScorable:false,
  caveat:'Historical diagnostic examples, not held-out. Added saved uploader context exists for seven previously rejected examples only. This asymmetry must be disclosed; no model improvement has been measured. Existing results and approvals remain unchanged.'};
await fs.mkdir(destination,{recursive:true});
await fs.writeFile(destination+'/proposals.json',JSON.stringify(output,null,2),{flag:'wx'});
console.log(JSON.stringify({status:output.status,examples:proposals.length,
  examplesWithBoundVideoContext:proposals.filter(p=>p.videoContexts).length,
  maximumRequestBytes:Math.max(...proposals.map(p=>p.proposal.requestBytes)),
  paidCalls:0,databaseWrites:0,policyActivated:false,measuredModelImprovement:false}));
