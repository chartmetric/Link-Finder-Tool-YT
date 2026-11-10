import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {LOSSLESS_REQUEST_V4,encodeLosslessState,decodeLosslessState} from './instagram-lossless-request.mjs';
import {jevRequest,fitArtistContext,createLiveTransport,completeJevDraft} from './instagram-pilot-live-transport.mjs';
import {IDENTITY_CONTEXT_RUBRIC} from './instagram-ownership-rubric.mjs';
import {losslessDraftFor,auditLosslessRequests} from './instagram-lossless-request-audit.mjs';
import {frozenJevTransport} from './instagram-frozen-jev.mjs';
import {prepareContextualTest} from './instagram-contextual-test-prep.mjs';
import {checkContextualIdentity} from './instagram-contextual-identity-check.mjs';

const encode=JSON.stringify,hash=v=>createHash('sha256').update(v).digest('hex');
const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
const url='https://www.instagram.com/source_fixture/';
function fixture(){
  const player={profile_id:'1',artist:'Unmatched catalog artist',account_ids:['a'],
    accounts:[{platform:'spotify',account_id:'a',account_url:music}]};
  return {key:'one',profileId:'1',role:'candidate',status:'prepared',artist:player.artist,url,player,
    context:{ownershipConfirmed:false,items:[{kind:'bio',platform:'youtube',source:'saved_snapshot',
      text:'Instagram @source_fixture — 音楽 🎵 "quoted" \\ path\nunknown ownership',
      sourceUrl:'https://www.youtube.com/@fixture',binding:'profile_only',accountId:'old-account',
      asOf:null,ageDays:null,stale:true}]},
    profile:{url,identityComparison:{status:'likely',score:0.99,reasons:['PRIOR_WORKFLOW_JUDGMENT'],
      reference:{platform:'spotify',url:music,displayName:'Catalog',externalUrls:[]},
      candidate:{platform:'instagram',url,displayName:'Account',bio:'Musician',externalUrls:[music]}},
      discoveryEvidence:[{kind:'post_mention',sourceUrl:'https://www.instagram.com/p/source_fixture/',
        title:'Unconfirmed search snippet',snippet:'Fan or collaborator?',observedAt:null,
        publishedAt:null,ownershipConfirmed:false}],
      jevVerification:{sameIdentityProbability:0.99,verdict:'verified'}}};
}
const payload=s=>({artist:s.artist,catalogReference:{platform:'spotify',url:music},profiles:[s.profile],
  artistContext:s.context,ownershipRubric:IDENTITY_CONTEXT_RUBRIC,requestSerialization:LOSSLESS_REQUEST_V4});

test('transparent encoding is reversible for Unicode, escapes, null, false, repeated sources and reserved-looking keys',()=>{
  const literal='音楽 🎵 café العربية "quoted" \\ \n\t\u0000 '.repeat(50);
  const original={items:Array.from({length:12},(_,i)=>({source:literal,text:literal,
    kind:'bio',stale:false,unknown:null,index:i,empty:[],special:JSON.parse('{"__proto__":"source","$":2,"0":[false,null]}')}))};
  const before=encode(original),encoded=encodeLosslessState(original);
  assert.equal(encoded.encoding,'tables');assert.deepEqual(decodeLosslessState(JSON.parse(encode(encoded))),original);
  assert.ok(Buffer.byteLength(encode(encoded))<Buffer.byteLength(before));
  assert.ok(encode(encoded).includes('音楽'),'Source text must remain readable, not a binary blob.');
  assert.equal(encode(original),before);
  const small=encodeLosslessState({artist:'Small',empty:{},array:[1,false,null]});
  assert.equal(small.encoding,'plain');assert.deepEqual(decodeLosslessState(small),{artist:'Small',empty:{},array:[1,false,null]});
  for(const s of [{serialization:'source field',encoding:'plain'},{$:1},[{$:2},'3'],null]){
    assert.deepEqual(decodeLosslessState(encodeLosslessState(s)),s);
  }
});

test('invalid versions, schema rows and string references fail explicitly',()=>{
  assert.throws(()=>decodeLosslessState({serialization:'future'}),/invalid/);
  const packet={serialization:LOSSLESS_REQUEST_V4,encoding:'tables',schemas:[['x']],strings:['value'],evidence:{0:[{$:0}]}};
  assert.deepEqual(decodeLosslessState(packet),{x:'value'});
  for(const evidence of [{0:[]},{0:[{$:99}]},{0:[{$:-1}]},{bad:[]},{0:[1],1:[]},{99:[1]}])
    assert.throws(()=>decodeLosslessState({...packet,evidence}),/Invalid/);
});

