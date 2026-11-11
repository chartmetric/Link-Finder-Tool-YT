import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {evidenceDigest,youtubeVerificationInput,YOUTUBE_OWNERSHIP_RULES} from './youtube-ownership-policy.mjs';
import {assertYoutubeBudget,youtubeBudgetGate,reconcileYoutubeReceipts} from './youtube-ownership-budget.mjs';
import {normalizeYoutubeChannel,providerStopReason,youtubeDecisionRequest,parseYoutubeDecision,youtubeOwnershipTransport} from './youtube-ownership-transport.mjs';
import {reuseReturnedYoutubeRequest} from './youtube-ownership-recovery.mjs';
import {collectYoutubeOwnership} from './run-youtube-ownership-check.mjs';
const id='UC'+'a'.repeat(22);
const artist={profileId:'1',cmArtist:'101',name:'Jane Artist',catalogProfile:{profile_id:'1',cm_artist:'101'},accounts:[]};
const model={endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13',maxRequestBytes:6000};
function rawChannel(handle='janeartist',name='Jane Artist'){
  return {at:'2026-11-11T01:00:00Z',status:200,data:{success:true,channelId:id,
    channel:'http://www.youtube.com/@'+handle,name,description:'Singer and songwriter. Official releases.',
    links:['https://open.spotify.com/artist/'+'A'.repeat(22)],subscriberCount:12345}};
}
test('Documented channel response normalization binds HTTP canonical handles and preserves actual metadata',()=>{
  const packet=rawChannel(),capture=normalizeYoutubeChannel(packet,'https://www.youtube.com/@janeartist');
  assert.ok(capture);assert.equal(capture.body.handle,'janeartist');
  assert.equal(capture.body.displayName,'Jane Artist');assert.equal(capture.body.subscribers,12345);
  assert.equal(capture.body.isOfficialArtistChannel,false);
  assert.equal(capture.rawReceiptSha256,evidenceDigest(packet));
  assert.equal(normalizeYoutubeChannel(packet,'https://www.youtube.com/@someoneelse'),null);
  packet.data.channel='http://www.youtube.com.evil.invalid/@janeartist';
  assert.equal(normalizeYoutubeChannel(packet,'https://www.youtube.com/@janeartist'),null);
});
test('Provider errors are funding/access/unknown evidence, never a completed account absence',()=>{
  assert.equal(providerStopReason({status:403,data:{error:'no access'}}),'provider_authentication_or_access_failure');
  assert.equal(providerStopReason({status:404,data:{error:'insufficient credits'}}),'provider_funding_failure');
  assert.equal(providerStopReason({status:429,data:{}}),'provider_rate_limit');
  assert.equal(providerStopReason({status:200,data:null,parseFailed:true}),'unreadable_provider_response');
  assert.equal(providerStopReason({status:404,data:{error:'not_found'}}),null);
  assert.equal(normalizeYoutubeChannel({status:404,data:{error:'not_found'}},'https://www.youtube.com/@janeartist'),null);
});
test('Oversized frozen evidence is held before dispatch, not removed or silently shortened',()=>{
  const input=youtubeVerificationInput({...artist,context:{completeBiography:'x'.repeat(10000)}},
    {url:'https://www.youtube.com/@janeartist',capture:normalizeYoutubeChannel(rawChannel(),'https://www.youtube.com/@janeartist')});
  const p=youtubeDecisionRequest(input,{model});
  assert.equal(p.ready,false);
  assert.equal(p.request.body.state.artist.context.completeBiography.length,10000);
  assert.equal(p.request.body.state.evidenceRules,YOUTUBE_OWNERSHIP_RULES);
});
test('Budget checks preserve prior reservations and reject changed owners, foreign charges and cap exhaustion',()=>{
  const parent={id:'yt',status:'completed',cap_cents:200,reserved_cents:40};
  const phase={parent_id:'yt',owner:'owner',status:'running',cap_cents:136,prior_reserved_cents:40,reserved_cents:0};
  assert.doesNotThrow(()=>assertYoutubeBudget(parent,phase,'owner'));
  assert.throws(()=>assertYoutubeBudget({...parent,reserved_cents:0},phase,'owner'));
  assert.throws(()=>assertYoutubeBudget(parent,phase,'different'));
  assert.throws(()=>assertYoutubeBudget({...parent,reserved_cents:176},{...phase,reserved_cents:136},'owner'));
});
test('An uncertain dispatch stays admitted and is never replayed; later spending is blocked',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yt-owned-test-'));
  try{
    await fs.mkdir(dir+'/receipts');
    const pending=new Set();let calls=0;
    const gate={admit:async o=>{assert.equal(pending.size,0);pending.add(o.key);},
      returned:async()=>assert.fail('A timeout has no returned receipt.')};
    const request=youtubeOwnershipTransport({gate,archiveDir:dir,assertFrozen:async()=>{},
      credentials:{scrapecreators:'test-only'},fetchImpl:async()=>{calls++;throw Error('timeout');}});
    const r={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url=https%3A%2F%2Fwww.youtube.com%2F%40janeartist'};
    await assert.rejects(request({kind:'metadata',key:'one'},r));
    await assert.rejects(request({kind:'metadata',key:'one'},r));
    await assert.rejects(request({kind:'metadata',key:'two'},r));
    assert.equal(calls,1);assert.equal(pending.size,1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Transactional gate rejects unscoped or modified requests before touching a database',async()=>{
  const gate=youtubeBudgetGate({pool:{connect:async()=>assert.fail('No database calls allowed here.')},
    allowed:new Map([['channel',{kind:'metadata',inputSha256:'a'.repeat(64)}]])});
  await assert.rejects(gate.admit({key:'other',kind:'metadata',inputSha256:'a'.repeat(64)}));
  await assert.rejects(gate.admit({key:'channel',kind:'metadata',inputSha256:'b'.repeat(64)}));
});
test('One complete mocked flow separates Topic/unavailable channels and preserves low-score likely suggestions',async()=>{
  const urls=['https://www.youtube.com/@janeartist','https://www.youtube.com/@janetopic','https://www.youtube.com/@unavailable'];
  const records=[{artist,candidates:urls.map(url=>({url,title:'Saved search title',snippet:'Untrusted search snippet'})),searchStatus:'candidates_found'},
    {artist:{...artist,profileId:'2',cmArtist:'102',catalogProfile:{profile_id:'2',cm_artist:'102'},name:'No Candidate'},candidates:[],searchStatus:'no_match'}];
  const plan={model,metadataRequests:urls.map((channelUrl,i)=>({key:'m'+i,channelUrl,requestUrl:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(channelUrl)})),
    targets:urls.map(channelUrl=>({channelUrl}))};
  const seen=[],frozen=[];
  const result=await collectYoutubeOwnership({plan,records,
    request:async(op,request)=>{
      seen.push(op.kind);
      if(op.key==='m0')return rawChannel();
      if(op.key==='m1')return rawChannel('janetopic','Jane Artist - Topic');
      if(op.key==='m2')return {status:404,data:{error:'not_found'},at:'2026-11-11T01:00:00Z'};
      assert.equal(op.kind,'model');
      return {status:200,inputSha256:evidenceDigest(request),data:{model:model.expectedModel,usage:{cost:.001},
        answers:{same_identity:{noul:.47},verdict:{choice:'likely'},channel_type:{choice:'artist_owned'}}}};
    },
    onCapture:async()=>{},onAnswer:async()=>{},onHold:async()=>{},progress:async()=>{},
    freezeModel:async(key,sha)=>frozen.push({key,sha})});
  assert.equal(result.metadataCalls,3);assert.equal(result.modelCalls,1);assert.equal(frozen.length,1);
  const c=result.reviewed[0].candidates;
  assert.equal(c[0].decision.status,'likely_artist_owned');assert.equal(c[0].decision.score,.47);
  assert.equal(c[0].decision.liveLinkAccepted,false);
  assert.equal(c[1].decision.status,'related_catalog_channel');
  assert.equal(c[2].decision.status,'needs_channel_metadata');
  assert.equal(result.reviewed[1].outcome,'completed_no_channel_result');
  assert.deepEqual(seen,['metadata','metadata','metadata','model']);
});
test('The exact observed dated model resolution is accepted and archived; other model families remain blocked',()=>{
  const input={inputSha256:'a'.repeat(64)};
  const packet={status:200,inputSha256:'b'.repeat(64),data:{model:'typesafe/jev-1.13-20260917',
    usage:{cost:.000073122},answers:{same_identity:{noul:.64},verdict:{choice:'likely'},channel_type:{choice:'artist_owned'}}}};
  const answer=parseYoutubeDecision(packet,input,{model},'b'.repeat(64));
  assert.equal(answer.resolvedModel,'typesafe/jev-1.13-20260917');
  assert.equal(answer.answer.sameIdentityProbability,.64);
  assert.throws(()=>parseYoutubeDecision({...packet,data:{...packet.data,model:'typesafe/jev-1.14'}},input,{model},'b'.repeat(64)));
});
test('Explicit continuation requires every charged admission to have its exact returned receipt',()=>{
  const receipts=new Map([['one',{kind:'metadata',inputSha256:'h',receiptSha256:'r',status:200}]]);
  const admissions=[{operation_key:'one',kind:'metadata',status:'returned',input_sha256:'h',receipt_sha256:'r',http_status:200,reserved_cents:2}];
  const args={parent:{reserved_cents:42},phase:{reserved_cents:2},admissions,receipts};
  assert.doesNotThrow(()=>reconcileYoutubeReceipts(args));
  assert.throws(()=>reconcileYoutubeReceipts({...args,admissions:[{...admissions[0],status:'admitted'}]}));
  assert.throws(()=>reconcileYoutubeReceipts({...args,parent:{reserved_cents:40}}));
  assert.throws(()=>reconcileYoutubeReceipts({...args,receipts:new Map()}));
});
test('Saved paid responses are reused without dispatch and cannot be reassigned to another input',async()=>{
  const request={method:'POST',url:model.endpoint,body:{model:model.expectedModel}};
  const packet={kind:'model',inputSha256:evidenceDigest(request),request,status:200,data:{saved:true}};
  let calls=0;
  const dispatch=reuseReturnedYoutubeRequest(new Map([['paid',packet]]),async()=>{calls++;return 'new';});
  assert.equal(await dispatch({key:'paid',kind:'model'},request),packet);
  await assert.rejects(dispatch({key:'paid',kind:'model'},{...request,body:{changed:true}}));
  assert.equal(calls,0);
  assert.equal(await dispatch({key:'untouched',kind:'model'},request),'new');
  assert.equal(calls,1);
});
