import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLiveTransport,fitArtistContext,jevRequest} from './instagram-pilot-live-transport.mjs';

// Synthetic offline evidence, not archived artist data or model judgments.
const instagram='https://www.instagram.com/byte_fixture/';
const spotify='https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';
const youtube='https://www.youtube.com/@byte_fixture';
const escaped='「音楽」 café العربية 🎵 "quoted" \\path\n\t\u0000';
const serialize=payload=>JSON.stringify(jevRequest(payload));
// Independent of the transport's Buffer.byteLength implementation.
const utf8=text=>new TextEncoder().encode(text).byteLength;

function fixture() {
  const reference={platform:'spotify',url:spotify,displayName:'音楽家 Élodie',
    bio:`موسيقى ${escaped}`,externalUrls:[instagram]};
  const candidate={platform:'instagram',url:instagram,displayName:'音楽家 Élodie',
    bio:`歌手 ${escaped}`,directExternalUrls:[spotify,youtube]};
  return {artist:`音楽家 Élodie العربية 🎵 ${escaped}`,catalogReference:reference,
    artistContext:{ownershipConfirmed:false,items:[{
      kind:'bio',platform:'youtube',text:`歌手 ${escaped} Instagram @byte_fixture`,
      source:`保存済み ${escaped}`,sourceUrl:`${youtube}?note=音楽`,
      accountId:'fixture-account',binding:'profile_and_platform_only_not_account_bound',
      asOf:'2020-01-01',ageDays:2500,stale:true,
    }]},
    profiles:[{url:instagram,identityComparison:{reference,candidate,
      status:'likely',reasons:['PRIOR_WORKFLOW_JUDGMENT'],
      catalogConnections:[{targetUrl:youtube,platform:'youtube',accountId:'fixture-account'}]}}]};
}

function boundaryFixture(compactEvidence) {
  // Include fitting's audit metadata before sizing, so fitting and dispatch
  // measure precisely the same request, not merely the evidence payload.
  const payload={...fitArtistContext(fixture(),6000),compactEvidence};
  const remaining=6000-utf8(serialize(payload));
  assert.ok(remaining>=0,'Multilingual evidence must fit before boundary padding');
  payload.artist+='x'.repeat(remaining);
  assert.equal(utf8(serialize(payload)),6000);
  return payload;
}

