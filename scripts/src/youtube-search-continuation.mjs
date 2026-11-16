// Exact untouched search scope; never widens a historical twenty-artist policy.
import assert from 'node:assert/strict';
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {approveFiveHundredSearch} from './youtube-five-hundred-search-plan.mjs';
import {approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {assertStagedSearchApproval} from './youtube-staged-search-plan.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {youtubeSearchPlan,rankYoutubeSearchCandidates} from './youtube-search-plan.mjs';
import {youtubeSearchCandidates} from './youtube-discovery-test.mjs';
import {providerStopReason} from './youtube-ownership-transport.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';

export function untouchedSearchScope(source){
  const {plan,approval,childApprovals,leafApprovals,runs,admissions,results}=source;
  assert.deepEqual(approveFiveHundredSearch(plan,approval),approval);
  assert.equal(childApprovals.length,plan.children.length);
  const leaves=plan.children.flatMap(c=>c.plan.children);
  assert.equal(leafApprovals.length,leaves.length);
  assert.equal(new Set(runs.map(r=>r.id)).size,runs.length);
  assert.equal(new Set(admissions.map(a=>a.run_id+':'+a.operation_key)).size,admissions.length);
  assert.equal(new Set(results.map(r=>r.run_id+':'+r.profile_id)).size,results.length);
  for(const c of plan.children){
    const a=childApprovals.find(a=>a.id===c.id);
    assert.ok(a);assert.deepEqual(approveHundredSearch(c.plan,a),a);
  }
  const paid=[],pending=[];let gap=false,unprocessed=0;
  for(const leaf of leaves){
    const a=leafApprovals.find(a=>a.id===leaf.id);assert.ok(a);assertStagedSearchApproval(leaf.plan,a);
    const run=runs.find(r=>r.id===leaf.id),rows=admissions.filter(r=>r.run_id===leaf.id);
    const records=results.filter(r=>r.run_id===leaf.id);
    if(run){
      assert.ok(['stopped','completed'].includes(run.status));
      assert.ok(typeof run.owner==='string'&&run.owner);
      assert.equal(run.scope_sha256,leaf.plan.scopeSha256);assert.equal(run.cap_cents,40);
      assert.equal(run.reserved_cents,rows.length*2);assert.equal(records.length,20);
      if(run.status==='completed')assert.equal(rows.length,20);
    }else{assert.equal(rows.length,0);assert.equal(records.length,0);}
    for(const op of leaf.plan.operations){
      const artist=leaf.plan.artists.find(a=>a.profile_id===op.profileId);
      const packet=leaf.plan.packets.find(p=>p.profileId===op.profileId&&p.cmArtist===op.cmArtist);
      assert.ok(artist&&packet);
      const row=rows.find(r=>r.operation_key===op.key),record=records.find(r=>r.profile_id===op.profileId);
      if(record){
        assert.equal(record.cm_artist,op.cmArtist);assert.equal(record.artist,artist.artist);
        assert.equal(record.tier,artist.tier);
        assert.equal(record.metadata_json.approvalSha256,digest(a));
      }else assert.ok(!run);
      if(row){
        assert.ok(!gap,'Paid source searches must form the exact frozen prefix');
        assert.equal(row.profile_id,op.profileId);assert.equal(row.kind,'search');
        assert.equal(row.input_sha256,op.inputSha256);assert.equal(row.reserved_cents,2);
        assert.equal(row.status,'returned');assert.equal(row.http_status,200);
        assert.match(row.receipt_sha256,/^[a-f0-9]{64}$/);
        assert.ok(['search_returned','search_prepared'].includes(record.status));
        if(record.status==='search_prepared')unprocessed++;
        paid.push({sourceRunId:leaf.id,artist,packet,operation:op,admission:row});
      }else{
        gap=true;if(record)assert.equal(record.status,'search_prepared');
        pending.push({sourceRunId:leaf.id,artist,packet,operation:op});
      }
    }
    assert.equal(rows.length,paid.filter(p=>p.sourceRunId===leaf.id).length);
  }
  assert.ok(runs.every(r=>leaves.some(l=>l.id===r.id)));
  assert.equal(paid.length,admissions.length);
  assert.equal(results.length,runs.length*20);
  assert.ok(paid.length>0&&pending.length>0);
  const reserved=runs.reduce((n,r)=>n+r.reserved_cents,0);
  assert.equal(reserved,paid.length*2);assert.equal(reserved+pending.length*2,plan.maximumSpendCents);
  return {paid,pending,unprocessedSavedResponses:unprocessed,priorReservedCents:reserved,
    maximumAdditionalCents:pending.length*2,originalMaximumCents:plan.maximumSpendCents};
}
export function searchRecordFromReceipt({artist,packet,operation,receipt,receiptPath,receiptBytes}){
  assert.equal(receipt.kind,'search');assert.equal(receipt.operationKey,operation.key);
  assert.equal(receipt.inputSha256,operation.inputSha256);
  assert.equal(evidenceDigest(receipt.request),operation.inputSha256);
  assert.deepEqual(receipt.request,operation.request);
  assert.equal(receipt.status,200);assert.equal(receipt.parseFailed,false);
  assert.equal(providerStopReason(receipt),null);assert.ok(Array.isArray(receipt.data?.organic));
  const bound=youtubeArtistFromCatalogPacket(packet),searchPlan=youtubeSearchPlan(bound);
  assert.equal(bound.profileId,operation.profileId);assert.equal(bound.cmArtist,operation.cmArtist);
  assert.equal(bound.name,artist.artist);
  assert.deepEqual(searchPlan.request,operation.request.body);
  const discovery=rankYoutubeSearchCandidates(youtubeSearchCandidates(receipt.data),searchPlan,
    {limit:2,includeTopicChannels:true});
  const videoPlan=planVideoDiscovery(bound,receipt.data.organic,{
    archivePath:receiptPath,receiptSha256:digest(receiptBytes)});
  return {artist:bound,tier:artist.tier,searchPlan,...discovery,videoPlan,candidates:discovery.candidates,
    candidateStatus:'Discovery only — no channel capture or artist ownership check',
    channelAbsenceProven:false,ownershipAccepted:false};
}
function files(manifest){
  assert.ok(Object.keys(manifest??{}).length);
  for(const [name,sha] of Object.entries(manifest)){
    assert.match(name,/^[A-Za-z0-9_./-]+$/);assert.ok(!name.startsWith('/')&&!name.split('/').includes('..'));
    assert.match(sha,/^[a-f0-9]{64}$/);
  }
  return structuredClone(manifest);
}
export function searchContinuationPlan(input,source){
  assert.match(input.id,/^youtube-search-continuation-[a-z0-9-]{4,65}$/);
  assert.ok(Number.isFinite(Date.parse(input.preparedAt)));
  const scope=untouchedSearchScope(source),groups=[];
  for(const entry of scope.pending){
    let group=groups.at(-1);
    if(!group||group.sourceRunId!==entry.sourceRunId){
      group={id:input.id+'-part-'+(groups.length+1),sourceRunId:entry.sourceRunId,
        artists:[],packets:[],operations:[]};groups.push(group);
    }
    group.artists.push(entry.artist);group.packets.push(entry.packet);group.operations.push(entry.operation);
  }
  for(const group of groups){
    assert.ok(group.operations.length>0&&group.operations.length<=20);
    group.scopeSha256=digest(group.artists);group.maximumSpendCents=group.operations.length*2;
  }
  return {version:'exact-untouched-search-continuation-v1',id:input.id,preparedAt:input.preparedAt,
    sourcePlanId:source.plan.id,sourcePlanSha256:digest(source.plan),
    sourceApprovalSha256:digest(source.approval),groups,
    evidenceFiles:files(input.evidenceFiles),runtimeFiles:files(input.runtimeFiles),
    maximumCalls:scope.pending.length,maximumSpendCents:scope.maximumAdditionalCents,
    priorReservedCents:scope.priorReservedCents,combinedMaximumCents:scope.originalMaximumCents,
    explicitApproval:false,allowedKinds:['search'],noRetries:true,noCatalogWrites:true,
    fullCampaignRemainsPaused:true,unknownDownstreamRequestsApproved:false,
    sourcePreparedRowsRemainUnchanged:true};
}
export function approveSearchContinuation(plan,source,{planSha256,capCents,approvedAt}){
  assert.deepEqual(searchContinuationPlan(plan,source),plan);assert.equal(digest(plan),planSha256);
  assert.equal(capCents,plan.maximumSpendCents);
  assert.ok(Date.parse(approvedAt)>=Date.parse(plan.preparedAt));
  return {id:plan.id,version:plan.version,planSha256,capCents,approvedAt,explicitApproval:true,
    scope:'only_exact_untouched_searches_no_paid_replay_or_downstream_requests'};
}
