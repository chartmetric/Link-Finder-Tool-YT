import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {musicPageUrl,parsePublicMusicPage,resolveMusicEvidence} from './public-music-links.mjs';
import {safeMusicFetch} from './safe-music-fetch.mjs';

// Synthetic public markup contracts, not live captures or proof of ownership.
const fixtures=JSON.parse(await readFile(new URL('./fixtures/music-landing-pages.json',import.meta.url),'utf8'));
const catalog={platform:'spotify',url:'https://open.spotify.com/artist/6rjRx8doaSSBvE6J4tvWL2'};
const other='https://open.spotify.com/artist/0123456789ABCDEFGHIJKL';

for(const fixture of fixtures) test(`${fixture.name}: exact source edge, mismatch and unchanged ownership`,async()=>{
  const calls=[];
  const readPage=async url=>{
    calls.push(url);
    return parsePublicMusicPage(url,fixture.html);
  };
  const candidate={directExternalUrls:[fixture.url],externalUrls:[other]};
  const result=await resolveMusicEvidence({candidate,catalog,readPage});
  assert.equal(result.status,'exact_catalog_music_identity');
  assert.equal(result.ownershipConfirmed,false);
  assert.deepEqual(calls,[fixture.url]);
  assert.deepEqual(result.pages[0].linkEvidence,[{
    sourceUrl:fixture.url,targetUrl:catalog.url,kind:fixture.kind,
  }]);
  assert.equal(result.pages[0].linkedFrom,null);
  assert.deepEqual(result.externalUrls,[catalog.url]);
  const mismatch=await resolveMusicEvidence({candidate,catalog:{...catalog,url:other},readPage});
  assert.equal(mismatch.status,'unresolved');
  assert.deepEqual(mismatch.externalUrls,[]);
  const derived=await resolveMusicEvidence({candidate:{externalUrls:[fixture.url],externalLinkEvidence:result},
    catalog,readPage});
  assert.equal(derived.pages.length,0);
});

test('landing markup excludes scripts, comments, templates, generic data URLs and unbound JSON',()=>{
  for(const fixture of fixtures) {
    const html=`<!-- <a href="${catalog.url}">comment</a> -->
      <script>const template='<a href="${catalog.url}">script</a>';</script>
      <script id="__NEXT_DATA__">{"recommendations":[{"url":"${catalog.url}"}]}</script>
      <template><a href="${catalog.url}">not rendered</a></template>
      <a data-link="${catalog.url}">not a declared Spotify service</a>
      <a onclick="window.open('${catalog.url}')">no script execution</a>
      <iframe src="https://evil.test/?url=${catalog.url}"></iframe>`;
    const page=parsePublicMusicPage(fixture.url,html);
    assert.deepEqual(page.musicTargets,[]);
    assert.deepEqual(page.externalUrls,[]);
    assert.deepEqual(page.linkEvidence,[]);
  }
});

test('relative hub links and manual redirects retain the entire source chain within four reads',async()=>{
  const root='https://lnk.to/artist',release='https://lnk.to/release',hub='https://bfan.link/release';
  const calls=[];
  const readPage=async url=>{
    calls.push(url);
    if(url===root)return parsePublicMusicPage(url,'<a href="/release?tracking=discard">release</a>');
    if(url===release)return parsePublicMusicPage(url,'',{status:302,location:hub});
    return parsePublicMusicPage(url,`<a href="${catalog.url}">Spotify</a>`);
  };
  const result=await resolveMusicEvidence({candidate:{directExternalUrls:[root]},catalog,readPage});
  assert.equal(result.status,'exact_catalog_music_identity');
  assert.deepEqual(calls,[root,release,hub]);
  assert.deepEqual(result.pages.map(p=>p.linkedFrom),[null,root,release]);
  assert.deepEqual(result.pages.flatMap(p=>p.linkEvidence),[
    {sourceUrl:root,targetUrl:release,kind:'anchor'},
    {sourceUrl:release,targetUrl:hub,kind:'http_redirect'},
    {sourceUrl:hub,targetUrl:catalog.url,kind:'anchor'},
  ]);
  calls.length=0;
  const limited=await resolveMusicEvidence({candidate:{directExternalUrls:[root]},catalog,readPage,maxPages:1});
  assert.equal(limited.status,'unresolved');
  assert.deepEqual(calls,[root]);
  assert.match(limited.reason,/limit/);
  calls.length=0;
  const loop=await resolveMusicEvidence({candidate:{directExternalUrls:[root]},catalog,
    readPage:async url=>{
      calls.push(url);
      return parsePublicMusicPage(url,'',{status:302,location:url===root?release:root});
    }});
  assert.equal(loop.status,'unresolved');
  assert.equal(calls.length,2);
});

