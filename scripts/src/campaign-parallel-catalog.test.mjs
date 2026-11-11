import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createCatalogReader,CATALOG_RETRY_POLICY} from './campaign-parallel-catalog.mjs';
import {compileCatalogRecovery} from './prepare-instagram-catalog-resume.mjs';
import {safeDiagnostic} from './campaign-parallel-core.mjs';
const env={CLICKHOUSE_VERT_HOST:'catalog.example.test',CLICKHOUSE_USERNAME:'fixture-user',CLICKHOUSE_PASSWORD:'fixture-secret'};
const query='SELECT id FROM new_vertical.profile';
const ok=()=>new Response(JSON.stringify({data:[{id:1}]}));
test('only SELECT at the configured catalog endpoint is eligible for retries',async()=>{
  let calls=0;const reader=createCatalogReader({env,fetchImpl:async()=>{calls++;return ok();}});
  await assert.rejects(reader('UPDATE x SET id=1'));assert.equal(calls,0);
  const provider=createCatalogReader({env:{...env,CLICKHOUSE_VERT_HOST:'api.scrapecreators.com'},fetchImpl:async()=>{calls++;return ok();}});
  await assert.rejects(provider(query),/Paid-provider/);assert.equal(calls,0);
  assert.deepEqual(await reader(query),[{id:1}]);assert.equal(calls,1);
});
test('transient catalog failures retry identical SQL with bounded waits and readonly settings',async()=>{
  const requests=[],waits=[],events=[];let id=0;
  const reader=createCatalogReader({env,sleep:async ms=>waits.push(ms),onDiagnostic:e=>events.push(e),
    idFactory:()=>String(++id),fetchImpl:async(url,options)=>{
      requests.push({url,options});return requests.length<3?new Response('temporary',{status:503}):ok();
    }});
  assert.deepEqual(await reader(query),[{id:1}]);
  assert.deepEqual(waits,CATALOG_RETRY_POLICY.backoffMs);assert.equal(requests.length,3);
  assert.ok(requests.every(r=>r.options.body===query+' FORMAT JSON'&&r.url.searchParams.get('readonly')==='1'));
  assert.equal(new Set(requests.map(r=>r.url.searchParams.get('query_id'))).size,3);
  assert.ok(!JSON.stringify(events).includes('fixture-secret'));
});
for(const code of [47,60,497,99999])test('nontransient ClickHouse exception '+code+' is never retried',async()=>{
  let calls=0;const events=[];
  const reader=createCatalogReader({env,onDiagnostic:e=>events.push(e),sleep:async()=>assert.fail('No retry'),
    fetchImpl:async()=>{calls++;return new Response('private server detail',{status:500,headers:{'x-clickhouse-exception-code':String(code)}});}});
  await assert.rejects(reader(query),error=>{
    assert.equal(error.code,`CATALOG_HTTP_500_CH_${code}`);
    assert.equal(safeDiagnostic(error,'catalog_metadata').code,error.code);return true;
  });assert.equal(calls,1);assert.ok(!JSON.stringify(events).includes('private server detail'));
});
test('a recognized resource-pressure exception may be retried without exposing its body',async()=>{
  let calls=0;const events=[];
  const reader=createCatalogReader({env,onDiagnostic:e=>events.push(e),sleep:async()=>{},
    fetchImpl:async()=>++calls===1?new Response('Code: 241. private fixture-secret',{status:500}):ok()});
  await reader(query);assert.equal(calls,2);assert.equal(events[0].exceptionCode,241);
  assert.ok(!JSON.stringify(events).includes('fixture-secret'));
});
test('transient exhaustion stops after exactly three attempts',async()=>{
  let calls=0;
  const reader=createCatalogReader({env,onDiagnostic:()=>{},sleep:async()=>{},
    fetchImpl:async()=>{calls++;return new Response('busy',{status:502});}});
  await assert.rejects(reader(query),e=>e.code==='CATALOG_HTTP_502_CH_UNKNOWN');assert.equal(calls,3);
});
test('authorization and malformed successful responses do not retry',async()=>{
  for(const response of [()=>new Response('no',{status:403}),
    ()=>new Response('invalid json'),()=>new Response('{"data":null}')]){
    let calls=0;const reader=createCatalogReader({env,onDiagnostic:()=>{},sleep:async()=>assert.fail('No retry'),
      fetchImpl:async()=>{calls++;return response();}});
    await assert.rejects(reader(query));assert.equal(calls,1);
  }
});
test('known catalog socket failures retry but arbitrary programming errors do not',async()=>{
  let calls=0;const reader=createCatalogReader({env,onDiagnostic:()=>{},sleep:async()=>{},
    fetchImpl:async()=>{if(++calls===1)throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});return ok();}});
  await reader(query);assert.equal(calls,2);
  calls=0;const broken=createCatalogReader({env,onDiagnostic:()=>{},sleep:async()=>assert.fail('No retry'),
    fetchImpl:async()=>{calls++;throw new TypeError('invalid fixture');}});
  await assert.rejects(broken(query));assert.equal(calls,1);
});
test('catalog read deadlines are bounded and preserve a safe stop code',async()=>{
  let calls=0;
  const reader=createCatalogReader({env,onDiagnostic:()=>{},sleep:async()=>{},
    fetchImpl:async()=>{calls++;throw new DOMException('fixture timeout','TimeoutError');}});
  await assert.rejects(reader(query),error=>{
    assert.equal(error.code,'CATALOG_READ_TIMEOUT');
    assert.equal(safeDiagnostic(error,'catalog_metadata').code,'CATALOG_READ_TIMEOUT');return true;
  });
  assert.equal(calls,3);
});
test('a sealed runtime retains sanitized catalog diagnostics beside its approval',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-diagnostics-'));
  try{
    await fs.mkdir(dir+'/runtime');
    await fs.copyFile('scripts/src/campaign-parallel-catalog.mjs',dir+'/runtime/campaign-parallel-catalog.mjs');
    const {createCatalogReader:sealed}=await import(pathToFileURL(dir+'/runtime/campaign-parallel-catalog.mjs'));
    let calls=0;
    await sealed({env,sleep:async()=>{},fetchImpl:async()=>++calls===1?
      new Response('private fixture-secret body',{status:503}):ok()})(query);
    const text=await fs.readFile(dir+'/catalog-read-diagnostics.jsonl','utf8'),entry=JSON.parse(text.trim());
    assert.equal(entry.event,'catalog_read_retry');assert.equal(entry.httpStatus,503);
    assert.equal(entry.queryKind,'profile');assert.match(entry.querySha256,/^[a-f0-9]{64}$/);
    assert.ok(!text.includes('fixture-secret')&&!text.includes(query));assert.ok(entry.queryId);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('recovery compilation changes catalog bindings only and leaves its parent immutable',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-recovery-')),parent=dir+'/parent';
  const hash=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
  const sources={
    'campaign-parallel-resume.mjs':"import {select} from './instagram-artist-metadata-overlay.mjs';\n// unchanged scheduler\n",
    'campaign-parallel-adapters.mjs':"import {select,metadataQueries,buildMetadataOverlay} from './instagram-artist-metadata-overlay.mjs';\n// unchanged paid evidence processing\n",
    'ownership-policy.mjs':'// sealed original evidence policy\n',
  };
  try{
    await fs.mkdir(parent);await fs.mkdir(dir+'/node_modules');
    for(const [name,text] of Object.entries(sources))await fs.writeFile(parent+'/'+name,text);
    const result=await compileCatalogRecovery({parentRuntime:parent,runtime:dir+'/runtime',
      parentFiles:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,hash(v)])),
      moduleFile:path.resolve('scripts/src/campaign-parallel-catalog.mjs'),nodeModules:dir+'/node_modules',hash});
    assert.deepEqual(result.changed,['campaign-parallel-adapters.mjs','campaign-parallel-resume.mjs']);
    assert.equal(await fs.readFile(dir+'/runtime/ownership-policy.mjs','utf8'),sources['ownership-policy.mjs']);
    for(const [name,text] of Object.entries(sources))assert.equal(await fs.readFile(parent+'/'+name,'utf8'),text);
    assert.match(await fs.readFile(dir+'/runtime/campaign-parallel-adapters.mjs','utf8'),/unchanged paid evidence processing/);
    await assert.rejects(compileCatalogRecovery({parentRuntime:parent,runtime:dir+'/runtime',
      parentFiles:{},moduleFile:'unused',nodeModules:dir+'/node_modules',hash}),/EEXIST/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