test('complete state retains every raw catalog, declaration, post, path, date and uncertainty without clipping',()=>{
  const saved=fixture(),p=saved.profile;
  saved.context.items[0].text+='界'.repeat(1500);
  p.identityComparison.candidate.bio='界'.repeat(1500);
  p.identityComparison.reference.displayName='É'.repeat(200);
  p.identityComparison.candidate.externalUrls=Array.from({length:15},(_,i)=>`https://example.org/${i}`);
  p.discoveryEvidence=Array.from({length:45},(_,i)=>({...p.discoveryEvidence[0],
    title:`Saved post ${i}`,snippet:'界'.repeat(1300),observedAt:'2020-01-01',date:null}));
  p.identityComparison.catalogConnections=[{platform:'youtube',targetUrl:'https://www.youtube.com/@fixture',
    accountId:'a',sourceUrl:url,binding:'exact_saved_catalog',asOf:'2020-01-01',stale:true,uncertainty:'source claim'}];
  p.identityComparison.candidate.externalLinkEvidence={status:'unresolved',sourceUrl:'https://example.org/hub',
    ownershipConfirmed:false,pages:[{sourceUrl:'https://example.org/hub',contentUrl:music,
      contentType:'artist',musicTargets:[music],observedAt:null,binding:'source_claim',
      linkEvidence:[{sourceUrl:'https://example.org/hub',targetUrl:music,kind:'declared_profile_link'}]}]};
  const before=encode(saved),draft=losslessDraftFor(saved),decoded=decodeLosslessState(draft.body.state);
  assert.equal(draft.status,'held_oversized');assert.equal(draft.sent,false);
  assert.deepEqual(decoded.artistContext.savedCatalogContext,saved.context);
  assert.equal(decoded.candidates[0].candidate.bio.length,1500);
  assert.equal(decoded.candidates[0].reference.displayName.length,200);
  assert.deepEqual(decoded.candidates[0].savedDiscoveryEvidence,p.discoveryEvidence);
  assert.deepEqual(decoded.candidates[0].catalogConnections,p.identityComparison.catalogConnections);
  assert.deepEqual(decoded.candidates[0].candidate.externalLinkEvidence,p.identityComparison.candidate.externalLinkEvidence);
  assert.equal(decoded.candidates[0].candidate.musicLinkPath.ownershipAssessment,'unassessed');
  assert.doesNotMatch(encode(draft.body),/PRIOR_WORKFLOW_JUDGMENT|jevVerification/);
  assert.equal(encode(saved),before);
});

test('explicit v4 does not change default request bytes or rubric; fitting holds instead of dropping any evidence',()=>{
  const s=fixture(),p=payload(s);
  const legacy={...p,requestSerialization:undefined},before=encode(jevRequest(legacy));
  const draft=jevRequest(p),complete=completeJevDraft(p);
  assert.deepEqual(draft.questions,complete.questions);
  assert.deepEqual(decodeLosslessState(draft.state),complete.state);
  assert.equal(encode(jevRequest(legacy)),before);
  assert.equal(fitArtistContext(p,6000),p);
  assert.throws(()=>fitArtistContext(p,6001),/must not exceed/);
  assert.throws(()=>jevRequest({...p,requestSerialization:'implicit'}),/Unknown/);
  assert.throws(()=>jevRequest({...p,contextDelivery:{omittedPostRecords:1}}),/cannot restore/);
  assert.throws(()=>jevRequest({...p,ownershipRubric:'wrong'}),/explicit/);
  const large={...p,artist:'界'.repeat(6000)};
  assert.throws(()=>fitArtistContext(large,6000),/No evidence omitted/);
});

