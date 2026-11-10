import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {collectCatalogWebsiteDeclarations,adaptCatalogWebsiteArchive,
  declaredWebsiteUrl} from './catalog-website-source.mjs';
import {createCatalogProfileReader} from './catalog-website-source-fetch.mjs';
import {collectFromManifest} from './collect-catalog-website-sources.mjs';
import {assessOfflineSourcePolicy,sealOfflineSnapshot} from './instagram-source-policy-offline.mjs';
import {assessInstagramCandidates} from './musician-instagram-matching.mjs';
import {at,now,music,website,channel,ig,hash,player,archive,options,
  spotifyBody,youtubeBody,collectorCases} from './fixtures/catalog-website-source.mjs';

test('archived artist declaration retains original time, URLs, body hash, context and both packet digests',async()=>{
  const input=options(),before=structuredClone(input);
  const out=await collectCatalogWebsiteDeclarations(input);
  assert.deepEqual(input,before);
  assert.equal(out.declarations.length,1);assert.deepEqual(out.unresolved,[]);
  const p=out.declarations[0],{packetSha256,...contents}=p;
  assert.equal(packetSha256,hash(JSON.stringify(contents)));
  assert.equal(p.archivePacketSha256,hash(JSON.stringify(input.archives[0])));
  assert.equal(p.sourceUrl,music);assert.equal(p.finalUrl,music);
  assert.deepEqual(p.catalogAccountIds,['11']);
  assert.equal(p.catalogSnapshotSha256,hash(JSON.stringify(input.player)));
  assert.equal(p.bodySha256,input.archives[0].bodySha256);assert.equal(p.observedAt,at);
  assert.equal(p.selectedLinks[0].contextKind,'catalog_artist_external_link');
  assert.equal(p.selectedLinks[0].contextId,music);
  assert.match(p.selectedLinks[0].contextPath,/entity.externalLinks.items\[0\]/);
  assert.deepEqual(p.links,[website]);
  assert.equal(out.offlineOnly,true);assert.equal(out.productionApproved,false);
  assert.equal(out.claimsAllowed,false);assert.equal(out.paidCalls,0);assert.equal(out.databaseWrites,0);
});
test('collector redirect fixture binds both ends to same artist and preserves each hop',async()=>{
  const a=collectorCases.redirect();
  const out=await collectCatalogWebsiteDeclarations(options({archives:[a]}));
  assert.equal(out.declarations[0].finalUrl,a.finalUrl);
  assert.deepEqual(out.declarations[0].redirects,a.redirects);
  for(const bad of [
    {...a,redirects:[]},
    {...a,finalUrl:music.replaceAll('A','B')},
    {...a,redirects:[{...a.redirects[0],sourceUrl:website}]},
    {...a,redirects:[{...a.redirects[0],status:200}]},
    {...a,finalUrl:website,redirects:[{...a.redirects[0],finalUrl:website}]},
  ]){
    const r=await collectCatalogWebsiteDeclarations(options({archives:[bad]}));
    assert.equal(r.declarations.length,0);assert.equal(r.unresolved.length,1);
  }
});
test('publisher footers, stale declarations, wrong artist IDs cannot mint source trust',async()=>{
  for(const [key,make] of Object.entries(collectorCases)){
    if(key==='redirect')continue;
    const out=await collectCatalogWebsiteDeclarations(options({archives:[make()]}));
    assert.equal(out.declarations.length,0,key);assert.equal(out.unresolved.length,1,key);
  }
});
test('active account membership required, including catalog profile and disconnect binding',async()=>{
  for(const mutate of [
    p=>p.account_ids=[],
    p=>p.accounts[0].profile_id='2',
    p=>p.accounts[0].disconnected_at=at,
    p=>p.accounts[0].platform='instagram',
  ]){
    const p=player();mutate(p);
    const out=await collectCatalogWebsiteDeclarations(options({player:p}));
    assert.equal(out.declarations.length,0);assert.match(out.reason,/No active/);
  }
  assert.throws(()=>adaptCatalogWebsiteArchive({player:player(),reference:{platform:'spotify',
    url:music.replaceAll('A','B')},archive:archive(),now,maxEvidenceAgeMs:86400000}),/Inactive/);
});
test('search results, self-links, raw grading pages and contextless metadata remain unresolved',async()=>{
  for(const a of [
    {...archive(),kind:'search_result'},
    {...archive(),sourceUrl:ig,finalUrl:ig},
    {...archive(),sourceUrl:website,finalUrl:website},
    {kind:'catalog_profile_http',sourceUrl:music,finalUrl:music,observedAt:at,status:200,
      externalUrls:[website],bodySha256:'a'.repeat(64)},
    {url:music,externalUrls:[website]},
  ]){
    assert.equal((await collectCatalogWebsiteDeclarations(options({archives:[a]}))).declarations.length,0);
  }
  for(const target of [ig,'https://google.com/search?q=artist',music,'https://linktr.ee/artist',
    'https://www.youtube.com/@artist','https://instagram.com.evil.example/@artist']){
    // A lookalike hostname is not Instagram, but it also cannot be a source.
    if(target.includes('evil.example'))continue;
    assert.equal(declaredWebsiteUrl(target),null,target);
    const a=archive({body:spotifyBody({links:[{name:'Official Website',url:target}]})});
    assert.equal((await collectCatalogWebsiteDeclarations(options({archives:[a]}))).declarations.length,0);
  }
});
test('missing or corrupt bodies, unknown/future times and tampered hashes fail closed',async()=>{
  for(const mutate of [
    a=>delete a.observedAt,a=>a.observedAt='not a date',a=>a.observedAt='2026-11-10T00:00:00Z',
    a=>a.body+='tampered',a=>a.bodySha256='c'.repeat(64),
    a=>a.body=undefined,a=>a.status=403,a=>a.body='x'.repeat(2_000_001),
  ]){
    const a=archive();mutate(a);
    assert.equal((await collectCatalogWebsiteDeclarations(options({archives:[a]}))).declarations.length,0);
  }
  await assert.rejects(collectCatalogWebsiteDeclarations(options({now:undefined})),/Explicit/);
  await assert.rejects(collectCatalogWebsiteDeclarations(options({maxEvidenceAgeMs:0})),/Explicit/);
  const sealed=sealOfflineSnapshot(archive());
  assert.equal((await collectCatalogWebsiteDeclarations(options({archives:[sealed]}))).declarations.length,1);
  sealed.observedAt='2026-11-09T18:00:00Z';
  const out=await collectCatalogWebsiteDeclarations(options({archives:[sealed]}));
  assert.equal(out.declarations.length,0);assert.match(out.unresolved[0].details[0],/digest mismatch/);
});
test('newer removed declarations and ambiguous captures never recover from favorable older archives',async()=>{
  const old=archive({observedAt:'2026-11-09T18:00:00Z'});
  const removed=archive({body:spotifyBody({links:[]})});
  for(const archives of [
    [old,removed],
    [old,{...removed,observedAt:undefined}],
    [archive(),archive({body:spotifyBody({links:[{name:'Website',url:'https://other.example/'}]})})],
  ]){
    const out=await collectCatalogWebsiteDeclarations(options({archives}));
    assert.equal(out.declarations.length,0);assert.equal(out.unresolved.length,1);
  }
});
test('YouTube about fields require exact channel identity; arbitrary video descriptions/footers do not qualify',async()=>{
  const input=options({player:player('youtube'),archives:[archive({platform:'youtube'})]});
  const out=await collectCatalogWebsiteDeclarations(input);
  assert.equal(out.declarations.length,1);assert.equal(out.declarations[0].sourceUrl,`${channel}/about`);
  for(const body of [
    youtubeBody({id:'UCbbbbbbbbbbbbbbbbbbbbbb'}),
    youtubeBody({links:[],footer:`<footer><a href="${website}">Official website</a></footer>`}),
    youtubeBody().replace('"selected":true','"selected":false'),
    youtubeBody().replace('"title":"About"','"title":"Videos"'),
    youtubeBody().replace('"primaryLinks"','"descriptionLinks"'),
    `<script>var ytInitialData = JSON.parse("not executed");</script>`,
  ]){
    const r=await collectCatalogWebsiteDeclarations({...input,archives:[archive({platform:'youtube',body})]});
    assert.equal(r.declarations.length,0);
  }
});
test('source-context extraction rejects ambiguous/unsupported layouts and non-website labels',async()=>{
  for(const body of [
    spotifyBody()+spotifyBody(),'<html>Artist website: '+website+'</html>',
    spotifyBody().replace('"type":"artist"','"type":"album"'),
    spotifyBody({links:[{name:'Publisher',url:website}]}),
    spotifyBody({links:[{name:'Artist shop',url:website}]}),
  ]){
    assert.equal((await collectCatalogWebsiteDeclarations(options({archives:[archive({body})]}))).declarations.length,0);
  }
});
test('adapter output feeds isolated gate for Spotify/YouTube; cannot confer live approval or whole-domain trust',async()=>{
  for(const platform of ['spotify','youtube']){
    const p=player(platform),reference=p.accounts[0].account_url;
    const page=sealOfflineSnapshot({sourceUrl:website,observedAt:at,bodySha256:'a'.repeat(64),
      links:[{url:reference,contextKind:'artist_specific',contextId:'artist'},
        {url:ig,contextKind:'artist_specific',contextId:'artist'}]});
    const collection=await collectCatalogWebsiteDeclarations(options({player:p,
      archives:[archive({platform})],pages:[page,{...page,sourceUrl:'https://artist.example/other'}]}));
    assert.equal(collection.websiteEvidence.length,1);
    const result={methodsUsed:[{method:'serper',status:'used'}],profiles:[{url:ig,
      ownershipContext:'artist_account',identityComparison:{status:'likely',
        reference:{url:reference,externalUrls:[]},candidate:{url:ig,externalUrls:[]}},
      jevVerification:{verdict:'verified',sameIdentityProbability:0.84,model:'fixture',
        requestSha256:'c'.repeat(64),observedAt:at,profileId:'1',accountUrl:ig}}]};
    const input={player:p,result,websiteEvidence:collection.websiteEvidence,now,
      config:{mode:'offline',minimumSourceIdentityScore:0.83,maxEvidenceAgeMs:86400000,maxVerifierAgeMs:86400000}};
    const baseline=assessInstagramCandidates(result,p),out=assessOfflineSourcePolicy(input);
    assert.deepEqual(out.simulationUrls,[ig]);assert.equal(out.productionApproved,false);
    assert.equal(out.claimsAllowed,false);assert.deepEqual(assessInstagramCandidates(result,p),baseline);
    const declaration=collection.websiteEvidence[0].catalogDeclaration;
    const {packetSha256,...raw}=declaration;
    collection.websiteEvidence[0].catalogDeclaration=sealOfflineSnapshot({...raw,finalUrl:website});
    assert.deepEqual(assessOfflineSourcePolicy(input).simulationUrls,[]);
  }
});
test('query-selected artist pages cannot borrow trust from a different declared page, even when bypassing the collector join',async()=>{
  const alice='https://artist.example/?artist=alice';
  const bob='https://artist.example/?artist=bob';
  const source=archive({body:spotifyBody({links:[{name:'Website',url:alice}]})});
  const page=url=>sealOfflineSnapshot({sourceUrl:url,observedAt:at,bodySha256:'a'.repeat(64),
    links:[{url:music,contextKind:'artist_specific',contextId:'artist'},
      {url:ig,contextKind:'artist_specific',contextId:'artist'}]});
  const result={methodsUsed:[{method:'serper',status:'used'}],profiles:[{url:ig,
    ownershipContext:'artist_account',identityComparison:{status:'likely',
      reference:{url:music,externalUrls:[]},candidate:{url:ig,externalUrls:[]}},
    jevVerification:{verdict:'verified',sameIdentityProbability:0.84,model:'fixture',
      requestSha256:'c'.repeat(64),observedAt:at,profileId:'1',accountUrl:ig}}]};
  const gate=websiteEvidence=>assessOfflineSourcePolicy({player:player(),result,websiteEvidence,now,
    config:{mode:'offline',minimumSourceIdentityScore:0.83,maxEvidenceAgeMs:86400000,maxVerifierAgeMs:86400000}});
  const different=await collectCatalogWebsiteDeclarations(options({archives:[source],pages:[page(bob)]}));
  assert.deepEqual(different.declarations[0].links,[alice]);
  assert.deepEqual(different.websiteEvidence,[]);
  assert.deepEqual(gate(different.websiteEvidence).simulationUrls,[]);
  assert.deepEqual(gate([{profileId:'1',catalogDeclaration:different.declarations[0],page:page(bob)}]).simulationUrls,[]);
  const same=await collectCatalogWebsiteDeclarations(options({archives:[source],pages:[page(alice)]}));
  assert.equal(same.websiteEvidence.length,1);
  assert.deepEqual(gate(same.websiteEvidence).simulationUrls,[ig]);
  // Keep other URL components exact too; hashes can select client-side artists.
  for(const [declared,observed] of [
    ['https://artist.example/artist','https://artist.example/artist/'],
    ['https://artist.example/#alice','https://artist.example/#bob'],
    ['https://artist.example/?a=1&b=2','https://artist.example/?b=2&a=1'],
  ]){
    const a=archive({body:spotifyBody({links:[{name:'Website',url:declared}]})});
    const out=await collectCatalogWebsiteDeclarations(options({archives:[a],pages:[page(observed)]}));
    assert.deepEqual(out.websiteEvidence,[]);
    assert.deepEqual(gate([{profileId:'1',catalogDeclaration:out.declarations[0],page:page(observed)}]).simulationUrls,[]);
  }
});
test('grading labels are rejected, not converted to automatic trust',async()=>{
  await assert.rejects(collectCatalogWebsiteDeclarations(options({
    archives:[{...archive(),expectedArtistOwned:true}]})),/Evaluator/);
  await assert.rejects(collectCatalogWebsiteDeclarations(options({
    pages:[{labelEvidence:{url:website}}]})),/Evaluator/);
  await assert.rejects(collectFromManifest({...options(),labelTier:'reviewed'}),/Evaluator/);
});

