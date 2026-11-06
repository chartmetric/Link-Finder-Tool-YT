import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLiveTransport,jevRequest,cachedPacketFor,serperQuery} from './instagram-pilot-live-transport.mjs';
import {evaluateKnownCases,parseApprovedCap,loadCompletedPilotCache} from './instagram-pilot-live.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ig-live-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  return dir;
}
const keys = {SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'};
const candidate = {url:'https://www.instagram.com/example/',externalUrls:[],bio:'musician'};
const reference = {url:'https://open.spotify.com/artist/0123456789ABCDEFGHIJKL',platform:'spotify'};
const req = (kind,payload={}) => ({profileId:'1',key:`1:${kind}:0`,kind,payload,signal:new AbortController().signal});

test('live transport uses fixed Serper endpoint and preserves blind query and raw evidence',async t=>{
  const dir = await temp(t);
  let calls=0;
  const transport=createLiveTransport({keys,responseDir:dir,fetchImpl:async(url,options)=>{
    calls++; assert.equal(url,'https://google.serper.dev/search'); assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body); assert.match(body.q,/Example Artist/);
    assert.ok(!body.q.includes('known_answer'));
    return Response.json({organic:[{link:candidate.url,title:'Example Artist'},
      {link:'https://www.instagram.com/p/post/',title:'Post'}]});
  }});
  const result=await transport.dispatch(req('serper',{artist:'Example Artist',queryIndex:0}));
  assert.equal(calls,1); assert.equal(result.profiles.length,1);
  const raw=JSON.parse(await fs.readFile(path.join(dir,'1-serper-0.json'),'utf8'));
  assert.equal(raw.data.organic.length,2); assert.equal(raw.status,200);
});

test('Instagram retains actual external links and binds username from response, not request',async t=>{
  const transport=createLiveTransport({keys,responseDir:await temp(t),fetchImpl:async()=>Response.json({
    credits_charged:1,data:{user:{username:'another',external_url:reference.url,
      bio_links:[{url:'https://linktr.ee/another'}],full_name:'Another Artist'}}})});
  const result=await transport.dispatch(req('scrapecreators_candidate',{url:candidate.url}));
  assert.equal(result.url,'https://www.instagram.com/another/');
  assert.deepEqual(result.externalUrls,[reference.url,'https://linktr.ee/another']);
});

test('restricted response is unresolved; credit failures stop globally; requests never retry',async t=>{
  for(const [status,data,fatal] of [
    [403,{error:'Restricted profile. You must be 18 years old.'},false],
    [402,{error:'Insufficient credits'},true],
    [403,{error:'Invalid API key'},true],
  ]){
    let calls=0;
    const transport=createLiveTransport({keys,responseDir:await temp(t),fetchImpl:async()=>{
      calls++;return Response.json(data,{status});
    }});
    await assert.rejects(transport.dispatch(req('scrapecreators_candidate',{url:candidate.url})),
      e=>e.fatalProvider===fatal);
    assert.equal(calls,1);
  }
});

test('JEV endpoint uses typed decisions, checks complete request size and records exact cost',async t=>{
  let calls=0;
  const transportDir=await temp(t);
  const transport=createLiveTransport({keys,responseDir:transportDir,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://openrouter.ai/api/alpha/decisions');
    const body=JSON.parse(options.body);assert.equal(body.model,'typesafe/jev-1.13');
    assert.ok(Buffer.byteLength(options.body)<=6000);
    return Response.json({accessToken:'fixture-never-preserve',usage:{cost:0.0002,input_tokens:768,output_tokens:10},answers:{candidate_0_same_identity:{noul:0.97},
      candidate_0_verdict:{choice:'verified'}}});
  }});
  const payload={artist:'Example',catalogReference:reference,
    profiles:[{url:candidate.url,identityComparison:{reference,candidate}}]};
  const result=await transport.dispatch(req('jev',payload));
  assert.equal(result[0].jevVerification.sameIdentityProbability,0.97);
  const packet=JSON.parse(await fs.readFile(path.join(transportDir,'1-jev-0.json'),'utf8'));
  assert.equal(packet.data.usage.input_tokens,768);
  assert.equal(packet.data.usage.output_tokens,10);
  assert.equal(packet.data.accessToken,'[redacted]');
  assert.deepEqual(packet.decisionRequest,JSON.parse(JSON.stringify(jevRequest(payload))));
  assert.match(packet.requestBodySha256,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(packet,'headers'),false);
  assert.equal(calls,1);
  const huge={...payload,artist:'x'.repeat(7000)};
  await assert.rejects(transport.dispatch(req('jev',huge)),/6000-byte/);
  assert.equal(calls,1);
  assert.ok(jevRequest(payload).questions.candidate_0_same_identity);
});

