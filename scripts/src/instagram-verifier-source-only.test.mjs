import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {jevRequest,fitArtistContext,createLiveTransport} from './instagram-pilot-live-transport.mjs';

// Synthetic, offline evidence only; no historical request or decision is rewritten.
const instagram='https://www.instagram.com/example/';
const spotify='https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';
const youtube='https://www.youtube.com/@example';
const hub='https://linktr.ee/example';
const album='https://open.spotify.com/album/AAAAAAAAAAAAAAAAAAAAAA';
const declaration={kind:'bio',platform:'youtube',source:'saved_snapshot',sourceUrl:youtube,
  accountId:'7',binding:'profile_and_platform_only_not_account_bound',
  asOf:'2020-01-01',ageDays:2500,stale:true,text:'Instagram @example'};

function fixture(compactEvidence) {
  const reference={platform:'spotify',url:spotify,displayName:'Example',bio:'Musician',
    externalUrls:[instagram]};
  const candidate={platform:'instagram',url:instagram,displayName:'Example',
    bio:`Musician ${spotify}`,directExternalUrls:[hub,spotify,youtube],
    unresolvedExternalLinks:['https://example.invalid/unresolved'],
    externalLinkEvidence:{sourceUrl:hub,status:'unresolved',ownershipConfirmed:false,
      pages:[{sourceUrl:hub,contentUrl:album,contentType:'album',musicTargets:[album],
        creditedArtistUrls:[spotify],relatedArtistUrls:[]}],
      catalogAlbums:[{source:'frozen_catalog',albumUrl:album,albumId:'8',linkedFrom:hub,
        checkedAt:'2026-11-01',albumRows:1,artistRows:1,status:'exact_catalog_artist',
        reason:'Exact frozen artist ID'}]}};
  return {artist:'Example',catalogReference:reference,compactEvidence,
    artistContext:{ownershipConfirmed:false,items:[declaration]},
    profiles:[{url:instagram,identityComparison:{status:'likely',reasons:['PRIOR_WORKFLOW_JUDGMENT'],
      reference,candidate,catalogConnections:[{targetUrl:youtube,platform:'youtube',accountId:'7'}]}},
    {url:'https://www.instagram.com/other/',identityComparison:{status:'mismatch',
      reasons:['PRIOR_CONTROL_JUDGMENT'],reference,
      candidate:{platform:'instagram',url:'https://www.instagram.com/other/',bio:'Unknown',externalUrls:[]}}}]};
}