function transport(responses,{address='8.8.8.8'}={}){
  const seen=[];
  const lookup=async()=>[{address,family:4}];
  const request=(url,options,callback)=>{
    seen.push({url:String(url),options});
    options.lookup(url.hostname,{},(_error,pinned,family)=>{
      assert.equal(pinned,address);assert.equal(family,4);
    });
    const req=new EventEmitter();
    req.end=()=>queueMicrotask(()=>{
      const spec=responses.shift();
      const res=new PassThrough();
      res.statusCode=spec.status??200;
      res.headers={'content-type':'text/html',...spec.headers};
      callback(res);
      if(!res.destroyed)res.end(spec.body??spotifyBody());
    });
    return req;
  };
  return {seen,lookup,request};
}
const publicConfig={enabled:true,maxRequests:4,maxBytes:10000,timeoutMs:1000,maxRedirects:2};
test('network is off by default and fresh archives take precedence even with explicit public opt-in',async()=>{
  const t=transport([]);
  const input=options({publicFetch:{...publicConfig,...t}});
  assert.equal((await collectCatalogWebsiteDeclarations(input)).declarations.length,1);
  assert.equal(t.seen.length,0);
  const disabled=options({archives:[],publicFetch:{enabled:false,...t}});
  assert.equal((await collectCatalogWebsiteDeclarations(disabled)).declarations.length,0);
  assert.equal(t.seen.length,0);
  await assert.rejects(collectFromManifest({player:player(),archives:[],now,maxEvidenceAgeMs:1,
    publicFetch:{enabled:true}}),/also requires/);
  assert.throws(()=>createCatalogProfileReader({enabled:true}),/bounded/);
  assert.throws(()=>createCatalogProfileReader({...publicConfig,enabled:false}),/opt-in/);
});
test('bounded public reader uses pinned HTTPS and manually follows only identity-preserving redirects',async()=>{
  const target=music.replace('/artist/','/embed/artist/');
  const t=transport([{status:302,headers:{location:target}},{body:spotifyBody()}]);
  const read=createCatalogProfileReader({...publicConfig,...t});
  const captured=await read({platform:'spotify',url:music});
  assert.equal(t.seen.length,2);assert.equal(captured.sourceUrl,music);assert.equal(captured.finalUrl,target);
  assert.equal(captured.bodySha256,hash(captured.body));
  assert.equal(captured.redirects.length,1);
  assert.ok(Date.parse(captured.observedAt)<=Date.now());
  assert.equal(t.seen[0].options.agent,false);assert.equal(t.seen[0].options.servername,'open.spotify.com');
  assert.equal(t.seen[0].options.headers.Cookie,undefined);
  assert.equal(t.seen[0].options.headers.Authorization,undefined);
});
test('SSRF targets, other artist redirects and private/mixed DNS are not requested',async()=>{
  for(const url of ['https://127.0.0.1/','https://169.254.169.254/',
    'https://open.spotify.com.evil.example/artist/AAAAAAAAAAAAAAAAAAAAAA',
    'http://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA',
    music.replace('https://','https://user:pass@'),music+'?redirect=https://localhost']){
    const t=transport([]);
    const read=createCatalogProfileReader({...publicConfig,...t});
    await assert.rejects(read({platform:'spotify',url}));
    assert.equal(t.seen.length,0);
  }
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','100.64.0.1']){
    const t=transport([],{address});
    await assert.rejects(createCatalogProfileReader({...publicConfig,...t})({platform:'spotify',url:music}),/public IPv4/);
    assert.equal(t.seen.length,0);
  }
  const t=transport([]);
  await assert.rejects(createCatalogProfileReader({...publicConfig,...t,
    lookup:async()=>[{address:'8.8.8.8'},{address:'10.0.0.1'}]})({platform:'spotify',url:music}),/public IPv4/);
  for(const location of [website,music.replaceAll('A','B'),'https://localhost/']){
    const t=transport([{status:302,headers:{location}}]);
    await assert.rejects(createCatalogProfileReader({...publicConfig,...t})({platform:'spotify',url:music}),/not followed/);
    assert.equal(t.seen.length,1);
  }
});
test('public limits reject oversize, bad MIME/encoding, missing location, redirect loops and exhausted budget without retry',async()=>{
  for(const {responses,config={},reason} of [
    {responses:[{body:'x'.repeat(101)}],config:{maxBytes:100},reason:/body limit/},
    {responses:[{headers:{'content-type':'application/json'}}],reason:/Unsupported/},
    {responses:[{headers:{'content-encoding':'gzip'}}],reason:/Unsupported/},
    {responses:[{body:Buffer.from([0xc3,0x28])}],reason:/UTF-8/},
    {responses:[{status:302}],reason:/Missing/},
    {responses:[{status:403}],reason:/Unsupported/},
    {responses:[{status:302,headers:{location:music}},{status:302,headers:{location:music}}],
      config:{maxRedirects:1},reason:/redirect limit/},
  ]){
    const t=transport(responses);
    await assert.rejects(createCatalogProfileReader({...publicConfig,...t,...config})({platform:'spotify',url:music}),reason);
  }
  const t=transport([{}]),read=createCatalogProfileReader({...publicConfig,...t,maxRequests:1});
  await read({platform:'spotify',url:music});
  await assert.rejects(read({platform:'spotify',url:music}),/budget exhausted/);
  assert.equal(t.seen.length,1);
});
test('DNS deadline is bounded too; an unresponsive resolver cannot dispatch HTTP later',async()=>{
  const t=transport([]);
  const keepAlive=setTimeout(()=>{},100);
  try{
    const read=createCatalogProfileReader({...publicConfig,...t,timeoutMs:5,
      lookup:()=>new Promise(()=>{})});
    await assert.rejects(read({platform:'spotify',url:music}),/DNS timeout/);
    assert.equal(t.seen.length,0);
  }finally{clearTimeout(keepAlive);}
});
test('safe fetching alone never establishes trust; captured wrong artist body stays unresolved',async()=>{
  const t=transport([{body:spotifyBody({id:'B'.repeat(22)})}]);
  const out=await collectCatalogWebsiteDeclarations(options({archives:[],
    publicFetch:{...publicConfig,...t}}));
  assert.equal(out.declarations.length,0);assert.equal(out.unresolved.length,1);
  assert.equal(out.capturedArchives.length,1);assert.match(out.unresolved[0].details.join(' '),/Wrong Spotify/);
});
test('fresh opt-in acquisition retains actual observation time and reports later source evaluation time',async()=>{
  const t=transport([{}]);
  const out=await collectCatalogWebsiteDeclarations(options({archives:[],now:Date.now(),
    publicFetch:{...publicConfig,...t}}));
  assert.equal(out.declarations.length,1);
  assert.ok(Date.parse(out.declarations[0].observedAt)<=out.sourceEvaluationTime);
  assert.equal(out.declarations[0].observedAt,out.capturedArchives[0].observedAt);
});