test('exact UTF-8 byte boundary is enforced and both live transports refuse experimental drafts before HTTP',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lossless-transport-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const p=payload(fixture());
  const size=Buffer.byteLength(encode(jevRequest(p)));
  assert.ok(size<6000);p.artist+='x'.repeat(6000-size);
  const body=jevRequest(p);
  assert.equal(new TextEncoder().encode(encode(body)).length,6000);
  assert.equal(fitArtistContext(p,6000),p);
  assert.throws(()=>fitArtistContext({...p,artist:p.artist+'🎵'},6000),/6004 bytes/);
  let calls=0;const forbidden=async()=>{calls++;throw Error('No network calls allowed');};
  const transport=createLiveTransport({responseDir:dir,fetchImpl:forbidden,publicFetchImpl:forbidden,
    keys:{SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'}});
  assert.equal(transport.inputBytes({kind:'jev',payload:p}),6000);
  await assert.rejects(transport.dispatch({kind:'jev',key:'one',payload:p}),/draft-only/);
  const frozen=frozenJevTransport({responseDir:dir,apiKey:'fixture',fetchImpl:forbidden});
  await assert.rejects(frozen.dispatch({kind:'jev',key:'one',payload:{body,inputSha256:hash(encode(body))}}),/draft-only/);
  assert.equal(calls,0);assert.deepEqual(await fs.readdir(dir),[]);
});

async function savedBatch(dir){
  const batch=path.join(dir,'batch');
  await fs.mkdir(path.join(batch,'execution-paid/responses'),{recursive:true});
  await fs.mkdir(path.join(batch,'shared-rule-fix-offline/unsent-drafts'),{recursive:true});
  const first=fixture(),second=fixture();
  second.key='two';second.context.items[0].text='界'.repeat(5000);
  const source=[first,second,{profileId:'2',artist:'Missing',role:'candidate',status:'held',reason:'Missing saved account evidence.'}];
  const write=async(name,value)=>fs.writeFile(path.join(batch,name),encode(value));
  const results=[],requests=[],drafts=[];
  for(const s of [first,second]){
    const original=jevRequest({...payload(s),requestSerialization:undefined,ownershipRubric:undefined});
    const sha256=hash(encode(original)),model=original.model;
    requests.push({key:s.key,profileId:s.profileId,role:s.role,sha256,body:original});
    results.push({key:s.key,role:s.role,instagramUrl:s.url,score:0.5,verdict:'uncertain',model});
    await write(`execution-paid/responses/${s.key}.json`,{status:200,requestBodySha256:sha256,
      decisionRequest:original,data:{model,answers:{candidate_0_same_identity:{noul:0.5},candidate_0_verdict:{choice:'uncertain'}}}});
    try{
      const fitted=fitArtistContext({...payload(s),requestSerialization:undefined},6000);
      const body=jevRequest({...fitted,compactEvidence:true});
      if(Buffer.byteLength(encode(body))>6000)throw Error('held');
      const draft={key:s.key,body,bytes:Buffer.byteLength(encode(body)),sha256:hash(encode(body)),sent:false};
      drafts.push(draft);await write(`shared-rule-fix-offline/unsent-drafts/${s.key}.json`,draft);
    }catch{}
  }
  const scope={artists:[first.player,{profile_id:'2',artist:'Missing'}],expectedModel:requests[0].body.model,requests};
  await write('scope.json',scope);await write('source-rows.json',source);
  await write('receipt.json',{scopeSha256:hash(encode(scope)),sourceRowsSha256:hash(encode(source))});
  await fs.writeFile(path.join(batch,'execution-paid/results.jsonl'),results.map(encode).join('\n')+'\n');
  const inputFiles=['scope.json','source-rows.json','receipt.json','execution-paid/results.jsonl',
    ...results.map(r=>`execution-paid/responses/${r.key}.json`)];
  await write('shared-rule-fix-offline/summary.json',{inputs:await Promise.all(inputFiles.map(async file=>
    ({file,sha256:hash(await fs.readFile(path.join(batch,file)))}))),unchangedRecordedDecisions:2,
    requestPreparationHolds:2-drafts.length,completeUnsentDrafts:drafts.length});
  return batch;
}

test('whole-batch audit includes oversized and missing cases, verifies frozen hashes, and never fetches or overwrites',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lossless-audit-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const batch=await savedBatch(dir),out=path.join(dir,'audit');
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No new fetches permitted');};
  const options={requestSerialization:LOSSLESS_REQUEST_V4};
  try{
    await assert.rejects(auditLosslessRequests(batch,out),/Explicit/);
    await assert.rejects(auditLosslessRequests(batch,path.join(batch,'new'),options),/outside/);
    const summary=await checkContextualIdentity(batch,out,options);
    assert.equal(summary.savedRequests,2);assert.equal(summary.reconstructedContextEqual,2);
    assert.equal(summary.reconstructedSourceStateEqual,2);assert.equal(summary.missingSavedEvidenceHolds,1);
    assert.equal(summary.completeUnsentDrafts+summary.oversizedHolds,2);
    assert.equal(summary.frozenArchiveUnchanged,true);assert.equal(summary.executionAllowed,false);
    assert.equal(summary.paidCalls,0);assert.equal(summary.tokenLimitChanges,0);
    const rows=(await fs.readFile(path.join(out,'request-audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,3);assert.equal(rows.at(-1).bytes,null);
    const drafts=(await fs.readFile(path.join(out,'unsent-drafts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    for(const d of drafts){assert.equal(d.sent,false);assert.equal(hash(encode(d.body)),d.sha256);
      assert.equal(Buffer.byteLength(encode(d.body)),d.bytes);assert.ok(decodeLosslessState(d.body.state));}
    assert.ok(drafts.some(d=>d.status==='held_oversized'));
    const original=await fs.readFile(path.join(out,'summary.json'),'utf8');
    await assert.rejects(prepareContextualTest(batch,out,options),{code:'EEXIST'});
    assert.equal(await fs.readFile(path.join(out,'summary.json'),'utf8'),original);
    await fs.appendFile(path.join(batch,'execution-paid/results.jsonl'),' ');
    await assert.rejects(auditLosslessRequests(batch,path.join(dir,'tampered'),options),/Changed saved input/);
    await assert.rejects(fs.stat(path.join(dir,'tampered')),{code:'ENOENT'});
  }finally{globalThis.fetch=oldFetch;}
});