test('JEV retains source-bound music edges without pre-deciding ownership or equating uncertainty with mismatch',()=>{
  const album='https://open.spotify.com/album/AAAAAAAAAAAAAAAAAAAAAA';
  const track='https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB';
  const sourceUrl='https://onerpm.link/example';
  const evidence={sourceUrl,status:'exact_catalog_music_identity',ownershipConfirmed:false,
    pages:[
      {sourceUrl,musicTargets:[album]},
      {sourceUrl:`https://open.spotify.com/embed/album/AAAAAAAAAAAAAAAAAAAAAA`,contentUrl:album,
        contentType:'album',musicTargets:[track]},
      {sourceUrl:`https://open.spotify.com/embed/track/BBBBBBBBBBBBBBBBBBBBBB`,contentUrl:track,
        contentType:'track',creditedArtistUrls:[reference.url]},
    ]};
  const body=jevRequest({artist:'Example',catalogReference:reference,profiles:[
    {url:candidate.url,identityComparison:{reference,candidate:{...candidate,externalLinkEvidence:evidence}}},
  ]});
  const path=body.state.candidates[0].candidate.musicLinkPath;
  assert.equal(path.sourceUrl,sourceUrl);
  assert.deepEqual(path.pages[0].musicTargets,[album]);
  assert.deepEqual(path.pages[1].musicTargets,[track]);
  assert.equal(path.pages[1].contentUrl,album);
  assert.equal(path.pages[2].contentType,'track');
  assert.deepEqual(path.pages[2].creditedArtistUrls,[reference.url]);
  assert.equal(path.ownershipAssessment,'unassessed');
  assert.equal(Object.hasOwn(path,'ownershipConfirmed'),false);
  assert.equal(evidence.ownershipConfirmed,false); // Never mutate saved evidence.
  const question=body.questions.candidate_0_same_identity;
  assert.match(question.instructions,/Missing, unavailable or unsupported evidence means uncertainty, not mismatch/);
  assert.doesNotMatch(question.criteria.false,/insufficient|missing/);
  assert.match(question.criteria.false,/different identity/);
  assert.ok(Buffer.byteLength(JSON.stringify(body))<=6000);
  const withoutMusic=jevRequest({artist:'Example',catalogReference:reference,profiles:[
    {url:candidate.url,identityComparison:{reference,candidate}},
  ]});
  assert.equal(withoutMusic.state.candidates[0].candidate.musicLinkPath,undefined);
});

test('JEV receives the exact observed bio link as a connection, not ownership proof',()=>{
  const exact = `${reference.url}?si=tracking`;
  const request = jevRequest({artist:'Example',catalogReference:reference,profiles:[
    {url:candidate.url,identityComparison:{status:'likely',reasons:['Exact catalog account cross-link'],
      reference,candidate:{...candidate,externalUrls:[exact]}}},
  ]});
  const item=request.state.candidates[0];
  assert.deepEqual(item.observedExactCatalogLinks,[{
    source:'instagram_profile_bio_link',targetUrl:reference.url,
  }]);
  assert.equal(item.identityComparisonStatus,'likely');
  assert.match(request.questions.candidate_0_same_identity.instructions,/not by itself proof of account ownership/);
  assert.ok(Buffer.byteLength(JSON.stringify(request))<6000);
});

