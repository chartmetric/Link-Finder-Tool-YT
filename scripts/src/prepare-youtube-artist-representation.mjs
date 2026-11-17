// Offline evidence-delivery audit. Never runs a provider, SQL or an old worker.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {youtubeDecisionRequest} from './youtube-ownership-transport.mjs';
import {revisedContextRequest} from './youtube-context-revision.mjs';
import {artistRepresentationRequest,representationReviewGate,REPRESENTATION_VERSION} from './youtube-artist-representation.mjs';
import {frozenFileVerifier} from './youtube-frozen-file-cache.mjs';

assert.deepEqual(process.argv.slice(2),['--offline-prepare']);
const roots=['generated-artifacts/youtube-test-100-review-e2e-2026-11-17',
  'generated-artifacts/youtube-test-100-review-parallel-2026-11-17'];
const auditRoot='generated-artifacts/youtube-held-28-evidence-review-2026-11-17';
const target='generated-artifacts/youtube-artist-representation-offline-2026-11-17';
const bytes=await fs.readFile(auditRoot+'/audit.json'),audit=JSON.parse(bytes);
const files={...audit.summary.originalInputsSha256,[auditRoot+'/audit.json']:digest(bytes)};
const verify=frozenFileVerifier(files);await verify();
const records=JSON.parse(await fs.readFile(roots[1]+'/results.json'));
const plan=JSON.parse(await fs.readFile(roots[1]+'/plan.json'));
const receipts=[];
for(const root of roots)for(const name of await fs.readdir(root+'/receipts')){
  if(!name.endsWith('.json'))continue;
  const packet=JSON.parse(await fs.readFile(root+'/receipts/'+name));
  if(packet.kind==='model'&&packet.status===200)receipts.push(packet);
}
// These exact pairs received positive user feedback after the source-only audit.
// Feedback stays in the report, NEVER in request state or acceptance inputs.
const manualProfiles=new Set(['4147835','3927575','203190','4151727','4140721','275599',
  '3645344','3977746','4014078','3801299','272871','271000','3726477','295977',
  '4013071','4148016','266680']);
const requests=[],rows=[];
for(const old of audit.rows){
  const r=records.find(r=>r.artist.profileId===old.profile_id&&r.artist.cmArtist===old.cm_artist);
  assert.ok(r);
  const c=r.candidates.find(c=>'https://www.youtube.com/channel/'+c.capture?.body.channelId===old.youtube_url);
  assert.ok(c);assert.equal(c.capture.bodySha256,old.channel_capture_body_sha256);
  const packet=receipts.find(p=>p.profileId===r.artist.profileId&&p.cmArtist===r.artist.cmArtist&&
    p.inputSha256===c.assessment.modelAnswer.requestSha256);
  assert.ok(packet,'Original exact request not found');
  assert.equal(digest(packet.request),packet.inputSha256);
  const s=packet.request.body.state;
  const input=youtubeVerificationInput(s.artist,{url:s.candidate.url,capture:c.capture,
    ...s.candidate.searchEvidence});
  const prepared=youtubeDecisionRequest(input,{model:{endpoint:packet.request.url,
    expectedModel:'typesafe/jev-1.13',maxRequestBytes:plan.maximumModelRequestBytes}});
  const template={key:'unsent-representation-'+r.artist.profileId+'-'+c.capture.body.channelId,
    kind:'model',profileId:r.artist.profileId,cmArtist:r.artist.cmArtist,
    channelId:c.capture.body.channelId,request:prepared.request,
    inputSha256:prepared.inputSha256,policyInputSha256:input.inputSha256,requestBytes:prepared.bytes,
    requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),proposedReservationCents:2};
  // This reconstruction must reproduce the actual historical outgoing bytes.
  assert.deepEqual(revisedContextRequest(template,c.capture,s.boundDiscoveryVideos??[]).request,
    packet.request,'Historical request reconstruction differs; do not claim an archived comparison');
  const proposal=artistRepresentationRequest(template,c.capture,s.boundDiscoveryVideos??[],
    plan.maximumModelRequestBytes);
  assert.deepEqual(proposal.request.body.state.artist,s.artist);
  assert.deepEqual(proposal.request.body.state.candidate,s.candidate);
  assert.doesNotMatch(JSON.stringify(proposal.request),/"(?:userFeedback|userReview|grading|expectedVerdict)"\s*:/i);
  assert.equal(c.assessment.modelAssessment.category,'identity_supported_control_uncertain');
  const route=representationReviewGate(proposal,{
    sharedChannel:c.sharedChannelConflict===true,contradictoryPair:c.contradictoryPair===true});
  requests.push({profileId:r.artist.profileId,cmArtist:r.artist.cmArtist,
    channelId:c.capture.body.channelId,historicalRequestSha256:packet.inputSha256,proposal});
  rows.push({artist:r.artist.name,tier:r.tier,profile_id:r.artist.profileId,cm_artist:r.artist.cmArtist,
    youtube_url:old.youtube_url,channel_name:old.channel_name,
    source_only_support_route:route.eligible?'Reference available — requires fresh model assessment':'Hold — more independent evidence needed',
    route_reason:route.reason,exact_catalog_links:proposal.request.body.state.evidenceNavigation.exactCatalogLinks.length,
    manual_feedback:manualProfiles.has(r.artist.profileId)?'User manually checked; all seemed good':'Not supplied for this pair',
    original_model_assessment:c.assessment.modelAssessment.category,
    new_model_assessment:'Not run',full_request_fits:proposal.readyForComparison,
    original_request_bytes:Buffer.byteLength(JSON.stringify(packet.request.body)),
    revised_request_bytes:proposal.requestBytes,request_sha256:proposal.requestSha256,
    ownership_confirmed:false,import_eligible:false});
}
assert.equal(rows.length,28);
assert.equal(rows.filter(r=>r.manual_feedback.startsWith('User')).length,17);
const summary={version:REPRESENTATION_VERSION,artists:28,
  exactReferenceRouteAvailable:rows.filter(r=>r.source_only_support_route.startsWith('Reference')).length,
  moreIndependentEvidenceNeeded:rows.filter(r=>r.source_only_support_route.startsWith('Hold')).length,
  positiveUserReviewsKeptOutsideRequests:17,
  allFullRequestsFit:rows.every(r=>r.full_request_fits),maximumRequestBytes:plan.maximumModelRequestBytes,
  metadataCalls:0,modelCalls:0,paidCalls:0,coordinatorWrites:0,catalogWrites:0,
  executionEnabled:false,policyActivated:false,originalResultsChanged:false,
  ownershipAccepted:0,newModelResults:0,modelAccuracyMeasured:false,
  limitation:'Exposed development examples and synthetic rule tests only. A source-only support route is neither a new model verdict nor ownership proof. Missing saved corroboration does not overturn positive user review.',
  sourceFiles:files};
await fs.mkdir(target,{recursive:true});
const columns=Object.keys(rows[0]),cell=x=>'"'+String(x??'').replaceAll('"','""')+'"';
await fs.writeFile(target+'/source-review.csv','\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]))]
  .map(r=>r.map(cell).join(',')).join('\r\n'),{flag:'wx'});
await fs.writeFile(target+'/requests.json',JSON.stringify({summary,requests}),{flag:'wx'});
await fs.writeFile(target+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
await verify();
console.log(JSON.stringify({...summary,sourceFiles:Object.keys(files).length}));
