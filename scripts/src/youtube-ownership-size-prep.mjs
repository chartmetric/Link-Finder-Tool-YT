// Offline-only allowance proposal. No network, database, credentials or dispatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {assertNoGradingInputs} from './instagram-corroborated-policy.mjs';
import {
  evidenceDigest,youtubeOwnershipUrl,youtubeVerificationInput,reviewYoutubeBatch,
} from './youtube-ownership-policy.mjs';
import {
  normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision,
} from './youtube-ownership-transport.mjs';

const defaultRoot='generated-artifacts/youtube-no-link-20-usd2';
const outputName='ownership-size-preparation';
const rawHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const keyFor=(profileId,url)=>'youtube-model-'+evidenceDigest([profileId,youtubeOwnershipUrl(url)]);

// Deliberately list source fields. Envelope review flags (ownershipConfirmed,
// safeForImport, verificationRerun) and historical outcomes never enter a request.
export function sourceArtist(packet){
  const p=packet;
  return {profileId:p.profileId,cmArtist:p.cmArtist,name:p.artist,catalogProfile:p.catalogProfile,
    country:p.chartmetric?.code2??null,label:p.chartmetric?.label??p.chartmetric?.record_label??null,
    accounts:p.linkedAccounts.filter(a=>a.platform!=='youtube'),releases:[...p.releases,...p.catalogTracks],
    context:{chartmetric:p.chartmetric,tags:p.tags,spotify:p.spotifyMetadata,
      platformSnapshots:p.platformSnapshots.filter(s=>s.platform!=='youtube'),profileMetadata:p.profileMetadata,
      warning:'Catalog context is not independently verified ownership; profile/platform snapshots are not account-bound captures.'}};
}

export function auditYoutubeModelInput({prepared,savedInput,artist,capture,plan}){
  const s=savedInput.state.candidate.searchEvidence;
  const candidate={url:savedInput.url,title:s.title,snippet:s.snippet,sourceUrl:s.sourceUrl,capture};
  const before=youtubeVerificationInput(artist,{...candidate,capture:null});
  assert.equal(before.inputSha256,savedInput.inputSha256,'Saved catalog/search evidence changed.');
  assert.deepEqual(before.state,savedInput.state);
  const input=youtubeVerificationInput(artist,candidate);
  assertNoGradingInputs(input);
  assert.equal(prepared.profileId,input.state.artist.profileId);
  assert.equal(prepared.url,savedInput.url);
  assert.equal(youtubeOwnershipUrl(prepared.url),input.state.candidate.url);
  assert.equal(prepared.key,keyFor(prepared.profileId,prepared.url));
  assert.equal(prepared.inputSha256,input.inputSha256,'Wrong evidence fingerprint.');
  const expected=youtubeDecisionRequest(input,plan);
  assert.deepEqual(prepared.request,expected.request,'Evidence, rules or typed questions changed.');
  assert.equal(prepared.requestSha256,expected.inputSha256);
  assert.equal(prepared.bytes,expected.bytes,'Count complete UTF-8 body bytes, not characters.');
  if(expected.ready){
    assert.equal(prepared.readyForDispatch,true);assert.equal(prepared.reason,undefined);
  }else{
    assert.equal(prepared.maximumBytes,plan.model.maxRequestBytes);
    assert.equal(prepared.reason,'model_request_exceeds_approved_byte_limit');
    assert.equal(prepared.readyForDispatch,undefined);
  }
  return {input,expected};
}

async function inventory(root,relative=''){
  const entries=await fs.readdir(path.join(root,relative),{withFileTypes:true}),files=[];
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(!relative&&entry.name===outputName)continue;
    const name=path.posix.join(relative,entry.name);
    assert.ok(!entry.isSymbolicLink(),'Evidence inventory cannot follow symlinks.');
    if(entry.isDirectory())files.push(...await inventory(root,name));
    else{
      assert.ok(entry.isFile());
      const bytes=await fs.readFile(path.join(root,name));
      files.push({path:name,bytes:bytes.length,sha256:rawHash(bytes)});
    }
  }
  return files;
}
export async function assertYoutubeArchiveUnchanged(root,files){
  assert.deepEqual(await inventory(root),files,'Archived evidence changed during offline preparation.');
}