test('missing billing evidence fails closed; unsafe link hubs cause zero HTTP requests',async t=>{
  let calls=0;
  const transport=createLiveTransport({keys,responseDir:await temp(t),fetchImpl:async()=>{
    calls++;return Response.json({data:{user:{username:'example'}}});
  }});
  await assert.rejects(transport.dispatch(req('public_page',{url:'https://127.0.0.1/'})),/Unsafe/);
  await assert.rejects(transport.dispatch(req('public_page',{url:'https://linktr.ee.evil.test/test'})),/Unsafe/);
  assert.equal(calls,0);
  await assert.rejects(transport.dispatch(req('scrapecreators_candidate',{url:candidate.url})),
    e=>e.fatalProvider===true);
  assert.equal(calls,1);
});

test('dollar reservations are serialized, durable, and never refunded after uncertain dispatch',async t=>{
  const dir=await temp(t);
  const manifest={run_allowed:true,authorization:{approved:true,maxSpendCents:1},
    artists:[{profile_id:'1',source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}}],
    proposed_limits:{serper_requests_total:68,scrapecreators_requests_total:103,jev_requests_total:34,
      public_spotify_oembed_requests_total:33,public_official_or_linkhub_page_requests_total:34,
      serper_requests_per_artist:2,instagram_candidate_metadata_per_artist:3,reference_metadata_per_artist:1,
      jev_requests_per_artist:1,paid_http_requests_total:205,global_concurrent_provider_requests:5,
      per_request_timeout_seconds:20,jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000}};
  let calls=0;
  const journalPath=path.join(dir,'admissions.jsonl');
  const budget=await createPilotBudget({manifest,journalPath,mode:'live',transport:{live:true,dispatch:async()=>{
    calls++;const rows=(await fs.readFile(journalPath,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].reserveCents,1);throw new Error('network failure');
  }}});
  await Promise.allSettled([budget.request({profileId:'1',kind:'serper',key:'one'}),
    budget.request({profileId:'1',kind:'serper',key:'two'})]);
  assert.equal(calls,1);assert.equal(budget.snapshot().reservedSpendCents,1);
  assert.match(budget.snapshot().stopped,/dollar ceiling/);
  await budget.close();
});

test('regression barrier cannot pass by merely rejecting everything or promoting a wrong account',()=>{
  const holdouts={cases:[{profile_id:'1',artist:'Artist',user_supplied_positive_url:candidate.url,
    user_reported_wrong_url:'https://www.instagram.com/wrong/'}]};
  assert.equal(evaluateKnownCases([{profileId:'1',urls:[]}],holdouts).passed,false);
  assert.equal(evaluateKnownCases([{profileId:'1',urls:[candidate.url]}],holdouts).passed,true);
  assert.equal(evaluateKnownCases([{profileId:'1',urls:[candidate.url,'https://www.instagram.com/wrong/']}],holdouts).passed,false);
});

test('remaining dollar cap parses exact cents and rejects an excessive or ambiguous ceiling',()=>{
  assert.equal(parseApprovedCap('--approved-cap-usd=9.89'),989);
  assert.equal(parseApprovedCap('--approved-cap-usd=10'),1000);
  for(const value of ['--approved-cap-usd=10.01','--approved-cap-usd=9.899','--approved-cap-usd=-1','--approved-cap-usd=0']) {
    assert.throws(()=>parseApprovedCap(value),/Invalid/);
  }
});

