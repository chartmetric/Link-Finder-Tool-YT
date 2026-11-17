// Read saved files only. Output is a non-executable comparison, not an approval.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {CLARITY_VERSION,clarifiedOwnershipRequest} from './youtube-ownership-clarity.mjs';

export async function prepareOwnershipClarity(source){
  const read=async name=>JSON.parse(await fs.readFile(source+'/'+name,'utf8'));
  const plan=await read('plan.json'),results=await read('results.json'),summary=await read('summary.json');
  assert.equal(summary.status,'completed');assert.equal(results.length,plan.operations.length);
  const byKey=new Map(results.map(r=>[r.profileId+'|'+r.cmArtist+'|'+r.channelId,r]));
  assert.equal(byKey.size,results.length);
  const proposals=[],sourceChecks=[];
  for(const op of plan.operations){
    const original=byKey.get(op.profileId+'|'+op.cmArtist+'|'+op.channelId);assert.ok(original);
    assert.equal(original.modelAnswer.requestSha256,digest(op.request));
    assert.equal(original.modelAnswer.inputSha256,op.policyInputSha256);
    const draft=clarifiedOwnershipRequest(op,plan.capturePackets[op.key]);
    sourceChecks.push({key:op.key,originalRequestSha256:op.inputSha256,
      originalResultSha256:digest(original)});
    if(original.decision.status!=='needs_identity_check'||!draft.matchingSpotifyIds.length)continue;
    proposals.push({...draft,artist:op.request.body.state.artist.name,
      tier:plan.selections.find(s=>s.profileId===op.profileId&&s.cmArtist===op.cmArtist).tier,
      baseline:{decision:original.decision,modelAnswer:original.modelAnswer},
      interpretation:'Historical baseline only; no new answer or confirmed ownership. This same evidence is being presented differently.'});
  }
  assert.ok(proposals.length);
  return {version:CLARITY_VERSION,source,sourcePlanSha256:digest(plan),
    sourceResultsSha256:digest(results),sourceSummarySha256:digest(summary),
    sourceChecks,proposals,summary:{savedChecksAudited:results.length,proposedComparisons:proposals.length,
      maximumProposedRequestBytes:Math.max(...proposals.map(x=>x.proposedRequestBytes)),
      priorMaximumRequestBytes:Math.max(...proposals.map(x=>x.originalRequestBytes)),
      originalBatchMaximumRequestBytes:plan.maximumRequestBytes,evidencePreserved:true,
      executable:false,modelCalls:0,searchCalls:0,metadataCalls:0,catalogWrites:0,
      newModelAnswers:0,claimsOfImprovedAccuracy:false,
      nextRequirement:'Separately prepare and approve an exact, budget-bound experimental comparison. Existing execution approvals and replay guards do not authorize these changed requests.'}};
}

async function main(){
  assert.deepEqual(process.argv.slice(2),['--prepare-only']);
  const source='generated-artifacts/youtube-saved-model-checks-500-ready-2026-11-17';
  const before=await Promise.all(['plan.json','results.json','summary.json'].map(f=>fs.readFile(source+'/'+f)));
  const report=await prepareOwnershipClarity(source);
  const after=await Promise.all(['plan.json','results.json','summary.json'].map(f=>fs.readFile(source+'/'+f)));
  before.forEach((b,i)=>assert.ok(b.equals(after[i]),'Source archive changed'));
  const out='generated-artifacts/youtube-ownership-clarity-13-ready-2026-11-17';
  await fs.mkdir(out,{recursive:false});
  await fs.writeFile(out+'/proposal.json',JSON.stringify(report,null,2),{flag:'wx'});
  const text=`# YouTube ownership comparison — prepared, not executed

Prepared ${report.proposals.length} revised requests using the same saved evidence.
Every selected channel links to the exact catalog Spotify artist ID.
That supports identity, but is not proof of channel ownership.

Changes: highlight the existing exact account links, clarify that missing badges
are not a veto, distinguish an artist’s affiliations from the channel’s role,
and request a specific reason category for the decision.

No source evidence was removed. No historical answer or active policy changed.
No new searches, captures, model checks, approvals, or catalog writes occurred.
This offline preparation does not establish improved matching accuracy.
A separately prepared and approved comparison is required before paid execution.
Existing non-replay safeguards and completed spending approvals remain unchanged.
`;
  await fs.writeFile(out+'/README.md',text,{flag:'wx'});
  console.log(JSON.stringify({output:out,...report.summary}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(e=>{console.error(e.stack);process.exitCode=1;});
