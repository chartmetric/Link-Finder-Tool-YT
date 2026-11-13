// Synthetic offline evidence only; no live catalog, provider or coordinator.
import {digest,planVideoDiscovery} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage} from './youtube-video-stage.mjs';
import {youtubeArtistFromCatalogPacket} from './youtube-ownership-evidence.mjs';
import {prepareVideoChannelCaptures,prepareVideoIdentityModels,approveVideoIdentityPlan} from './youtube-video-identity-plan.mjs';
import {approveIdentityExecution,IDENTITY_EXECUTION_POLICY,IDENTITY_PARENT} from './youtube-video-identity-execution.mjs';
export const fixtureAt='2026-11-13T06:00:00Z';
export function identityExecutionFixture({model=false,profileOffset=0,cmOffset=0,channelOffset=0}={}){
  const suffix=profileOffset||cmOffset||channelOffset?`-${profileOffset}-${cmOffset}-${channelOffset}`:'';
  const files={},evidenceFiles={},artists=[],operations=[];
  const put=(name,value)=>{
    const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
    files[name]=bytes.toString('base64');return digest(bytes);
  };
  const parent={id:'fixture-parent',artists:Array.from({length:20},(_,i)=>({
    profile_id:String(i+1+profileOffset),cm_artist:String(i+101+cmOffset)}))};
  evidenceFiles['evidence/source-plan.json']=put('evidence/source-plan.json',parent);
  for(let i=1;i<=20;i++){
    const a={profileId:String(i+profileOffset),cmArtist:String(i+100+cmOffset),name:'Fixture '+i,tier:2,snapshotAt:fixtureAt};
    artists.push(a);
    const catalogPacket={profileId:a.profileId,cmArtist:a.cmArtist,artist:a.name,
      catalogProfile:{profile_id:a.profileId,cm_artist:a.cmArtist,name:a.name},linkedAccounts:[],
      chartmetric:null,releases:[],catalogTracks:[],tags:[],spotifyMetadata:[],platformSnapshots:[],profileMetadata:[]};
    const artist=youtubeArtistFromCatalogPacket(catalogPacket);
    const request={method:'POST',url:'https://google.serper.dev/search',body:{q:a.name}};
    const receipt={operationKey:'search-'+a.profileId+'-0',kind:'search',status:200,request,
      inputSha256:digest(request),data:{organic:[0,1].map(j=>({
        link:'https://www.youtube.com/watch?v='+String(i*2+j).padStart(11,'0'),
        title:a.name+' music',snippet:'Recording'}))}};
    const raw=JSON.stringify(receipt);
    const videoPlan=planVideoDiscovery(artist,receipt.data.organic,{receiptSha256:digest(raw),
      archivePath:'generated-artifacts/fixture-parent/receipts/search-'+i+'.json'});
    evidenceFiles['evidence/'+a.profileId+'.json']=put('evidence/'+a.profileId+'.json',{artist,catalogPacket,
      sourceSearchReceipt:receipt,sourceSearchReceiptBytesBase64:Buffer.from(raw).toString('base64'),videoPlan});
    for(const v of videoPlan.resolutionQueue)operations.push({...v.operation,profileId:a.profileId,
      cmArtist:a.cmArtist,videoId:v.videoId,videoUrl:v.url});
  }
  const uploader=videoStagePlan({id:'youtube-video-review-executor-fixture'+suffix,preparedAt:fixtureAt,
    sourceRunId:parent.id,sourcePlanSha256:digest(parent),artists,operations,evidenceFiles,
    runtimeFiles:{'runtime/source.mjs':put('runtime/source.mjs','// fixture')}});
  put('plan.json',uploader);
  put('approval.json',approveVideoStage(uploader,{expectedPlanSha256:digest(uploader),capCents:80,approvedAt:fixtureAt}));
  put('summary.json',{id:uploader.id,status:'completed',returnedCalls:40});
  for(const op of uploader.operations){
    const channelId='UC'+String(Number(op.videoId)+channelOffset).padStart(22,'0');
    const raw=JSON.stringify({success:true,credits_charged:1,id:op.videoId,
      channel:{id:channelId,title:'Fixture '+op.profileId,url:'https://www.youtube.com/channel/'+channelId}});
    const rawPath='receipts/'+digest(op.key)+'.raw';put(rawPath,raw);
    put('receipts/'+digest(op.key)+'.json',{runId:uploader.id,planSha256:digest(uploader),profileId:op.profileId,
      cmArtist:op.cmArtist,videoId:op.videoId,operationKey:op.key,kind:op.kind,request:op.request,
      inputSha256:op.inputSha256,status:200,capturedAt:fixtureAt,rawPath,rawBodySha256:digest(raw)});
  }
  const runtimeFiles={'runtime/fixture.mjs':digest('// preparation fixture')};
  const capture=prepareVideoChannelCaptures({id:'youtube-video-identity-executor-capture'+suffix,preparedAt:fixtureAt,
    runtimeFiles,source:{files}});
  const plan=model?prepareVideoIdentityModels({id:'youtube-video-identity-executor-model'+suffix,preparedAt:fixtureAt,
    runtimeFiles,capturePlan:capture,captureReturns:fixtureReturns(capture,fixtureChannelData)}):capture;
  const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:digest(plan),capCents:plan.maximumSpendCents,approvedAt:fixtureAt});
  const manifest={policy:IDENTITY_EXECUTION_POLICY,id:plan.id,planSha256:digest(plan),approvalSha256:digest(approval),
    parentId:IDENTITY_PARENT,preparedAt:fixtureAt,runtimeFiles:{'execution/runtime/fixture.mjs':digest('fixture')}};
  const executionApproval=approveIdentityExecution(plan,approval,manifest,{planSha256:digest(plan),
    executionSha256:digest(manifest),capCents:plan.maximumSpendCents,approvedAt:fixtureAt});
  return {plan,approval,manifest,executionApproval};
}
export function fixtureChannelData(op){
  return {success:true,credits_charged:1,channelId:op.channelId,name:'Fixture '+op.profileId,description:'Music.'};
}
export function fixtureModelData(){
  return {model:'typesafe/jev-1.13-20260917',usage:{cost:.001},
    answers:{same_identity:{noul:.95},verdict:{choice:'likely'},channel_type:{choice:'artist_owned'}}};
}
export function fixtureReturns(plan,dataFor){
  const approval=approveVideoIdentityPlan(plan,{expectedPlanSha256:digest(plan),capCents:plan.maximumSpendCents,approvedAt:fixtureAt});
  return {approval,summary:{id:plan.id,planSha256:digest(plan),status:'completed',returnedCalls:plan.operations.length},
    receipts:plan.operations.map(op=>{
      const raw=Buffer.from(JSON.stringify(dataFor(op))),receipt={runId:plan.id,planSha256:digest(plan),
        approvalSha256:digest(approval),operationKey:op.key,profileId:op.profileId,cmArtist:op.cmArtist,
        channelId:op.channelId,kind:op.kind,request:op.request,inputSha256:op.inputSha256,status:200,
        capturedAt:fixtureAt,rawPath:'receipts/'+digest(op.key)+'.raw',rawBodySha256:digest(raw)};
      return {receiptBytesBase64:Buffer.from(JSON.stringify(receipt)).toString('base64'),rawBodyBase64:raw.toString('base64')};
    })};
}