for(const compactEvidence of [false,true]) {
  const branch=compactEvidence?'compact':'normal';
  test(`${branch}: prior judgments cannot change model input; source paths and uncertainty survive`,()=>{
    const payload=fixture(compactEvidence),before=structuredClone(payload);
    const serialized=JSON.stringify(jevRequest(payload)),request=JSON.parse(serialized);
    for(const item of request.state.candidates) {
      assert.equal(Object.hasOwn(item,'identityComparisonStatus'),false);
      assert.equal(Object.hasOwn(item,'identityComparisonReasons'),false);
    }
    assert.doesNotMatch(serialized,/PRIOR_WORKFLOW_JUDGMENT|PRIOR_CONTROL_JUDGMENT/);
    const changed=structuredClone(payload);
    for(const p of changed.profiles) {
      p.identityComparison.status='verified';
      p.identityComparison.reasons=['Opposite prior workflow judgment'];
    }
    assert.equal(JSON.stringify(jevRequest(changed)),serialized);
    for(const p of changed.profiles) {
      delete p.identityComparison.status;
      delete p.identityComparison.reasons;
    }
    assert.equal(JSON.stringify(jevRequest(changed)),serialized);
    const item=request.state.candidates[0],source=payload.profiles[0].identityComparison;
    assert.equal(item.reference.url,spotify);
    assert.equal(item.reference.displayName,source.reference.displayName);
    assert.equal(item.candidate.bio,source.candidate.bio);
    assert.deepEqual(item.candidate.externalUrls,[hub,spotify,youtube]);
    assert.deepEqual(item.candidate.unresolvedExternalLinks,source.candidate.unresolvedExternalLinks);
    assert.deepEqual(item.catalogConnections,source.catalogConnections);
    assert.deepEqual(item.observedExactCatalogLinks,[
      {source:'instagram_profile_bio_link',targetUrl:spotify},
      {source:'instagram_profile_bio_text',targetUrl:spotify},
      {source:'catalog_profile_link_to_instagram',targetUrl:instagram},
    ]);
    const music=item.candidate.musicLinkPath;
    assert.equal(music.sourceUrl,hub);
    assert.equal(music.status,'unresolved'); // Capture/resolution uncertainty is not a verdict.
    assert.equal(music.ownershipAssessment,'unassessed');
    assert.deepEqual(music.pages,source.candidate.externalLinkEvidence.pages);
    assert.deepEqual(music.catalogAlbumLinks,source.candidate.externalLinkEvidence.catalogAlbums);
    const context=request.state.artistContext;
    const signals=context.candidateSignals[0].otherPlatformBioLinksToCandidate;
    const sources=compactEvidence?signals.sourceIndexes.map(i=>context.declarations[i]):signals.sources;
    assert.deepEqual(sources,[{url:instagram,kind:'platform_labeled_handle',source:declaration.source,
      sourceUrl:youtube,asOf:declaration.asOf,stale:true,binding:declaration.binding,accountId:'7'}]);
    const rules=compactEvidence?request.state.evidenceRules.same_identity
      :request.questions.candidate_0_same_identity.instructions;
    assert.match(rules,/Missing, unavailable or unsupported evidence means uncertainty, not mismatch/);
    assert.match(rules,/ownershipAssessment=unassessed means unknown, never a negative/);
    assert.match(rules,/Require artist ownership, not association/);
    assert.deepEqual(request.state.candidates[1].candidate.externalUrls,[]);
    assert.equal(request.model,'typesafe/jev-1.13');
    assert.deepEqual(payload,before); // Includes saved source facts and prior judgments.
  });

  test(`${branch}: byte estimator, dispatch cap and exact request archive share the sanitized input`,async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'source-only-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const payload=fixture(compactEvidence);
    // Keep the dispatch fixture small while testing rich provenance above.
    delete payload.artistContext;
    payload.profiles=payload.profiles.slice(0,1);
    const body=JSON.stringify(jevRequest(payload)),observations=[];
    const transport=createLiveTransport({responseDir:dir,
      keys:{SERPERDEV_API_KEY:'fixture',SCRAPECREATORS_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'},
      fetchImpl:async(url,options)=>{
        observations.push({url,body:options.body});
        return Response.json({usage:{cost:0},answers:{
          candidate_0_same_identity:{noul:0.5},candidate_0_verdict:{choice:'uncertain'}}});
      }});
    assert.equal(transport.inputBytes({kind:'jev',payload}),Buffer.byteLength(body));
    assert.ok(Buffer.byteLength(body)<=6000);
    const request={kind:'jev',key:'offline',profileId:'fixture',payload};
    const result=await transport.dispatch(request);
    assert.deepEqual(result,[{url:instagram,jevVerification:{sameIdentityProbability:0.5,verdict:'uncertain'}}]);
    assert.equal(observations.length,1);
    assert.equal(observations[0].body,body);
    const archivePath=path.join(dir,'offline.json'),archiveBytes=await fs.readFile(archivePath,'utf8');
    const archive=JSON.parse(archiveBytes);
    assert.deepEqual(archive.decisionRequest,JSON.parse(body));
    assert.equal(archive.requestBodySha256,createHash('sha256').update(body).digest('hex'));
    const oversized={...payload,artist:'x'.repeat(6001)};
    await assert.rejects(transport.dispatch({...request,key:'too-big',payload:oversized}),/6000-byte/);
    assert.equal(observations.length,1);
    // Append-only archive protection still refuses overwriting a prior decision.
    await assert.rejects(transport.dispatch(request),{code:'EEXIST'});
    assert.equal(await fs.readFile(archivePath,'utf8'),archiveBytes);
  });
}

test('fitting keeps declarations and exact frozen links, or holds explicitly rather than losing evidence',()=>{
  const payload=fixture(false);
  payload.profiles=payload.profiles.slice(0,1);
  const before=structuredClone(payload);
  const fitted=fitArtistContext(payload,6000);
  assert.ok(Buffer.byteLength(JSON.stringify(jevRequest(fitted)))<=6000);
  assert.equal(fitted.contextDelivery.protectedDeclarations,1);
  assert.deepEqual(fitted.artistContext.items,[declaration]);
  assert.deepEqual(fitted.profiles[0].identityComparison.catalogConnections,
    payload.profiles[0].identityComparison.catalogConnections);
  assert.throws(()=>fitArtistContext(payload,100),/no dispatch or silent evidence loss/);
  assert.deepEqual(payload,before);
});
