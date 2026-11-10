import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exportSavedBatchSources,savedSourceQueries} from './instagram-saved-source-export.mjs';
import {prepareNextSavedBatch,enrichedRequest,digest} from './instagram-next-saved-batch.mjs';
import {metadataQueries} from './instagram-artist-metadata-overlay.mjs';
import {openSavedBatchGate} from './instagram-saved-batch-gate.mjs';

const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>assert.fail('Offline source tests must never reach a database or provider over the network.');});
test.after(()=>{globalThis.fetch=originalFetch;});

const instagram='https://www.instagram.com/synthetic_artist/';
const spotify='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
async function fixture(t,{exported=true,mutate=()=>{}}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'musician-source-export-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const rows=Array.from({length:500},(_,i)=>({profile_id:String(i+1),cm_artist:String(i+1001),
    artist:`Search artist ${i}`,tier_rank:3,captured_at:'2026-11-10',
    result_json:JSON.stringify({profiles:[{url:instagram,title:'Historical title',snippet:'Not a biography'}]})}));
  await fs.writeFile(path.join(dir,'discovery-1.json'),JSON.stringify(rows));
  const data={catalogProfiles:rows.map(r=>({profile_id:r.profile_id,cm_artist:r.cm_artist,
    name:`Catalog artist ${r.profile_id}`,source_updated_at:'2026-11-10'})),
    accounts:[{profile_id:'1',cm_artist:'1001',account_id:'9',platform:'spotify',account_url:spotify,handle:'synthetic'}],
    chartmetric:[{cm_artist:'1001',code2:'GB'}]};
  mutate(data);
  const manifest={artists:rows.map(({profile_id,cm_artist})=>({profile_id,cm_artist}))};
  const queries=savedSourceQueries(manifest),calls=[];
  const query=async sql=>{
    calls.push(sql);
    assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/\b(?:INSERT|DELETE|UPDATE|ALTER|CREATE)\b/);
    const key=Object.keys(queries).find(k=>queries[k]===sql);
    assert.ok(key,'Only authoritative source queries may run');
    return structuredClone(data[key]);
  };
  const result=exported?await exportSavedBatchSources(dir,{query,now:()=> '2026-11-10'}):null;
  return {dir,rows,data,query,calls,result,manifest};
}
async function edit(dir,name,change,{rehash=false}={}) {
  const file=path.join(dir,name),data=JSON.parse(await fs.readFile(file,'utf8'));
  change(data);
  const raw=JSON.stringify(data);await fs.writeFile(file,raw);
  if(rehash)await edit(dir,'source-export.json',receipt=>{receipt.files[name]=digest(raw);});
}
async function blockedBeforeAdmission(dir,previous,pattern) {
  let launcherCalls=0,admissions=0,providerCalls=0;
  await assert.rejects(async()=>{
    const targets=await prepareNextSavedBatch(dir,previous);
    // Exercise the real gate boundary with database/transport sentinels. No
    // partial preparation may even claim a budget, let alone admit a request.
    launcherCalls++;
    const body={url:instagram};
    const scope={authorization:{approved:true,maxSpendCents:2,budgetId:'offline-sentinel'},
      savedEvidenceOnly:false,candidateMetadataFetchesApproved:true,liveLinkWrites:false,automaticRetries:0,
      artists:targets.map(t=>t.player),requests:[{key:'offline',profileId:targets[0].profileId,
        kind:'scrapecreators_candidate',body,sha256:digest(body),bytes:Buffer.byteLength(JSON.stringify(body))}]};
    const gate=await openSavedBatchGate({scope,scopeSha256:digest(scope),journalPath:path.join(dir,'never-admitted.jsonl'),
      pool:{connect:async()=>{admissions++;assert.fail('No database admission during rejected preparation.');}},
      transport:{live:true,dispatch:async()=>{providerCalls++;assert.fail('No provider during rejected preparation.');}}});
    try{await gate.request('offline');}finally{await gate.close();}
  },pattern);
  assert.equal(launcherCalls,0);assert.equal(admissions,0);assert.equal(providerCalls,0);
}
const previous={artists:[]};