test('only completed same-profile exact-query recent packets may be reused; JEV always refreshes',async t=>{
  const dir=await temp(t);await fs.mkdir(path.join(dir,'responses'));
  const payload={artist:'Example Artist',queryIndex:0};
  const packet={profileId:'1',kind:'serper',key:'saved',at:new Date().toISOString(),
    status:200,url:'https://google.serper.dev/search',data:{organic:[],searchParameters:{q:serperQuery(payload)}}};
  await fs.writeFile(path.join(dir,'responses','saved.json'),JSON.stringify(packet));
  await fs.writeFile(path.join(dir,'admissions.jsonl'),[
    {phase:'admitted',key:'saved',profileId:'1',kind:'serper'},
    {phase:'returned',key:'saved',profileId:'1',kind:'serper'},
  ].map(JSON.stringify).join('\n')+'\n');
  const loaded=await loadCompletedPilotCache(dir);
  const request=req('serper',payload);
  assert.equal(cachedPacketFor(loaded,request).key,'saved');
  assert.equal(cachedPacketFor(loaded,{...request,profileId:'2'}),undefined);
  assert.equal(cachedPacketFor(loaded,{...request,payload:{...payload,queryIndex:1}}),undefined);
  assert.equal(cachedPacketFor(loaded,{...request,kind:'jev'}),undefined);
  assert.equal(cachedPacketFor(loaded,request,Date.now()+25*60*60*1000),undefined);
  let calls=0;
  const output=await temp(t);
  const transport=createLiveTransport({keys,responseDir:output,cachedPackets:loaded,
    fetchImpl:async()=>{calls++;throw new Error('Paid fallback forbidden');}});
  const receipt=transport.cachedAdmission(request);
  await transport.dispatch({...request,cachedReceipt:receipt});
  assert.equal(calls,0);
  const saved=JSON.parse(await fs.readFile(path.join(output,'1-serper-0.json'),'utf8'));
  assert.equal(saved.cacheSource.sourceKey,'saved');
  await assert.rejects(transport.dispatch({...request,key:'bad-cache',cachedReceipt:{sourceFile:'missing',sourceKey:'saved'}}),/refusing a paid fallback/);
  assert.equal(calls,0);
  await fs.appendFile(path.join(dir,'admissions.jsonl'),JSON.stringify({phase:'failed_no_retry',key:'saved'})+'\n');
  assert.equal((await loadCompletedPilotCache(dir)).length,0);
});

test('JEV budget measures the outgoing request, not larger archived discovery evidence',async t=>{
  const dir=await temp(t);
  const manifest={run_allowed:true,authorization:{approved:true,maxSpendCents:989},
    artists:[{profile_id:'1',source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}}],
    proposed_limits:{serper_requests_total:68,scrapecreators_requests_total:103,jev_requests_total:34,
      public_spotify_oembed_requests_total:33,public_official_or_linkhub_page_requests_total:136,
      public_music_page_requests_per_artist:4,serper_requests_per_artist:2,instagram_candidate_metadata_per_artist:3,
      reference_metadata_per_artist:1,jev_requests_per_artist:1,paid_http_requests_total:205,
      global_concurrent_provider_requests:5,per_request_timeout_seconds:20,jev_max_input_tokens_per_request:6000,
      jev_max_output_tokens_per_request:1000}};
  let calls=0;
  const transport=createLiveTransport({keys,responseDir:dir,fetchImpl:async(_,options)=>{
    calls++;assert.ok(Buffer.byteLength(options.body)<=6000);
    return Response.json({usage:{cost:0.0001},answers:{candidate_0_same_identity:{noul:0.96},candidate_0_verdict:{choice:'verified'}}});
  }});
  const budget=await createPilotBudget({manifest,journalPath:path.join(dir,'admissions.jsonl'),transport,mode:'live'});
  const payload={artist:'Example Artist',catalogReference:reference,profiles:[{url:candidate.url,
    archivedSearchEvidence:'x'.repeat(7000),identityComparison:{reference,candidate}}]};
  assert.ok(Buffer.byteLength(JSON.stringify(payload))>6000);
  const result=await budget.request({profileId:'1',kind:'jev',key:'sizing-fixed',payload});
  assert.equal(result[0].jevVerification.verdict,'verified');assert.equal(calls,1);
  await assert.rejects(budget.request({profileId:'1',kind:'jev',key:'oversized',
    payload:{...payload,artist:'x'.repeat(7000)}}),/reservation/);
  assert.equal(calls,1);await budget.close();
});
