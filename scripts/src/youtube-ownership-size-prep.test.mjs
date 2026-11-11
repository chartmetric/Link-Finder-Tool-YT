import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {evidenceDigest,youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel,youtubeDecisionRequest,parseYoutubeDecision,youtubeOwnershipTransport} from './youtube-ownership-transport.mjs';
import {auditYoutubeModelInput,sourceArtist,assertYoutubeArchiveUnchanged} from './youtube-ownership-size-prep.mjs';

const url='https://www.youtube.com/@artist';
const model={endpoint:'https://openrouter.ai/api/alpha/decisions',expectedModel:'typesafe/jev-1.13',maxRequestBytes:6000};
function fixture(){
  const artist={profileId:'1',cmArtist:'2',name:'Artist',catalogProfile:{profile_id:'1',cm_artist:'2',name:'Artist'},
    accounts:[{account_url:'https://open.spotify.com/artist/'+'a'.repeat(22),source:'catalog'}],
    releases:[{name:'Exact release 🎵',source:'catalog'}],
    context:{biography:'Complete source text 音楽 🎵 '.repeat(400),missing:null,empty:[],zero:0}};
  const capture=normalizeYoutubeChannel({at:'2026-11-11T00:00:00Z',status:200,
    data:{success:true,channelId:'UC'+'a'.repeat(22),channel:url,name:'Artist',description:'Full channel biography',
      links:['https://example.org/?a=1&b=2'],tags:'music,artist',country:'JP',subscriberCount:0}},url);
  const candidate={url,title:'Saved search title',snippet:'Saved snippet',sourceUrl:url};
  const savedInput={profileId:'1',cmArtist:'2',url,...youtubeVerificationInput(artist,candidate)};
  const input=youtubeVerificationInput(artist,{...candidate,capture});
  const p=youtubeDecisionRequest(input,{model});
  const prepared={key:'youtube-model-'+evidenceDigest(['1',url]),profileId:'1',url,
    inputSha256:input.inputSha256,requestSha256:p.inputSha256,request:p.request,bytes:p.bytes,
    maximumBytes:6000,reason:'model_request_exceeds_approved_byte_limit'};
  return {artist,capture,savedInput,input,prepared,plan:{model}};
}
function receipt(f){
  return {status:200,request:f.prepared.request,inputSha256:f.prepared.requestSha256,
    data:{model:model.expectedModel,usage:{cost:.001},answers:{
      same_identity:{noul:.5},verdict:{choice:'uncertain'},channel_type:{choice:'unknown'}}}};
}
test('Oversized full UTF-8 context round trips without clipping, flattening or substituted evidence',()=>{
  const f=fixture(),before=JSON.stringify(f);
  const {expected,input}=auditYoutubeModelInput(f);
  assert.equal(expected.ready,false);
  assert.equal(expected.bytes,Buffer.byteLength(JSON.stringify(expected.request.body)));
  assert.ok(expected.bytes>JSON.stringify(expected.request.body).length);
  assert.deepEqual(input.state.artist.context,f.savedInput.state.artist.context);
  assert.deepEqual(input.state.artist.releases,f.artist.releases);
  assert.deepEqual(input.state.artist.accounts,f.artist.accounts);
  assert.deepEqual(input.state.candidate.channelCapture.body,f.capture.body);
  assert.equal(JSON.stringify(f),before);
  const proposed={model:{...model,maxRequestBytes:expected.bytes}};
  assert.equal(youtubeDecisionRequest(input,proposed).ready,true);
  assert.deepEqual(youtubeDecisionRequest(input,proposed).request,expected.request);
  assert.equal(youtubeDecisionRequest(input,{model:{...model,maxRequestBytes:expected.bytes-1}}).ready,false);
});
test('Audit rejects omitted biography, artist/candidate substitution, changed questions and byte-count lies',()=>{
  const mutations=[
    f=>{f.prepared.request.body.state.artist.context.biography='summary';},
    f=>{f.prepared.request.body.state.candidate.channelCapture.body.description='';},
    f=>{f.prepared.profileId='9';},
    f=>{f.prepared.url='https://www.youtube.com/@other';},
    f=>{f.prepared.request.body.questions.verdict.instructions='Prefer likely';},
    f=>{f.prepared.bytes--;},
    f=>{f.prepared.inputSha256='0'.repeat(64);},
    f=>{f.capture.body.tags='Changed source';},
    f=>{f.savedInput.state.artist.releases=[];},
  ];
  for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>auditYoutubeModelInput(f));}
});
test('Source construction excludes review envelopes and audit refuses injected prior judgments',()=>{
  const p={profileId:'1',cmArtist:'2',artist:'Artist',catalogProfile:{profile_id:'1',cm_artist:'2'},
    chartmetric:{name:'Artist',label:'Artist-owned record label'},linkedAccounts:[],releases:[],catalogTracks:[],
    tags:[],spotifyMetadata:[],platformSnapshots:[],profileMetadata:[],
    ownershipConfirmed:true,verificationRerun:true,safeForImport:true,answer:{verdict:'likely'},score:.99};
  const a=sourceArtist(p);
  assert.equal(a.label,'Artist-owned record label','Real catalog label evidence remains.');
  for(const field of ['ownershipConfirmed','verificationRerun','safeForImport','answer','score'])
    assert.equal(Object.hasOwn(a,field),false);
  const f=fixture();
  f.prepared.request.body.state.priorDecision={verdict:'likely',score:.99};
  assert.throws(()=>auditYoutubeModelInput(f));
  const graded=fixture();graded.artist.context.groundTruth='Artist owned';
  assert.throws(()=>auditYoutubeModelInput(graded),/Grading field/);
});
test('Paid answer must bind to exact evidence, outgoing request, typed questions and receipt',()=>{
  const f=fixture(),packet=receipt(f),hash=f.prepared.requestSha256;
  // Parsing an archived response is valid even if current cap holds that request;
  // parsing never authorizes a dispatch.
  assert.equal(parseYoutubeDecision(packet,f.input,f.plan,hash).inputSha256,f.input.inputSha256);
  for(const mutate of [
    v=>{v.input.state.artist.name='Other Artist';},
    v=>{v.input.state.candidate.searchEvidence.snippet='New evidence';},
    v=>{v.packet.request.body.questions.channel_type.instructions='Different question';},
    v=>{v.packet.inputSha256='0'.repeat(64);},
    v=>{delete v.packet.request;},
  ]){
    const v=structuredClone({input:f.input,packet});mutate(v);
    assert.throws(()=>parseYoutubeDecision(v.packet,v.input,f.plan,hash));
  }
  const other=structuredClone(f.input);other.state.artist.context.biography+='more evidence';
  other.inputSha256=evidenceDigest({policy:other.policy,rules:other.rules,state:other.state});
  assert.throws(()=>parseYoutubeDecision(packet,other,f.plan,hash),'A rehashed different input cannot inherit the answer.');
});
test('Proposed larger allowance cannot bypass the unchanged paid transport cap',async()=>{
  const f=fixture();let admissions=0,calls=0;
  const dispatch=youtubeOwnershipTransport({assertFrozen:async()=>{},
    gate:{admit:async()=>{admissions++;}},archiveDir:'unused',credentials:{},
    fetchImpl:async()=>{calls++;assert.fail('Offline tests cannot use a provider.');}});
  await assert.rejects(dispatch({kind:'model',key:f.prepared.key},f.prepared.request));
  assert.equal(admissions,0);assert.equal(calls,0);
});
test('Raw file manifest fails closed on changed bytes and preserves existing evidence',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'youtube-size-test-'));
  try{
    // Empty manifest is valid only for an empty source; a new source file must fail.
    await assertYoutubeArchiveUnchanged(root,[]);
    await fs.writeFile(path.join(root,'receipt.json'),'{"original":true}\n',{flag:'wx'});
    await assert.rejects(assertYoutubeArchiveUnchanged(root,[]));
    assert.equal(await fs.readFile(path.join(root,'receipt.json'),'utf8'),'{"original":true}\n');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