test('authoritative query uses singular musician profile, relationship and account models with an identity join',()=>{
  const manifest={artists:[{profile_id:'1',cm_artist:'1001'}]};
  const q=savedSourceQueries(manifest),all=metadataQueries(manifest);
  for(const key of Object.keys(q))assert.equal(q[key],all[key]);
  assert.match(q.catalogProfiles,/FROM new_vertical\.profile FINAL/);
  assert.match(q.catalogProfiles,/cm_source='cm_artist'/);
  assert.match(q.accounts,/FROM new_vertical\.l_profile_account AS l FINAL/);
  assert.match(q.accounts,/FROM new_vertical\.account FINAL/);
  assert.match(q.accounts,/toString\(p\.cm_source_id\) cm_artist/);
  assert.match(q.accounts,/p ON p\.id=l\.profile_id/);
  assert.match(q.accounts,/cm_source='cm_artist'/);
  assert.match(q.accounts,/is_active=1 AND platform!='instagram'/);
  assert.match(q.accounts,/l\.disconnected_at IS NULL/);
  assert.doesNotMatch(Object.values(q).join('\n'),/poc_new_verticals|new_vertical\.profiles\b|new_vertical\.accounts\b/);
});
test('valid offline export freezes identities, exact query/file provenance and non-authoritative references',async t=>{
  const f=await fixture(t),targets=await prepareNextSavedBatch(f.dir,previous);
  assert.equal(f.calls.length,3);assert.equal(f.result.paidProviderCalls,0);assert.equal(f.result.databaseWrites,0);
  assert.equal(targets.length,500);assert.equal(targets[0].player.source_identity_matches,true);
  assert.equal(targets[0].sourceExportSha256,f.result.sourceExportSha256);
  assert.equal(targets[0].player.source_export_sha256,f.result.sourceExportSha256);
  const request=enrichedRequest(targets[0],{url:instagram,displayName:'Captured artist',bio:'Captured bio',externalUrls:[]});
  assert.equal(request.profile.identityComparison.reference.url,spotify);
  assert.match(request.body.state.artistContext.note,/Context only, not ownership proof/);
  assert.match(request.body.state.catalogReferenceNote,/ownership and biography were not newly fetched/);
  assert.equal(request.body.state.savedSearchEvidence.snippet,'Not a biography');
  await assert.rejects(exportSavedBatchSources(f.dir,{query:()=>assert.fail('No query on overwrite')}),/already exists/);
});
test('catalog-only artists need a validated profile, not an invented external reference or biography',async t=>{
  const f=await fixture(t,{mutate:d=>{d.accounts=[];}});
  const targets=await prepareNextSavedBatch(f.dir,previous);
  const r=enrichedRequest(targets[0],{url:instagram,displayName:'Candidate',bio:'Candidate only',externalUrls:[]});
  assert.equal(r.profile.identityComparison.reference.platform,'catalog');
  assert.equal(r.body.state.knownProfileUrl,'https://app.chartmetric.com/artist/1001');
  assert.match(r.body.state.catalogReferenceNote,/not a newly captured or artist-owned external profile/);
  assert.deepEqual(targets[0].player.accounts,[]);
  assert.equal(targets[0].context.ownershipConfirmed,false);
  assert.deepEqual(targets[0].context.items.map(i=>i.kind),['country']);
  assert.equal(targets[1].context.items.length,0);
});
test('contextual snapshots cannot supply frozen accounts or ownership proof',async t=>{
  const f=await fixture(t,{mutate:d=>{d.accounts=[];}});
  await fs.writeFile(path.join(f.dir,'snapshots.json'),JSON.stringify([
    {profile_id:'1',platform:'spotify',bio:`I own ${instagram}`,account_url:spotify},
  ]));
  const [target]=await prepareNextSavedBatch(f.dir,previous);
  assert.deepEqual(target.player.accounts,[]);
  assert.equal(target.context.ownershipConfirmed,false);
  assert.ok(target.context.items.every(i=>i.kind==='country'));
  const r=enrichedRequest(target,{url:instagram,displayName:'Candidate',externalUrls:[]});
  assert.equal(r.profile.identityComparison.reference.platform,'catalog');
  assert.ok(!JSON.stringify(r.body).includes('I own'));
});
for(const [label,mutate] of [
  ['profile/Chartmetric mismatch',d=>{d.catalogProfiles[0].cm_artist='9999';}],
  ['wrong profile ID with the right Chartmetric ID',d=>{d.catalogProfiles[0].profile_id='9999';}],
  ['same-number account in a parallel catalog',d=>{d.accounts[0].cm_artist='9999';}],
  ['numeric-only legacy account binding',d=>{delete d.accounts[0].cm_artist;}],
  ['legacy grouped accounts without row identity bindings',d=>{d.accounts=[
    {profile_id:'1',accounts:[['9','spotify',spotify,'synthetic']]},
  ];}],
  ['empty profiles with nonempty accounts',d=>{d.catalogProfiles=[];}],
  ['duplicate profile rows',d=>{d.catalogProfiles.push({...d.catalogProfiles[0]});}],
  ['foreign accounts',d=>{d.accounts[0].profile_id='9999';}],
  ['duplicate account bindings',d=>{d.accounts.push({...d.accounts[0]});}],
  ['foreign Chartmetric metadata',d=>{d.chartmetric[0].cm_artist='9999';}],
]){
  test(`${label} cannot be exported or prepared even with recomputed file hashes`,async t=>{
    const invalid=await fixture(t,{exported:false,mutate});
    await assert.rejects(exportSavedBatchSources(invalid.dir,{query:invalid.query}),/identity|binding|Incomplete/);
    await assert.rejects(fs.access(path.join(invalid.dir,'source-export.json')),/ENOENT/);
    const valid=await fixture(t);
    // Recomputed local hashes must not substitute for identity checks.
    const source={catalogProfiles:'frozen-profiles.json',accounts:'frozen-accounts.json',chartmetric:'frozen-country.json'};
    const altered=structuredClone(valid.data);mutate(altered);
    for(const [key,name] of Object.entries(source))
      await edit(valid.dir,name,rows=>rows.splice(0,rows.length,...altered[key]),{rehash:true});
    await blockedBeforeAdmission(valid.dir,previous,/identity|binding|Incomplete/);
  });
}
for(const name of ['frozen-profiles.json','frozen-accounts.json','frozen-country.json','discovery-1.json']){
  test(`changed ${name} bytes invalidate preparation before admission`,async t=>{
    const f=await fixture(t);
    await fs.appendFile(path.join(f.dir,name),' ');
    await blockedBeforeAdmission(f.dir,previous,/hash changed/);
  });
}
for(const model of ['poc_new_verticals.accounts','new_vertical.accounts']){
  test(`same-number ${model} rows cannot masquerade as musician account provenance`,async t=>{
    const f=await fixture(t);
    await edit(f.dir,'source-export.json',r=>{r.queries.accounts=r.queries.accounts.replace('new_vertical.account FINAL',`${model} FINAL`);});
    await blockedBeforeAdmission(f.dir,previous,/provenance/);
  });
}
test('missing receipt, changed receipt scope, query or file set fails closed',async t=>{
  for(const change of [
    r=>{r.scope[0].cm_artist='9999';},
    r=>{r.queries.catalogProfiles+=' LIMIT 1';},
    r=>{r.files['unbound-snapshots.json']='not-a-hash';},
    r=>{delete r.files['frozen-accounts.json'];},
    r=>{r.ownershipConfirmed=true;},
  ]){
    const f=await fixture(t);await edit(f.dir,'source-export.json',change);
    await blockedBeforeAdmission(f.dir,previous,/provenance|file set/);
  }
  const f=await fixture(t);await fs.unlink(path.join(f.dir,'source-export.json'));
  await blockedBeforeAdmission(f.dir,previous,/ENOENT/);
});
test('previous cohort reuse is rejected by either normalized profile ID or Chartmetric ID',async t=>{
  const f=await fixture(t);
  for(const artist of [{profile_id:1,cm_artist:9999},{profile_id:9999,cm_artist:1001}]){
    await blockedBeforeAdmission(f.dir,{artists:[artist]},/Prior artist would be charged again/);
  }
});
test('empty, duplicate and changed discovery identity sets cannot use an older receipt',async t=>{
  for(const change of [
    rows=>rows.splice(0),
    rows=>{rows[1].profile_id=rows[0].profile_id;},
    rows=>{rows[1].cm_artist=rows[0].cm_artist;},
    rows=>{rows[0].cm_artist='99999';},
  ]){
    const f=await fixture(t);await edit(f.dir,'discovery-1.json',change);
    await blockedBeforeAdmission(f.dir,previous,/scope|identity|provenance/);
  }
});
