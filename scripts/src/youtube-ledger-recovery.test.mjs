import './youtube-ownership-offline-fence.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,proposedUploaderRequest} from './youtube-video-discovery-offline.mjs';
import {videoStagePlan,approveVideoStage} from './youtube-video-stage.mjs';
import {validateRecoveryLedger} from './prepare-youtube-ledger-recovery.mjs';

function fixture(){
  const artists=Array.from({length:20},(_,i)=>({profileId:String(i+1),cmArtist:String(i+101),
    name:'Fixture '+i,tier:2,snapshotAt:'2026-11-12T01:30:00Z'}));
  const operations=artists.flatMap(a=>['abcdefghijk','lmnopqrstuv'].map(videoId=>{
    const videoUrl='https://www.youtube.com/watch?v='+videoId;
    return {...a,kind:'video_uploader',key:`video_uploader-${a.profileId}-${a.cmArtist}-${videoId}`,
      videoId,videoUrl,request:proposedUploaderRequest(videoUrl)};
  }));
  const plan=videoStagePlan({id:'youtube-video-review-recovery-fixture',sourceRunId:'fixture',
    sourcePlanSha256:'a'.repeat(64),preparedAt:'2026-11-12T02:00:00Z',artists,operations,
    evidenceFiles:{'evidence/source.json':'b'.repeat(64)},runtimeFiles:{'runtime/run.mjs':'c'.repeat(64)}});
  const approval=approveVideoStage(plan,{expectedPlanSha256:digest(plan),capCents:80,
    approvedAt:'2026-11-12T02:01:00Z'});
  const run={id:plan.id,status:'stopped',owner:'fixture-owner',plan_sha256:digest(plan),
    approval_sha256:digest(approval),cap_cents:80,reserved_cents:6};
  const saved=plan.operations.slice(0,3).map((op,i)=>{
    const artist=artists.find(a=>a.profileId===op.profileId);
    const rawBody=Buffer.from(JSON.stringify({success:true,credits_charged:1,id:op.videoId,
      channel:{id:'UCabcdefghijklmnopqrstuv',title:'Loïc Hobi',url:'https://www.youtube.com/@Lo%C3%AFcHobi'}}));
    const receipt={runId:plan.id,planSha256:digest(plan),profileId:op.profileId,cmArtist:op.cmArtist,
      videoId:op.videoId,operationKey:op.key,kind:op.kind,request:op.request,inputSha256:op.inputSha256,
      status:200,capturedAt:'2026-11-12T02:03:00Z',rawPath:'receipts/'+digest(op.key)+'.raw',
      rawBodySha256:digest(rawBody)};
    return {artist,receipt,rawBody,clue:{profileId:op.profileId,cmArtist:op.cmArtist,
      videoId:op.videoId,url:op.videoUrl,operation:op,sources:[]},
      ...(i<2?{result:{profileId:op.profileId,cmArtist:op.cmArtist,videoUrl:op.videoUrl,
        url:'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',ownershipAccepted:false}}:{})};
  });
  const admissions=saved.map((s,i)=>({
    run_id:plan.id,operation_key:s.receipt.operationKey,profile_id:s.artist.profileId,cm_artist:s.artist.cmArtist,
    video_id:s.clue.videoId,input_sha256:s.receipt.inputSha256,status:i<2?'returned':'admitted',
    receipt_sha256:i<2?digest(s.receipt):null,raw_sha256:i<2?digest(s.rawBody):null,http_status:i<2?200:null,
  }));
  return {plan,approval,run,saved,admissions};
}
test('single saved-response recovery supports prior returns without replaying or refunding them',()=>{
  const f=fixture(),snapshot=digest({...f,saved:f.saved.map(s=>({...s,rawBody:s.rawBody.toString('base64')}))});
  assert.equal(validateRecoveryLedger(f).operation_key,f.admissions[2].operation_key);
  assert.equal(f.run.reserved_cents,6);assert.equal(f.admissions[2].status,'admitted');
  assert.equal(digest({...f,saved:f.saved.map(s=>({...s,rawBody:s.rawBody.toString('base64')}))}),snapshot);
});
test('recovery rejects owner/status/approval/reservation drift and ambiguous pending work',()=>{
  for(const mutate of [
    f=>f.run.status='running',f=>f.run.owner='',f=>f.run.plan_sha256='0'.repeat(64),
    f=>f.run.approval_sha256='0'.repeat(64),f=>f.run.reserved_cents=2,f=>f.run.cap_cents=2,
    f=>f.admissions[0].status='admitted',f=>f.admissions[2].status='returned',
    f=>f.admissions.push(f.admissions[0]),f=>f.admissions[2].cm_artist='999',
    f=>f.admissions[2].receipt_sha256='0'.repeat(64),
  ]){
    const f=fixture();mutate(f);assert.throws(()=>validateRecoveryLedger(f));
  }
});
test('recovery requires every historical saved receipt and no artist-acceptance substitution',()=>{
  for(const mutate of [
    f=>f.saved.pop(),f=>f.saved[0].receipt.rawBodySha256='0'.repeat(64),
    f=>f.admissions[0].receipt_sha256='0'.repeat(64),
    f=>f.admissions[0].raw_sha256='0'.repeat(64),
    f=>delete f.saved[0].result,f=>f.saved[0].result.ownershipAccepted=true,
    f=>f.saved[0].result.url='https://www.youtube.com/channel/UCdifferent',
    f=>f.saved[2].result=f.saved[0].result,
    f=>f.saved[2].receipt.request={...f.saved[2].receipt.request,url:'https://evil.test'},
  ]){
    const f=fixture();mutate(f);assert.throws(()=>validateRecoveryLedger(f));
  }
});