test('landing hosts reject unsafe destinations before DNS and reject mixed public/private DNS',async()=>{
  let lookups=0,requests=0;
  const request=()=>{requests++;throw Error('Must not dispatch');};
  for(const value of [
    'https://lnk.to.evil.test/release','https://a.b.lnk.to/release','https://komi.io.evil.test/',
    'https://a.b.komi.io/','https://bfan.link.evil.test/release','https://sub.hyperfollow.com/artist',
    'https://sub.paa.ge/artist','https://sub.distrokid.com/hyperfollow/artist',
    'http://lnk.to/release','https://user:pass@lnk.to/release','https://lnk.to:444/release',
    'https://127.0.0.1/release','https://[::1]/release','https://169.254.169.254/latest/meta-data',
    'https://distrokid.com/private/artist','https://paa.ge/artist/%2fprivate',
    'https://lnk.to/a/../release','https://lnk.to/a/%2e%2e/release',
    'https://artist.komi.io/a\\..\\release',
  ]) {
    assert.equal(musicPageUrl(value),null,value);
    await assert.rejects(safeMusicFetch(value,{lookup:async()=>{lookups++;return [];},request}),/Unsafe/);
  }
  assert.equal(lookups,0);
  for(const fixture of fixtures) {
    await assert.rejects(safeMusicFetch(fixture.url,{lookup:async()=>[
      {address:'93.184.216.34',family:4},{address:'169.254.169.254',family:4},
    ],request}),/public IPv4/);
    assert.throws(()=>parsePublicMusicPage(fixture.url,'',{status:302,location:'https://localhost/private'}),/Unsafe/);
    assert.deepEqual(parsePublicMusicPage(fixture.url,
      '<a href="https://localhost/private">unsafe</a><iframe src="http://127.0.0.1/"></iframe>').musicTargets,[]);
  }
  assert.equal(requests,0);
});

test('each landing host uses pinned DNS/TLS, no credentials, and only one request even on a redirect',async()=>{
  const observed=[];
  for(const fixture of fixtures) {
    const response=await safeMusicFetch(fixture.url,{
      lookup:async()=>[{address:'93.184.216.34',family:4}],
      request:(url,options,callback)=>{
        const pinned=[];
        options.lookup(url.hostname,{all:true},(error,records)=>pinned.push({error,records}));
        observed.push({url,options,pinned});
        const req=new EventEmitter();
        req.end=()=>{
          const body=Readable.from(['redirect']);
          body.statusCode=302;
          body.headers={location:'https://169.254.169.254/private','set-cookie':'secret=discard'};
          callback(body);
        };
        return req;
      },
    });
    assert.equal(response.status,302);
    assert.equal(await response.text(),'redirect');
    assert.equal(response.headers.has('set-cookie'),false);
  }
  assert.equal(observed.length,fixtures.length);
  for(const {url,options,pinned} of observed) {
    assert.equal(options.servername,url.hostname);
    assert.equal(options.agent,false);
    assert.equal(options.headers.Cookie,undefined);
    assert.equal(options.headers.Authorization,undefined);
    assert.deepEqual(pinned,[{error:null,records:[{address:'93.184.216.34',family:4}]}]);
  }
});

test('standalone public fetch enforces the same two-million-byte body limit',async()=>{
  const response=await safeMusicFetch(fixtures[0].url,{
    lookup:async()=>[{address:'93.184.216.34',family:4}],
    request:(_url,_options,callback)=>{
      const req=new EventEmitter();
      req.end=()=>{
        const body=Readable.from([Buffer.alloc(1_000_000),Buffer.alloc(1_000_001)]);
        body.statusCode=200;body.headers={};
        callback(body);
      };
      return req;
    },
  });
  await assert.rejects(response.text(),/evidence size limit/);
});