export async function prepareYoutubeSizeAllowance(root=defaultRoot){
  const files=await inventory(root);
  const read=async name=>JSON.parse(await fs.readFile(path.join(root,name),'utf8'));
  const execution='ownership-check-execution';
  const stored=await read('ownership-check-preparation/plan.json');
  const {planSha256,...plan}=stored;
  assert.equal(evidenceDigest(plan),planSha256);
  assert.equal(plan.model.maxRequestBytes,6000);
  const approval=await read('approval.json'),summary=await read(execution+'/summary.json');
  const inputs=await read('ownership-review-ready/verification-inputs.json');
  const overlay=await read('ownership-review-ready/catalog-evidence.json');
  assert.equal(approval.scopeSha256,evidenceDigest(approval.scope));
  assert.equal(approval.capCents,200);
  assert.equal(evidenceDigest(approval),plan.sourceFiles.approvalSha256);
  assert.equal(evidenceDigest(await read('summary.json')),plan.sourceFiles.summarySha256);
  assert.equal(evidenceDigest(inputs),plan.sourceFiles.verificationInputsSha256);
  assert.equal(evidenceDigest(overlay),plan.sourceFiles.catalogEvidenceSha256);
  assert.equal(summary.status,'completed');
  assert.equal(summary.budget.status,'completed');
  assert.equal(summary.budget.uncertain_calls,0);
  const authorization=await read(execution+'/authorization.json');
  assert.equal(authorization.planSha256,planSha256);
  assert.equal(authorization.parentId,approval.id);
  assert.equal(authorization.approvedAdditionalCents,136);
  assert.equal(authorization.preservedPriorCents,40);
  assert.equal(authorization.maximumCombinedCents,176);
  assert.equal(authorization.parentMaximumCents,200);
  const journal=(await fs.readFile(path.join(root,execution,'admissions.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(journal.map(p=>p.key)).size,journal.length);
  assert.equal(journal.length,summary.budget.admitted_calls);
  assert.equal(journal.length*2,summary.budget.additional_reserved_cents);
  assert.equal(40+journal.length*2,summary.budget.combined_reserved_cents);
  assert.equal(summary.budget.total_cap_cents,200);

  const receipts=new Map(),captures=new Map(),metadata=journal.filter(p=>p.kind==='metadata');
  assert.equal(metadata.length,plan.metadataRequests.length);
  for(const entry of journal){
    assert.ok(['metadata','model'].includes(entry.kind));assert.equal(entry.reservedCents,2);
    const packet=await read(execution+'/receipts/'+evidenceDigest(entry.key)+'.json');
    assert.equal(packet.operationKey,entry.key);assert.equal(packet.kind,entry.kind);
    assert.equal(packet.inputSha256,entry.inputSha256);
    assert.equal(evidenceDigest(packet.request),entry.inputSha256);
    receipts.set(entry.key,packet);
    if(entry.kind==='metadata'){
      const target=plan.metadataRequests.find(t=>t.key===entry.key);assert.ok(target);
      assert.deepEqual(packet.request,{method:'GET',url:target.requestUrl});
      const capture=normalizeYoutubeChannel(packet,target.channelUrl);
      const archived=await read(execution+'/channel-captures/'+evidenceDigest(target.channelUrl)+'.json');
      assert.deepEqual(archived,{channelUrl:target.channelUrl,receiptSha256:evidenceDigest(packet),capture});
      captures.set(target.channelUrl,capture);
    }
  }
  // Rebuild eligibility only from source evidence, never from saved judgments.
  const records=approval.scope.map(target=>{
    const p=overlay.packets.find(p=>p.profileId===target.profile_id);assert.ok(p);
    assert.equal(p.cmArtist,target.cm_artist);assert.equal(p.artist,target.artist);
    const artist=sourceArtist(p),saved=inputs.filter(i=>i.profileId===target.profile_id);
    return {artist,searchStatus:saved.length?'candidates_found':'no_match',
      candidates:saved.map(i=>{
        const t=plan.targets.find(t=>t.profileId===i.profileId&&t.channelUrl===youtubeOwnershipUrl(i.url));assert.ok(t);
        assert.equal(t.savedInputSha256,i.inputSha256);
        assert.equal(evidenceDigest({policy:i.policy,rules:i.rules,state:i.state}),i.inputSha256);
        const s=i.state.candidate.searchEvidence;
        return {url:i.url,title:s.title,snippet:s.snippet,sourceUrl:s.sourceUrl,capture:captures.get(youtubeOwnershipUrl(i.url))??null};
      })};
  });
  assert.equal(records.flatMap(r=>r.candidates).length,inputs.length);
  const eligible=reviewYoutubeBatch(records).flatMap(r=>r.candidates.filter(c=>c.decision.status==='needs_identity_check')
    .map(({candidate})=>({artist:r.artist,candidate})));
  const preparedNames=await fs.readdir(path.join(root,execution,'model-inputs'));
  assert.equal(preparedNames.length,eligible.length);
  const held=[],completed=[];
  for(const {artist,candidate} of eligible){
    const key=keyFor(artist.profileId,candidate.url),name=evidenceDigest(key)+'.json';
    assert.ok(preparedNames.includes(name));
    const prepared=await read(execution+'/model-inputs/'+name);
    const savedInput=inputs.find(i=>i.profileId===artist.profileId&&i.url===candidate.url);
    const {input,expected}=auditYoutubeModelInput({prepared,savedInput,artist,capture:candidate.capture,plan});
    const binding={key,profileId:artist.profileId,cmArtist:artist.cmArtist,url:candidate.url,
      inputSha256:input.inputSha256,requestSha256:expected.inputSha256,bytes:expected.bytes,
      archivedInput:execution+'/model-inputs/'+name};
    if(expected.ready){
      const packet=receipts.get(key);assert.ok(packet,'A dispatched input must have its returned receipt.');
      const answer=parseYoutubeDecision(packet,input,plan,prepared.requestSha256);
      const savedAnswer=await read(execution+'/channel-answers/'+evidenceDigest(key)+'.json');
      assert.deepEqual(answer,savedAnswer,'Never rewrite or reassign a paid answer.');
      completed.push({...binding,receiptSha256:evidenceDigest(packet),answerSha256:evidenceDigest(savedAnswer),
        providerReportedUsd:answer.providerReportedUsd});
    }else{
      assert.ok(!receipts.has(key),'Held requests must never replay an admitted operation.');
      assert.ok(!files.some(f=>f.path===execution+'/channel-answers/'+evidenceDigest(key)+'.json'));
      held.push({...binding,request:prepared.request});
    }
  }
  assert.equal(completed.length,summary.modelCalls);assert.equal(held.length,summary.heldOversized);
  assert.equal(completed.length,journal.filter(j=>j.kind==='model').length);
  assert.equal(metadata.length,summary.metadataCalls);
  assert.equal(held.length,13);assert.equal(completed.length,10);
  assert.equal((await fs.readdir(path.join(root,execution,'receipts'))).length,journal.length);
  assert.equal((await fs.readdir(path.join(root,execution,'channel-answers'))).length,completed.length);
  const proposedMaximumBytes=Math.max(...held.map(p=>p.bytes));
  const newReservationCents=held.length*2;
  const combined=summary.budget.combined_reserved_cents+newReservationCents;
  assert.ok(summary.budget.additional_reserved_cents+newReservationCents<=authorization.approvedAdditionalCents);
  assert.ok(combined<=authorization.maximumCombinedCents&&combined<=approval.capCents);
  const proposal={version:1,kind:'offline_youtube_request_allowance_proposal',
    runAllowed:false,approvalRequired:true,authorization:null,
    parentId:approval.id,originalPlanSha256:planSha256,
    strategy:'Unchanged full requests; increase byte allowance only. No compact encoding, summarization, truncation or new evidence.',
    allowance:{approvedMaximumBytes:6000,proposedMaximumBytes,
      minimumHeldBytes:Math.min(...held.map(p=>p.bytes)),
      reason:'Smallest whole-body UTF-8 allowance covering every held request with all original catalog context, channel captures, rules and questions unchanged.'},
    scope:{heldModelRequests:held.length,previouslyReturnedModelRequests:completed.length,
      channelLookups:0,newSearches:0,catalogWrites:0,instagramChanges:false},
    spending:{source:'Archived completed summary and all local admissions/receipts; not a fresh shared-ledger attestation.',
      parentMaximumCents:200,existingDiscoveryReservedCents:40,
      existingOwnershipReservedCents:summary.budget.additional_reserved_cents,
      existingCombinedReservedCents:summary.budget.combined_reserved_cents,
      proposedAdditionalReservationCents:newReservationCents,proposedCombinedReservedCents:combined,
      unchangedOwnershipAllowanceCents:136,unchangedCombinedAllowanceCents:176,
      newOrResetBudget:false,instagramFunding:0,
      preservedModelProviderReportedUsd:completed.reduce((n,c)=>n+c.providerReportedUsd,0),
      reservationIsNotInvoice:true,
      pricingCaveat:'A larger request may cost more. Existing two-cent reservations and post-response billing checks are not a provider-enforced per-request price ceiling. Confirm pricing/maximum cost before any paid launch.'},
    requiredBeforeExecution:[
      'Explicit user approval of this exact proposal hash, held request hashes and measured maximum in allowance.',
      'Revalidate every source-file hash, saved input, channel capture, returned receipt and answer.',
      'Read and reconcile the unchanged shared $2 parent and original ownership phase; retain all prior and uncertain admissions.',
      'Build a separately approved continuation for the completed phase using its existing allocation and exact untouched operation keys, never a replacement budget.',
      'Freeze the revised executor and authorization; the existing transport still rejects bodies above 6,000 bytes.',
      'Confirm the larger requests fit the unchanged spending reservations; stop rather than borrow funding, retry, or discard evidence.',
    ],
    exclusions:['No prior decisions, model answers, outcome summaries or review flags added to model state.',
      'No repeat channel lookup or previously admitted model request.',
      'No claim of better ownership accuracy or newly verified matches from offline checks.'],
    held,completed,sourceManifest:files,sourceManifestSha256:evidenceDigest(files)};
  await assertYoutubeArchiveUnchanged(root,files);
  const output=path.join(root,outputName);
  await fs.mkdir(output,{recursive:false});
  await fs.writeFile(path.join(output,'proposal.json'),JSON.stringify({...proposal,proposalSha256:evidenceDigest(proposal)},null,2),{flag:'wx'});
  await fs.writeFile(path.join(output,'readiness.md'),[
    '# Offline YouTube size allowance proposal','',
    `- Held full requests: ${held.length}; ${proposal.allowance.minimumHeldBytes}–${proposedMaximumBytes} UTF-8 bytes.`,
    `- Proposed maximum: ${proposedMaximumBytes} bytes, up from 6,000. All outgoing bodies and hashes are unchanged.`,
    `- Preserve ${completed.length} returned model answers and ${metadata.length} channel lookups; do not replay them.`,
    `- Existing combined reservation: $${(proposal.spending.existingCombinedReservedCents/100).toFixed(2)}.`,
    `- Proposed additional reservation: $${(newReservationCents/100).toFixed(2)}; combined $${(combined/100).toFixed(2)}, still inside the existing $1.76 phase ceiling and $2 parent.`,
    '- These are conservative reservations, not invoices or guaranteed provider-enforced price caps.',
    '- No paid calls, database access, channel refreshes or catalog writes were made.',
    '- Full original captures and catalog evidence remain in place and are byte-hashed in the source manifest.',
    '- No compact representation was used, so there is no decoding-equivalence or evidence-omission claim.',
    '- Approval is still required. This proposal cannot run requests; the transport remains capped at 6,000 bytes.',
    '- Shared-ledger reconciliation, cost confirmation and an explicitly approved completed-phase continuation are prerequisites.',
    `- Proposal SHA-256: ${evidenceDigest(proposal)}`,'',
  ].join('\n'),{flag:'wx'});
  await assertYoutubeArchiveUnchanged(root,files);
  return proposal;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv.length,2,'Preparation accepts no paid/run/approval flags.');
  const proposal=await prepareYoutubeSizeAllowance();
  console.log(JSON.stringify({proposalSha256:evidenceDigest(proposal),allowance:proposal.allowance,
    scope:proposal.scope,spending:proposal.spending,paidCalls:0,databaseWrites:0},null,2));
}
