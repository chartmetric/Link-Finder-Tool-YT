import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {mapSavedVideoUploader} from './youtube-video-uploader-review.mjs';
import {assertVideoStageApproval} from './youtube-video-stage.mjs';
import {validateVideoRecovery} from './youtube-video-stage-recovery.mjs';

export async function durableStageFile(path,bytes){
  const f=await fs.open(path,'wx');
  try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
}
export async function executeVideoStage({plan,approval,root,gate,assertFrozen,credential,fetchImpl=fetch}){
  assertVideoStageApproval(plan,approval);
  assert.ok(typeof credential==='string'&&credential.length,'Provider credential required');
  await assertFrozen();
  const results=[],recovered=[];let started=false,status='stopped';
  if(plan.recovery){
    const evidence=JSON.parse(await fs.readFile(root+'/evidence/recovery.json','utf8'));
    const op=validateVideoRecovery(plan,evidence),mapped=evidence.mapped;
    recovered.push({...mapped,profileId:op.profileId,cmArtist:op.cmArtist,
      artist:evidence.artistEvidence.artist.name,tier:plan.artists.find(a=>a.profileId===op.profileId).tier,
      videoUrl:op.videoUrl,ownershipAccepted:false,sourceRunId:plan.recovery.previousRunId,recoveredWithoutReplay:true,
      topicLabel:/\btopic\b/i.test(mapped.uploaderName)?'Topic lead — auto-generated status needs channel capture':'Channel type needs capture'});
  }
  try{
    await gate.start();started=true;
    for(const result of recovered)
      await durableStageFile(root+'/results/recovered-'+digest(plan.recovery.completedOperationKey)+'.json',JSON.stringify(result));
    for(const op of plan.operations){
      await assertFrozen();
      const evidence=JSON.parse(await fs.readFile(root+`/evidence/${op.profileId}.json`,'utf8'));
      assert.equal(evidence.artist.profileId,op.profileId);assert.equal(evidence.artist.cmArtist,op.cmArtist);
      const clue=evidence.videoPlan.resolutionQueue.find(c=>c.videoId===op.videoId);
      assert.ok(clue);assert.deepEqual(clue.operation.request,op.request);
      assert.equal(clue.operation.key,op.key);
      await durableStageFile(root+'/inputs/'+digest(op.key)+'.json',JSON.stringify(op));
      await gate.admit(op);
      // From this point any crash, timeout or malformed response is non-replayable.
      const response=await fetchImpl(op.request.url,{method:'GET',redirect:'error',
        headers:{'x-api-key':credential},signal:AbortSignal.timeout(30000)});
      const chunks=[];let length=0;
      if(response.body)for await(const chunk of response.body){
        length+=chunk.length;assert.ok(length<=2*1024*1024,'Oversized response; stop without replay');
        chunks.push(chunk);
      }
      const rawBody=Buffer.concat(chunks),rawPath='receipts/'+digest(op.key)+'.raw';
      await durableStageFile(root+'/'+rawPath,rawBody);
      const receipt={runId:plan.id,planSha256:digest(plan),profileId:op.profileId,cmArtist:op.cmArtist,
        videoId:op.videoId,operationKey:op.key,kind:op.kind,request:op.request,inputSha256:op.inputSha256,
        status:response.status,capturedAt:new Date().toISOString(),rawPath,rawBodySha256:digest(rawBody)};
      await durableStageFile(root+'/receipts/'+digest(op.key)+'.json',JSON.stringify(receipt));
      const mapped=mapSavedVideoUploader(evidence.artist,clue,{...receipt,rawBody},
        {runId:plan.id,planSha256:digest(plan)});
      const result={profileId:op.profileId,cmArtist:op.cmArtist,artist:evidence.artist.name,
        tier:plan.artists.find(a=>a.profileId===op.profileId).tier,videoUrl:op.videoUrl,...mapped,
        ownershipAccepted:false,topicLabel:/\btopic\b/i.test(mapped.uploaderName)
          ?'Topic lead — auto-generated status needs channel capture':'Channel type needs capture'};
      await durableStageFile(root+'/results/'+digest(op.key)+'.json',JSON.stringify(result));
      await gate.returned(op,digest(receipt),digest(rawBody));
      results.push(result);
      console.log(JSON.stringify({phase:'video_uploaders',returned:results.length,total:plan.maximumCalls,
        profileId:op.profileId,requiresIdentityCheck:true}));
    }
    await gate.finish('completed');
    status='completed';
    return results;
  }catch(error){
    status='stopped';
    if(started){
      try{await gate.finish('stopped');}
      catch(fenceError){throw new AggregateError([error,fenceError],'Stage stopped; completion fence failed; ledger is authoritative');}
    }
    throw error;
  }finally{
    if(started){
      const owners=new Map(),allResults=[...recovered,...results];
      for(const r of allResults){const set=owners.get(r.url)??new Set();set.add(r.profileId);owners.set(r.url,set);}
      const summary={id:plan.id,status,returnedCalls:results.length,maximumCalls:plan.maximumCalls,
        acknowledgedReservationCents:results.length*2,maximumSpendCents:plan.maximumSpendCents,
        recoveredSavedResponses:recovered.length,priorReservedCents:plan.recovery?.previousReservedCents??0,
        combinedMaximumSpendCents:plan.maximumSpendCents+(plan.recovery?.previousReservedCents??0),
        reservationWarning:'A stopped stage may have an additional unacknowledged paid admission; the database ledger is authoritative.',
        artistsWithResolvedUploaders:new Set(allResults.map(r=>r.profileId)).size,
        uniqueChannels:new Set(allResults.map(r=>r.url)).size,sharedChannels:[...owners].filter(([,v])=>v.size>1).length,
        acceptedOwnershipLinks:0,channelMetadataCalls:0,modelCalls:0,searchCalls:0,catalogWrites:0,
        fullCampaignResumed:false,nextStageApprovalRequired:true};
      await durableStageFile(root+'/summary.json',JSON.stringify(summary,null,2));
      const columns=['artist','tier','profile_id','cm_artist','video_url','youtube_url','uploader_name',
        'channel_type_label','artist_name_agreement','shared_channel_hold','identity_status'];
      const cell=value=>{let s=String(value??'');if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
      const rows=allResults.map(r=>[r.artist,r.tier,r.profileId,r.cmArtist,r.videoUrl,r.url,r.uploaderName,
        r.topicLabel,r.artistNameAgreement,owners.get(r.url).size>1,'Discovery only — channel and artist identity checks require next approval']);
      await durableStageFile(root+'/video-uploader-findings.csv','\ufeff'+[columns,...rows].map(r=>r.map(cell).join(',')).join('\r\n'));
    }
  }
}
