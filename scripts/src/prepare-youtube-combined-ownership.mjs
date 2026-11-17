// Entirely offline preparation, including archived receipt reconstruction.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {comparisonResult} from './youtube-ownership-comparison.mjs';
import {combinedOwnershipRequest,COMBINED_OWNERSHIP_VERSION} from './youtube-combined-ownership.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';

export async function prepareCombinedOwnership(){
  const source='generated-artifacts/youtube-ownership-comparison-13-bounded-2026-11-17';
  const out='generated-artifacts/youtube-combined-ownership-offline-13-2026-11-17';
  try{await fs.stat(out);assert.fail('Fresh offline destination required');}catch(e){if(e.code!=='ENOENT')throw e;}
  const sourceFiles={},read=async name=>{
    const bytes=await fs.readFile(name);sourceFiles[name]=digest(bytes);return JSON.parse(bytes);
  };
  const plan=await read(source+'/plan.json'),results=await read(source+'/results.json');
  const summary=await read(source+'/summary.json'),approval=await read(source+'/approval.json');
  assert.equal(summary.status,'completed');assert.equal(summary.returnedCalls,13);
  assert.equal(plan.operations.length,13);assert.equal(results.length,13);
  assert.equal(approval.planSha256,digest(plan));
  assert.equal(new Set(results.map(r=>r.profileId+'|'+r.cmArtist+'|'+r.channelId)).size,13);
  Object.assign(sourceFiles,plan.sourceFiles);
  for(const [name,sha] of Object.entries(plan.runtimeFiles))sourceFiles[source+'/'+name]=sha;
  const proposals=[];
  for(const op of plan.operations){
    const group=plan.groups.find(g=>g.operations.some(o=>o.key===op.key));assert.ok(group);
    const folder=source+'/part-'+(group.groupIndex+1);
    assert.deepEqual(await read(folder+'/plan.json'),group);
    const receipt=await read(folder+'/receipts/'+digest(op.key)+'.json');
    assert.equal(receipt.approvalSha256,digest(approval));
    assert.equal(receipt.rawPath,'receipts/'+digest(op.key)+'.raw');
    const rawPath=folder+'/'+receipt.rawPath,raw=await fs.readFile(rawPath);sourceFiles[rawPath]=digest(raw);
    const baseline=results.find(r=>r.profileId===op.profileId&&r.cmArtist===op.cmArtist&&r.channelId===op.channelId);
    assert.deepEqual(comparisonResult(plan,op,receipt,raw),baseline,'Preserve the exact historical result');
    const proposal=combinedOwnershipRequest(op.baseline.operation,op.baseline.capture);
    // Preserve every source field from the previous paid presentation as well.
    assert.deepEqual(proposal.request.body.state.artist,op.request.body.state.artist);
    assert.deepEqual(proposal.request.body.state.candidate,op.request.body.state.candidate);
    assert.deepEqual(proposal.request.body.state.evidenceNavigation,op.request.body.state.evidenceNavigation);
    proposals.push({profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,
      artist:baseline.artist,proposal,baseline,
      historicalContradiction:baseline.modelAnswer.answer.verdict==='likely'&&
        baseline.modelAnswer.answer.channelType==='artist_owned'&&
        baseline.modelAnswer.reasonCode==='identity_supported_control_uncertain',
      previousRequestSha256:op.inputSha256,previousRequestBytes:op.requestBytes,
      newModelAnswer:null,interpretation:'A new offline request draft, not a reinterpreted historical answer or an execution approval.'});
  }
  const check=frozenFileVerifier(sourceFiles);await check();
  const report={version:COMBINED_OWNERSHIP_VERSION,source,sourceFiles,proposals,
    summary:{savedResultsAudited:13,proposedRequests:13,
      historicalContradictions:proposals.filter(p=>p.historicalContradiction).length,
      questionsPerRequest:1,previousQuestionsPerRequest:4,
      maximumRequestBytes:Math.max(...proposals.map(p=>p.proposal.requestBytes)),
      evidencePreserved:true,paidCalls:0,catalogWrites:0,ledgerWrites:0,newModelAnswers:0,
      executable:false,approvedForExecution:false,accuracyImprovementMeasured:false,
      warning:'One combined choice prevents disagreement among independent output fields, but does not prove that the selected category is correct. Existing spending approvals do not cover this changed protocol.'}};
  await fs.mkdir(out);
  await fs.writeFile(out+'/proposal.json',JSON.stringify(report,null,2),{flag:'wx'});
  await fs.writeFile(out+'/summary.json',JSON.stringify(report.summary,null,2),{flag:'wx'});
  await check();console.log(JSON.stringify({output:out,...report.summary}));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);
  await prepareCombinedOwnership();
}
