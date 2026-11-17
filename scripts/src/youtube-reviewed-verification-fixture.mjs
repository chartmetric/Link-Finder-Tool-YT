// Synthetic metadata/approval fixtures; never use live provider credentials.
import {digest} from './youtube-video-discovery-offline.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';
import {reviewedInput,reviewedCaptureOperation,reviewedCapturePlan,approveReviewedCaptures,
  reviewedCaptureResult,REVIEWED_TEST_POLICY} from './youtube-reviewed-test.mjs';
import {reviewedVerificationEvidence,reviewedVerificationOperation,reviewedVerificationPlan,
  approveReviewedVerification,REVIEWED_VERIFICATION_POLICY} from './youtube-reviewed-verification.mjs';

const at='2026-11-17T01:00:00Z';
export const syntheticMetadataBytes=op=>Buffer.from(JSON.stringify({success:true,credits_charged:1,
  channelId:op.channelId,channel:op.targetUrl,name:op.profileId==='257398'?'LYKN':
    op.profileId==='14'?'Someone Else - Topic':'Artist '+op.profileId}));
export function syntheticReceipt(plan,approval,op,raw){
  return {runId:plan.groups[0].id,parentId:plan.id,planSha256:digest(plan.groups[0]),approvalSha256:digest(approval),
    operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,channelId:op.channelId,kind:op.kind,
    inputSha256:op.inputSha256,request:op.request,status:200,rawPath:'receipts/'+digest(op.key)+'.raw',
    rawBodySha256:digest(raw),capturedAt:at};
}
export function reviewedVerificationFixture(schema='a'.repeat(64)){
  const inputs=[],grading=[];
  for(let i=0;i<14;i++){
    const profileId=i===7?'257398':String(i+1),cmArtist=i===7?'11498692':String(i+101);
    const channelId=i===7?'UCso2wzxEVKV-f4iC3MJrRzA':'UC'+'a'.repeat(21)+'ABCDEFGHIJKLMN'[i];
    const url='https://www.youtube.com/channel/'+channelId;
    const artist={profileId,cmArtist,name:i===7?'William Jakrapatr':'Artist '+profileId,
      catalogProfile:{profile_id:profileId,cm_artist:cmArtist},accounts:[],releases:[]};
    let capture=null;
    if(i<7){
      const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(url)};
      capture=normalizeYoutubeChannel({kind:'metadata',status:200,at,request,inputSha256:digest(request),
        data:{success:true,channelId,channel:url,name:artist.name+(i>=5?' - Topic':'')}},url);
    }
    const row=reviewedInput({artist,url,capture,sourceObservedAt:at,startingTier:2,
      sourceRefs:['generated-artifacts/synthetic/source.json']});inputs.push(row);
    grading.push({caseId:row.caseId,userFeedback:i<7?'looks_correct':'rejected',
      labelScope:'historical_user_feedback',ownershipAdjudication:null,catalogWritesAuthorized:false,
      sourceRefs:['generated-artifacts/synthetic/feedback.json']});
  }
  const original=reviewedCapturePlan({id:'youtube-reviewed-test-captures-synthetic-original',version:REVIEWED_TEST_POLICY,
    preparedAt:at,inputs,grading,operations:inputs.filter(i=>!i.capture).map(reviewedCaptureOperation),
    maximumSpendCents:14,selections:inputs.slice(7).map(i=>({profileId:i.profileId,cmArtist:i.cmArtist,
      artist:i.artist.name,tier:2})),coordinatorSchemaSha256:schema,
    sourceFiles:{'generated-artifacts/synthetic/source.json':'b'.repeat(64)},runtimeFiles:{'runtime/synthetic.mjs':'c'.repeat(64)}});
  const originalApproval=approveReviewedCaptures(original,{planSha256:digest(original),capCents:14,approvedAt:at});
  const first=original.operations[0],raw=syntheticMetadataBytes(first),receipt=syntheticReceipt(original,originalApproval,first,raw);
  const originalRoot='generated-artifacts/'+original.id,group=original.groups[0];
  const capture=reviewedCaptureResult(original,first,receipt,raw).capture;
  const updated=inputs.map(i=>i.profileId!==first.profileId?i:reviewedInput({...i,capture,
    sourceRefs:[...i.sourceRefs,originalRoot+'/part-1/receipts/'+digest(first.key)+'.json',originalRoot+'/part-1/'+receipt.rawPath]}));
  const source=reviewedCapturePlan({...original,id:'youtube-reviewed-test-captures-synthetic-suffix',
    inputs:updated,operations:original.operations.slice(1),selections:original.selections.slice(1),maximumSpendCents:12,
    recovery:{sourceRoot:originalRoot,sourcePlan:original,sourceApproval:originalApproval,receipt,rawBodyBase64:raw.toString('base64'),
      sourceRun:{id:group.id,status:'stopped',scope_sha256:digest({group,approval:originalApproval,runtimeFiles:original.runtimeFiles}),
        cap_cents:14,reserved_cents:2},
      sourceAdmission:{run_id:group.id,operation_key:first.key,profile_id:first.profileId,kind:'metadata',
        input_sha256:first.inputSha256,reserved_cents:2,status:'admitted',receipt_sha256:null,http_status:null}}});
  const approval=approveReviewedCaptures(source,{planSha256:digest(source),capCents:12,approvedAt:at});
  const sourceRoot='generated-artifacts/'+source.id,sourceFiles={...source.sourceFiles};
  for(const [name,sha] of Object.entries(source.runtimeFiles))sourceFiles[sourceRoot+'/'+name]=sha;
  for(const name of ['plan.json','approval.json','summary.json','results.json','recovery.json'])sourceFiles[sourceRoot+'/'+name]='d'.repeat(64);
  const captureResponses=source.operations.map(op=>{
    const bytes=syntheticMetadataBytes(op),packet=syntheticReceipt(source,approval,op,bytes);
    sourceFiles[sourceRoot+'/part-1/'+packet.rawPath]=digest(bytes);
    sourceFiles[sourceRoot+'/part-1/receipts/'+digest(op.key)+'.json']=digest(Buffer.from(JSON.stringify(packet)));
    return {operationKey:op.key,receipt:packet,rawBodyBase64:bytes.toString('base64')};
  });
  const evidence=reviewedVerificationEvidence(sourceRoot,source,approval,captureResponses);
  const operations=evidence.inputs.map(reviewedVerificationOperation);
  const plan=reviewedVerificationPlan({id:'youtube-reviewed-verification-synthetic',version:REVIEWED_VERIFICATION_POLICY,
    preparedAt:at,sourceRoot,captureSourcePlan:source,captureSourceApproval:approval,captureResponses,...evidence,
    operations,selections:evidence.inputs.map(i=>({profileId:i.profileId,cmArtist:i.cmArtist,artist:i.artist.name,tier:2})),
    coordinatorSchemaSha256:schema,sourceFiles,runtimeFiles:{'runtime/synthetic.mjs':'e'.repeat(64)},
    pricing:{id:'typesafe/jev-1.13',endpoint:'https://openrouter.ai/api/v1/models?output_modalities=decisions',
      observedAt:at,promptUsdPerToken:'0.000000042',completionUsdPerToken:'0',contextTokens:262144},
    maximumSpendCents:28,maximumRequestBytes:Math.max(...operations.map(o=>o.requestBytes))});
  return {plan,approval:approveReviewedVerification(plan,{planSha256:digest(plan),capCents:28,approvedAt:at})};
}
