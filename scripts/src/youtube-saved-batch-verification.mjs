// Offline assembly only: no transport, credentials, authorization or catalog writes.
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {boundYoutubeCapture,youtubeVerificationInput,youtubeOwnershipUrl} from './youtube-ownership-policy.mjs';
import {youtubeArtistFromCatalogPacket,assembleYoutubeOwnershipEvidence} from './youtube-ownership-evidence.mjs';
import {evaluateYoutubeLink} from './youtube-topic-links.mjs';
import {youtubeDecisionRequest} from './youtube-ownership-transport.mjs';

export function savedBatchCapture({group,approval,operation,row,receipt,raw,receiptBytes}){
  assert.equal(receipt.runId,group.id);assert.equal(receipt.planSha256,digest(group));
  assert.equal(receipt.approvalSha256,digest(approval));
  for(const [key,value] of Object.entries({operationKey:operation.key,profileId:operation.profileId,
    cmArtist:operation.cmArtist,kind:'metadata',targetUrl:operation.targetUrl,
    inputSha256:operation.inputSha256,status:200,rawPath:'receipts/'+digest(operation.key)+'.raw'}))
    assert.equal(receipt[key],value);
  assert.deepEqual(receipt.request,operation.request);assert.equal(digest(receipt.request),operation.inputSha256);
  assert.equal(receipt.rawBodySha256,digest(raw));assert.equal(digest(JSON.parse(receiptBytes)),digest(receipt));
  for(const [key,value] of Object.entries({run_id:group.id,operation_key:operation.key,
    profile_id:operation.profileId,cm_artist:operation.cmArtist,channel_id:operation.allocationChannelKey,
    kind:'metadata',input_sha256:operation.inputSha256,reserved_cents:2,status:'returned',
    http_status:200,receipt_sha256:digest(receipt),raw_sha256:digest(raw)}))assert.equal(row[key],value);
  const body=JSON.parse(raw);assert.equal(body.success,true);
  assert.ok(Number.isInteger(body.credits_charged)&&body.credits_charged>=0&&body.credits_charged<=1);
  assert.ok(Number.isFinite(Date.parse(receipt.capturedAt)));
  assert.ok(Date.parse(receipt.capturedAt)>=Date.parse(approval.approvedAt));
  const capture=normalizeYoutubeChannel({at:receipt.capturedAt,status:200,kind:'metadata',
    operationKey:operation.key,request:operation.request,inputSha256:operation.inputSha256,data:body},operation.targetUrl);
  const bound=boundYoutubeCapture(operation.targetUrl,capture);assert.ok(bound);
  if(operation.expectedChannelId)assert.equal(bound.body.channelId,operation.expectedChannelId);
  return {capture,channelId:bound.body.channelId,aliases:bound.aliases,
    receiptFileSha256:digest(receiptBytes),rawSha256:digest(raw),receiptSha256:digest(receipt)};
}
const key=x=>JSON.stringify([x.profileId,x.cmArtist]);
export function savedRecoveryHolds(plan,rows){
  const held=new Set(),seen=new Set();
  const visit=value=>{
    if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);
    for(const r of [value.recovery,value.savedResponseRecovery].filter(Boolean)){
      if(r.operationKey){
        const row=rows.find(a=>a.run_id===r.runId&&a.operation_key===r.operationKey);
        assert.ok(row,'Historical recovery must remain accounted');
        if(row.http_status===200){
          assert.equal(r.ownershipAccepted,false);assert.equal(r.importEligible,false);
          held.add(row.profile_id);
        }
      }
    }
    for(const k of ['sourcePlan','predecessor'])visit(value[k]);
  };
  visit(plan);return [...held];
}
export function assembleSavedVerification({captures,packets,records,claims,priorModelRows,heldProfiles}){
  const owners=new Map(),add=(url,a)=>{
    const u=youtubeOwnershipUrl(url);if(!u)return;
    const k=u.toLowerCase(),set=owners.get(k)??new Set();set.add(key(a));owners.set(k,set);
  };
  for(const r of records)for(const c of r.record.candidates)add(c.url,r.record.artist);
  for(const c of claims)add(c.url,c);
  for(const c of captures)for(const u of c.aliases)add(u,c.operation);
  const assessments=[],operations=[],seen=new Set();
  for(const c of captures){
    const op=c.operation,selection=c.group.selections.find(s=>key(s)===key(op));assert.ok(selection);
    const matching=packets.filter(p=>key(p)===key(op));assert.ok(matching.length);
    assert.equal(new Set(matching.map(digest)).size,1,'Conflicting saved artist packets');
    const packet=matching[0],base=youtubeArtistFromCatalogPacket(packet);
    assert.equal(base.name,selection.artist);
    const record=records.find(r=>key(r.record.artist)===key(op));assert.ok(record);
    const lead=record.record.candidates.find(x=>youtubeOwnershipUrl(x.url)===youtubeOwnershipUrl(op.targetUrl));assert.ok(lead);
    const canonical='https://www.youtube.com/channel/'+c.channelId;
    const pair=JSON.stringify([op.profileId,op.cmArtist,c.channelId]);
    assert.ok(!seen.has(pair),'Duplicate artist/channel must be consolidated explicitly');seen.add(pair);
    const shared=c.aliases.some(u=>(owners.get(youtubeOwnershipUrl(u)?.toLowerCase())?.size??0)>1);
    const candidate={url:op.targetUrl,capture:c.capture,title:lead.title??'',snippet:lead.snippet??'',
      sourceUrl:lead.sourceUrl??op.targetUrl};
    const artist={...base,ownershipEvidence:assembleYoutubeOwnershipEvidence(base,packet,candidate)};
    const decision=evaluateYoutubeLink(artist,candidate,{sharedChannel:shared});
    const prior=priorModelRows.some(r=>r.profile_id===op.profileId||r.cm_artist===op.cmArtist||r.channel_id===c.channelId);
    const held=heldProfiles.includes(op.profileId);
    let request=null;
    if(!held&&!prior&&decision.status==='needs_identity_check'){
      const input=youtubeVerificationInput(artist,candidate);
      const prepared=youtubeDecisionRequest(input,{model:{endpoint:'https://openrouter.ai/api/alpha/decisions',
        expectedModel:'typesafe/jev-1.13',maxRequestBytes:Number.MAX_SAFE_INTEGER}});
      request={key:'model-'+op.profileId+'-'+c.channelId,kind:'model',profileId:op.profileId,
        cmArtist:op.cmArtist,channelId:c.channelId,request:prepared.request,inputSha256:prepared.inputSha256,
        requestBodySha256:digest(Buffer.from(JSON.stringify(prepared.request.body))),requestBytes:prepared.bytes,
        policyInputSha256:input.inputSha256,proposedReservationCents:2,
        captureRunId:c.group.id,captureOperationKey:op.key,captureReceiptSha256:c.receiptSha256,
        catalogPacketSha256:digest(packet),ownershipAccepted:false,importEligible:false};
      operations.push(request);
    }
    assessments.push({artist:base.name,profileId:op.profileId,cmArtist:op.cmArtist,tier:selection.tier,
      channelId:c.channelId,youtubeUrl:canonical,aliases:c.aliases,
      channelTypeLabel:decision.channelType==='topic'?'Topic — auto-generated':decision.channelType,
      status:held?'held_saved_identity_conflict':prior?'held_prior_model_allocation':decision.status,
      reason:held?'Saved identity conflict remains unresolved':prior?'Never repeat an existing model allocation':decision.reason,
      sharedCandidate:shared,proposedModelCheck:Boolean(request),requestBytes:request?.requestBytes??null,
      catalogPacketSha256:digest(packet),captureReceiptSha256:c.receiptSha256,
      capturedAt:c.capture.capturedAt,ownershipAccepted:false,importEligible:false});
  }
  return {assessments,operations};
}
