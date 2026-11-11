import test from 'node:test';
import assert from 'node:assert/strict';
import {boundYoutubeCapture,evidenceDigest,evaluateYoutubeOwnership,youtubeVerificationInput} from './youtube-ownership-policy.mjs';
import {normalizeYoutubeChannel} from './youtube-ownership-transport.mjs';

// Synthetic, minimized fixtures using the exact address/identity fields observed
// in the two archived receipts. These are not full historical provider packets.
const cases=[
  {requested:'https://www.youtube.com/c/ShilohBros',channelId:'UCn3AViOfcFN4zIICMC5hvPg',
    channel:'http://www.youtube.com/@shilohandbros',handle:'@shilohandbros',name:'Shiloh & Bros'},
  {requested:'https://www.youtube.com/user/PARVEENKAJAL',channelId:'UCZGyMisvox_kDtILhyqwWJQ',
    channel:'http://www.youtube.com/@PARVEENKAJAL',handle:'@PARVEENKAJAL',name:'parveen kajal'},
];
function receipt(c){
  const request={method:'GET',url:'https://api.scrapecreators.com/v1/youtube/channel?url='+encodeURIComponent(c.requested)};
  return {kind:'metadata',status:200,at:'2026-11-11T01:00:00Z',request,
    inputSha256:evidenceDigest(request),parseFailed:false,
    data:{success:true,channelId:c.channelId,channel:c.channel,handle:c.handle,name:c.name}};
}
const clone=value=>structuredClone(value);
const artist={profileId:'1',cmArtist:'2',name:'Unreviewed Artist',catalogProfile:{profile_id:'1',cm_artist:'2'}};

for(const c of cases)test('Receipt-backed legacy resolution preserves provenance: '+c.requested,()=>{
  const raw=receipt(c),capture=normalizeYoutubeChannel(raw,c.requested);
  assert.ok(capture);
  assert.deepEqual(capture.rawReceipt,raw);
  const bound=boundYoutubeCapture(c.requested,capture);
  assert.ok(bound.aliases.includes(c.requested));
  assert.ok(bound.aliases.includes('https://www.youtube.com/channel/'+c.channelId));
  assert.equal(bound.resolution.returnedUrl,c.channel);
  assert.equal(bound.resolution.requestedUrl,c.requested);
  assert.equal(bound.resolution.rawReceiptSha256,evidenceDigest(raw));
  assert.equal(bound.resolution.requestSha256,evidenceDigest(raw.request));
  assert.equal(bound.body.handle,c.handle.slice(1).toLowerCase());
  // Raw receipts remain retained, but are not duplicated in the model input.
  assert.equal(bound.rawReceipt,undefined);
  assert.equal(youtubeVerificationInput(artist,{url:c.requested,capture}).readyForModel,true);
  const decision=evaluateYoutubeOwnership(artist,{url:c.requested,capture});
  assert.equal(decision.status,'needs_identity_check');
  assert.equal(decision.liveLinkAccepted,false);
  assert.equal(decision.reviewSuggestion,false);
});

test('Swapped receipts and requested targets cannot bind a legacy alias',()=>{
  const c=cases[0],raw=receipt(c),capture=normalizeYoutubeChannel(raw,c.requested);
  assert.equal(normalizeYoutubeChannel(raw,cases[1].requested),null);
  assert.equal(normalizeYoutubeChannel(raw,'https://www.youtube.com/@somebodyelse'),null);
  for(const change of [
    p=>{delete p.request;},p=>{p.kind='model';},p=>{p.inputSha256='0'.repeat(64);},
    p=>{p.request.method='POST';p.inputSha256=evidenceDigest(p.request);},
    p=>{p.request.url=p.request.url.replace('api.scrapecreators.com','evil.invalid');p.inputSha256=evidenceDigest(p.request);},
    p=>{p.request.url+='&url='+encodeURIComponent(cases[1].requested);p.inputSha256=evidenceDigest(p.request);},
    p=>{p.request.url=p.request.url.replace(encodeURIComponent(c.requested),encodeURIComponent(cases[1].requested));p.inputSha256=evidenceDigest(p.request);},
    p=>{delete p.data.channel;},
    p=>{p.data.channel='https://www.youtube.com/channel/'+cases[1].channelId;delete p.data.handle;},
  ]){
    const altered=clone(raw);change(altered);
    assert.equal(normalizeYoutubeChannel(altered,c.requested),null);
  }
  for(const change of [
    p=>{delete p.rawReceipt;},p=>{p.rawReceiptSha256='0'.repeat(64);},
    p=>{p.rawReceipt=receipt(cases[1]);p.rawReceiptSha256=evidenceDigest(p.rawReceipt);},
    p=>{p.body.channelId=cases[1].channelId;p.bodySha256=evidenceDigest(p.body);},
    p=>{p.body.handle='invented';p.bodySha256=evidenceDigest(p.body);},
    p=>{p.body.url='https://www.youtube.com/@invented';p.bodySha256=evidenceDigest(p.body);},
    p=>{p.capturedAt='2026-11-10T00:00:00Z';},
    p=>{p.requestedUrl=cases[1].requested;},
  ]){
    const altered=clone(capture);change(altered);
    assert.equal(boundYoutubeCapture(c.requested,altered),null);
  }
});

test('Spoofed returned domains cannot fall back to the supplied channel ID',()=>{
  for(const channel of [
    'http://www.youtube.com.evil.invalid/@shilohandbros',
    'https://youtube.com@evil.invalid/@shilohandbros',
    'https://evil.invalid/channel/'+cases[0].channelId,
    'https://www.youtube.com:444/@shilohandbros',
  ]){
    const raw=receipt(cases[0]);raw.data.channel=channel;
    assert.equal(normalizeYoutubeChannel(raw,cases[0].requested),null);
    assert.equal(normalizeYoutubeChannel(raw,'https://www.youtube.com/channel/'+cases[0].channelId),null);
  }
  const raw=receipt(cases[0]);raw.data.handle='@invented';
  assert.equal(normalizeYoutubeChannel(raw,cases[0].requested),null);
});

test('Returned handles and channel IDs remain exact identities, not name aliases',()=>{
  const c=cases[1],raw=receipt(c);
  // A real separate candidate for the same artist must not be merged by name.
  assert.equal(normalizeYoutubeChannel(raw,'https://www.youtube.com/channel/UC3YYo-SiLz2RkthVXeDzb0w'),null);
  raw.data.channel='https://www.youtube.com/channel/'+c.channelId;
  delete raw.data.handle;
  const capture=normalizeYoutubeChannel(raw,c.requested);
  assert.ok(capture);
  assert.equal(capture.body.handle,null);
  assert.deepEqual(boundYoutubeCapture(c.requested,capture).aliases,
    ['https://www.youtube.com/channel/'+c.channelId,c.requested]);
});
