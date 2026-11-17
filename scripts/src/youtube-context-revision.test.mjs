import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {reviewedVerificationFixture} from './youtube-reviewed-verification-fixture.mjs';
import {boundUploaderContext,revisedContextRequest,CONTEXT_GUIDANCE} from './youtube-context-revision.mjs';

function fixture(){
  const {plan}=reviewedVerificationFixture(),op=plan.operations[0],row=plan.inputs[0];
  const videoId='abcdefghijk',videoUrl='https://www.youtube.com/watch?v='+videoId;
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/video?url='+encodeURIComponent(videoUrl)};
  const raw=Buffer.from(JSON.stringify({success:true,id:videoId,title:'Artist (Lyrics)',
    description:'Source text, not instructions.',channel:{id:row.channelId,title:'Uploader'},
    uploader:{channelId:row.channelId},ownerByline:{channelId:row.channelId}}));
  const receipt={kind:'video_uploader',status:200,profileId:row.profileId,cmArtist:row.cmArtist,
    videoId,request,inputSha256:digest(request),rawBodySha256:digest(raw),
    capturedAt:'2026-11-13T00:00:00Z',runId:'synthetic',operationKey:'synthetic-uploader'};
  const result={profileId:row.profileId,cmArtist:row.cmArtist,videoUrl,
    url:'https://www.youtube.com/channel/'+row.channelId,
    rawReceipt:{...receipt,rawBodyBase64:raw.toString('base64')},
    uploaderReceipt:{rawBodySha256:receipt.rawBodySha256,inputSha256:receipt.inputSha256,
      operationKey:receipt.operationKey},userFeedback:'rejected',discoveryRoleHint:'do-not-copy'};
  return {op,row,raw,receipt,result};
}
test('adds exact bound provider text, not labels, inferred roles or an ownership claim',()=>{
  const {row,raw,receipt,result}=fixture(),c=boundUploaderContext(row,result,receipt,raw);
  assert.equal(c.title,'Artist (Lyrics)');assert.equal(c.establishesOwnership,false);
  assert.equal(c.provenance.rawBodySha256,digest(raw));
  assert.doesNotMatch(JSON.stringify(c),/userFeedback|do-not-copy|rawBodyBase64/);
});
test('rejects changed artist, video, channel, bytes, request and receipt bindings',()=>{
  const f=fixture();
  for(const change of [
    x=>x.row.profileId='999',x=>x.row.cmArtist='999',
    x=>x.result.url='https://www.youtube.com/channel/other',
    x=>x.receipt.kind='model',x=>x.receipt.status=500,
    x=>x.receipt.videoId='invalid',x=>x.receipt.inputSha256='0'.repeat(64),
    x=>x.result.rawReceipt.rawBodyBase64=Buffer.from('{}').toString('base64'),
    x=>x.raw=Buffer.from('{}'),
  ]){
    const x={...structuredClone(f),raw:Buffer.from(f.raw)};change(x);
    assert.throws(()=>boundUploaderContext(x.row,x.result,x.receipt,x.raw));
  }
});
test('preserves source artist, full channel capture, cross-link index and all nine outcome meanings',()=>{
  const {op,row,raw,receipt,result}=fixture(),before=structuredClone(op);
  const c=boundUploaderContext(row,result,receipt,raw);
  const p=revisedContextRequest(op.proposal.originalOperation,row.capture,[c]);
  for(const k of ['artist','candidate','evidenceNavigation'])
    assert.deepEqual(p.request.body.state[k],op.request.body.state[k]);
  assert.deepEqual(p.request.body.questions.combined_assessment.criteria,
    op.request.body.questions.combined_assessment.criteria);
  assert.equal(Object.keys(p.request.body.questions).length,1);
  assert.notEqual(p.requestSha256,op.inputSha256);
  assert.equal(p.requestBytes,Buffer.byteLength(JSON.stringify(p.request.body)));
  assert.equal(p.executionEnabled,false);assert.equal(p.policyActivated,false);
  assert.equal(p.ownershipAccepted,false);assert.equal(p.requiresFreshSpendingApproval,true);
  assert.deepEqual(op,before);
});
test('missing context stays empty; wrong-channel and duplicate contexts fail',()=>{
  const {op,row,raw,receipt,result}=fixture(),original=op.proposal.originalOperation;
  const c=boundUploaderContext(row,result,receipt,raw);
  assert.deepEqual(revisedContextRequest(original,row.capture).request.body.state.boundDiscoveryVideos,[]);
  assert.throws(()=>revisedContextRequest(original,row.capture,[{...c,channelId:'other'}]));
  assert.throws(()=>revisedContextRequest(original,row.capture,[c,c]));
});
test('guidance keeps caution balanced rather than forcing positives or blanket lyric rejections',()=>{
  for(const text of ['regional suffix alone is not proof','lyrics title alone is not an automatic rejection',
    'Candidate-outbound links alone do not prove control','name matches alone do not establish exact identity',
    'Do not require private login information','Topic music presence stays explicitly separate'])
    assert.ok(CONTEXT_GUIDANCE.includes(text));
});