async function harness(t) {
  const responseDir=await fs.mkdtemp(path.join(os.tmpdir(),'ig-byte-boundary-'));
  t.after(()=>fs.rm(responseDir,{recursive:true,force:true}));
  const calls=[];
  const forbiddenPublic=async()=>{calls.push({public:true});throw Error('Unexpected public HTTP call');};
  const transport=createLiveTransport({responseDir,
    keys:{SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'},
    publicFetchImpl:forbiddenPublic,
    fetchImpl:async(url,options)=>{
      calls.push({url,body:options.body});
      return Response.json({usage:{cost:0},answers:{
        candidate_0_same_identity:{noul:0.5},candidate_0_verdict:{choice:'uncertain'}}});
    }});
  const request=payload=>({kind:'jev',profileId:'byte-fixture',key:'offline-byte-boundary',payload});
  return {transport,calls,responseDir,request};
}

function assertSourceFacts(payload,request) {
  const source=payload.profiles[0].identityComparison,item=request.state.candidates[0];
  assert.equal(request.state.artist,payload.artist);
  assert.equal(item.reference.bio,source.reference.bio);
  assert.equal(item.candidate.bio,source.candidate.bio);
  assert.equal(item.reference.displayName,source.reference.displayName);
  assert.equal(item.candidate.displayName,source.candidate.displayName);
  assert.deepEqual(item.catalogConnections,source.catalogConnections);
  assert.deepEqual(item.candidate.externalUrls,source.candidate.directExternalUrls);
  assert.deepEqual(item.observedExactCatalogLinks,[
    {source:'instagram_profile_bio_link',targetUrl:spotify},
    {source:'catalog_profile_link_to_instagram',targetUrl:instagram},
  ]);
  const context=request.state.artistContext;
  const signal=context.candidateSignals[0].otherPlatformBioLinksToCandidate;
  const sources=payload.compactEvidence
    ? signal.sourceIndexes.map(i=>context.declarations[i]) : signal.sources;
  const declaration=payload.artistContext.items[0];
  assert.equal(signal.result,'support');
  assert.deepEqual(sources,[{url:instagram,kind:'platform_labeled_handle',
    source:declaration.source,sourceUrl:declaration.sourceUrl,asOf:declaration.asOf,
    stale:true,binding:declaration.binding,accountId:declaration.accountId}]);
  assert.equal(request.state.contextDelivery.protectedDeclarations,1);
  assert.equal(request.state.contextDelivery.omittedItems,0);
  const rules=payload.compactEvidence?request.state.evidenceRules.same_identity
    :request.questions.candidate_0_same_identity.instructions;
  assert.match(rules,/Require artist ownership, not association/);
  assert.match(rules,/Missing, unavailable or unsupported evidence means uncertainty, not mismatch/);
  assert.match(rules,/ownershipAssessment=unassessed means unknown, never a negative/);
  assert.doesNotMatch(JSON.stringify(request),/PRIOR_WORKFLOW_JUDGMENT/);
  assert.equal(request.model,'typesafe/jev-1.13');
}

for(const compactEvidence of [false,true]) {
  const mode=compactEvidence?'compact':'normal';
  test(`${mode}: exactly 6000 UTF-8 bytes fit, dispatch and archive without changing source facts`,async t=>{
    const {transport,calls,responseDir,request}=await harness(t);
    const payload=boundaryFixture(compactEvidence),before=structuredClone(payload);
    const body=serialize(payload);
    assert.ok(body.length<6000,'Code-unit length must undercount the UTF-8 request');
    assert.ok(body.includes(JSON.stringify(escaped).slice(1,-1)),'JSON escapes are measured on the wire');
    assert.equal(Buffer.byteLength(body,'utf8'),6000);
    assert.equal(transport.inputBytes(request(payload)),6000);
    const fitted=fitArtistContext(payload,6000);
    assert.equal(fitted.compactEvidence,compactEvidence);
    assert.equal(serialize(fitted),body,'Exact boundary must not trigger evidence loss or extra compaction');
    assertSourceFacts(fitted,JSON.parse(body));
    assert.deepEqual(await transport.dispatch(request(fitted)),[
      {url:instagram,jevVerification:{sameIdentityProbability:0.5,verdict:'uncertain'}},
    ]);
    assert.deepEqual(calls,[{url:'https://openrouter.ai/api/alpha/decisions',body}]);
    const packet=JSON.parse(await fs.readFile(path.join(responseDir,'offline-byte-boundary.json'),'utf8'));
    assert.deepEqual(packet.decisionRequest,JSON.parse(body));
    assert.equal(packet.requestBodySha256,createHash('sha256').update(body,'utf8').digest('hex'));
    assert.deepEqual(payload,before);
  });

  for(const [label,suffix,extraBytes] of [
    ['one ASCII byte','x',1],['two-byte letter','é',2],['three-byte character','音',3],
    ['four-byte emoji','🎵',4],['escaped quote','"',2],['escaped backslash','\\',2],
    ['escaped newline','\n',2],['escaped control character','\u0000',6],
  ]) {
    test(`${mode}: ${label} above 6000 rejects before HTTP; protected declarations fit or hold`,async t=>{
      const {transport,calls,responseDir,request}=await harness(t);
      const base=boundaryFixture(compactEvidence);
      const payload={...base,artist:base.artist+suffix},before=structuredClone(payload);
      const body=serialize(payload),expected=6000+extraBytes;
      assert.equal(utf8(body),expected);
      assert.equal(Buffer.byteLength(body,'utf8'),expected);
      assert.ok(body.length<6000,'An incorrect code-unit guard would dispatch this request');
      assert.equal(transport.inputBytes(request(payload)),expected);
      await assert.rejects(transport.dispatch(request(payload)),/6000-byte.*no dispatch/);
      assert.deepEqual(calls,[],'Oversized requests must make zero HTTP calls');
      assert.deepEqual(await fs.readdir(responseDir),[],'Rejected requests must not create decision archives');

      if(compactEvidence) {
        // Nothing optional remains: fitting must not delete the declaration,
        // provenance, catalog connection or profile bio to force admission.
        assert.throws(()=>fitArtistContext(payload,6000),
          /Required catalog connection\/declaration evidence exceeds request cap; no dispatch or silent evidence loss/);
        assert.deepEqual(calls,[]);
      } else {
        const fitted=fitArtistContext(payload,6000),fittedBody=serialize(fitted);
        assert.equal(fitted.compactEvidence,true);
        assert.ok(utf8(fittedBody)<=6000);
        assert.equal(transport.inputBytes(request(fitted)),utf8(fittedBody));
        assert.deepEqual(fitted.artistContext,payload.artistContext);
        assertSourceFacts(fitted,JSON.parse(fittedBody));
        await transport.dispatch(request(fitted));
        assert.deepEqual(calls,[{url:'https://openrouter.ai/api/alpha/decisions',body:fittedBody}]);
      }
      assert.deepEqual(payload,before,'Fitting and dispatch must not mutate saved source evidence');
    });
  }
}
