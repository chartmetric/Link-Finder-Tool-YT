// Fixed reference-label research, not blind artist discovery. No retries/imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
import {auditReferenceLinks, referenceTargets, sha256} from './instagram-reference-links.mjs';

async function readBounded(file) {
  const handle = await fs.open(file, 'r');
  try {
    assert.ok((await handle.stat()).size <= 1_000_000, 'Reference artifact byte limit exceeded.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

// Safe default regression mode: only committed fixtures; optional archive replay
// verifies existing local artifacts, never fetches replacements for missing ones.
export async function checkReferenceLinks({verifyArchives = false} = {}) {
  const fixtureText = await readBounded(new URL('../fixtures/instagram-reference-links.json', import.meta.url));
  const fixtures = JSON.parse(fixtureText);
  assert.equal(fixtures.cases.length, 3);
  const results = [];
  for (const row of fixtures.cases) {
    const target = referenceTargets[row.profileId];
    const result = auditReferenceLinks({url: row.archive.url, at: row.archive.at, status: 200,
      html: row.html, bodySha256: sha256(row.html), readableText: ''}, target);
    assert.equal(result.state, 'expected_links_found', row.name);
    assert.equal(result.links.length, 2, 'Tracking aliases must deduplicate.');
    for (const href of row.observedHrefs) {
      assert.ok(result.links.some(link => link.observedHrefs.includes(href)), 'Observed href lost.');
    }
    if (verifyArchives) {
      const directText = await readBounded(row.archive.file);
      const readableText = await readBounded(row.readableArchive.file);
      assert.equal(sha256(directText), row.archive.sha256);
      assert.equal(sha256(readableText), row.readableArchive.sha256);
      const direct = JSON.parse(directText), readable = JSON.parse(readableText);
      assert.equal(direct.id, row.profileId);
      assert.equal(direct.url, row.archive.url);
      assert.equal(direct.at, row.archive.at);
      assert.equal(direct.bodySha256, row.archive.bodySha256);
      assert.equal(direct.status, 200);
      assert.deepEqual(direct.links, row.observedHrefs);
      assert.equal(readable.profileId, row.profileId);
      assert.equal(readable.url, row.readableArchive.url);
      assert.equal(readable.checkedAt, row.readableArchive.at);
      assert.ok(target.sources.includes(readable.url));
      assert.ok(!readable.markdown.toLowerCase().includes('instagram.com/'));
      assert.ok(!readable.markdown.includes(target.spotify));
    }
    results.push({profileId: row.profileId, ...result, archive: row.archive,
      readableArchive: row.readableArchive});
  }
  const negative = fixtures.negative;
  if (verifyArchives) {
    const text = await readBounded(negative.archive.file);
    assert.equal(sha256(text), negative.archive.sha256);
    const original = JSON.parse(text);
    assert.equal(original.url, negative.archive.url);
    assert.equal(original.checkedAt, negative.archive.at);
    for (const href of ['https://linktr.ee/tools/instagram-caption-generator',
      'https://linktr.ee/tools/spotify-playlist-cover-maker',
      'https://linktr.ee/demilovato', 'https://linktr.ee/veggiekins']) {
      assert.ok(original.markdown.includes(href));
    }
  }
  const rejected = auditReferenceLinks({url: negative.archive.url, at: negative.archive.at, status: 200,
    html: negative.html, bodySha256: sha256(negative.html)}, referenceTargets['207595']);
  assert.equal(rejected.state, 'source_not_approved');
  assert.deepEqual(rejected.links, []);
  return {mode: 'offline_reference_regression', fixtureSha256: sha256(fixtureText),
    representation: fixtures.representation, archivesVerified: verifyArchives, results,
    negative: {...rejected, representation: negative.representation, archive: negative.archive},
    networkRequests: 0, paidCalls: 0, imports: 0, databaseWrites: 0, productionPolicyChanged: false};
}

const output='generated-artifacts/instagram-reference-label-audit-2026-11-09-ready';
const queries=[
  ['207595','Aimee Carty official website Instagram'],
  ['270344','Eliah Sternhardt official website Instagram'],
  ['226788','ERNEST official website country music Instagram'],
  ['35092','The Format band official website Instagram'],
  ['216490','JUNHEE official website Instagram'],
  ['226422','VALE duo official website Instagram'],
  ['5643','J Cole official website Instagram'],
  ['205493','RnBoi official website Instagram'],
  ['249317','Gula Gula Festival official website instagram gulagulafestival'],
  ['302463','Golden Legends Cymbals official website Instagram'],
];
const save=(f,x)=>fs.writeFile(f,JSON.stringify(x,null,2),{flag:'wx'});
async function main(){
  if (process.argv.includes('--check-reference-links')) {
    console.log(JSON.stringify(await checkReferenceLinks({
      verifyArchives: process.argv.includes('--verify-reference-archives'),
    }), null, 2));
    return;
  }
  assert.ok(!process.argv.includes('--verify-reference-archives'),
    '--verify-reference-archives requires --check-reference-links.');
  const prior=JSON.parse(await fs.readFile('generated-artifacts/instagram-ownership-rubric-check-2026-11-09/summary.json','utf8'));
  if(!process.argv.includes('--run-approved-audit')) {
    console.log(JSON.stringify({queries,maxReserveUsd:0.10,noImports:true}));return;
  }
  if(!process.env.SERPERDEV_API_KEY) throw Error('Missing SERPERDEV_API_KEY.');
  await fs.mkdir(output,{recursive:false});
  const manifest={run_allowed:true,authorization:{approved:true,approvedBy:'user',maxSpendCents:10,
    source:'User approved assembling independently sourced known-answer examples and comparing verification rules; total new ceiling $0.50 including research and comparison.',
    priorReservedCents:Math.round(prior.cumulativeConservativeReservationUsd*100),
    runId:'instagram-reference-label-audit-2026-11-09-ready',noImports:true},
    artists:queries.map(([profile_id])=>({profile_id,source_identity_matches:true,reference_preflight:{readiness:'reference_usable'}})),
    proposed_limits:{serper_requests_total:10,serper_requests_per_artist:1,
      scrapecreators_requests_total:0,instagram_candidate_metadata_per_artist:0,reference_metadata_per_artist:0,
      jev_requests_total:0,jev_requests_per_artist:0,paid_http_requests_total:10,
      public_spotify_oembed_requests_total:0,public_official_or_linkhub_page_requests_total:0,
      public_http_requests_total:0,public_music_page_requests_per_artist:1,
      global_concurrent_provider_requests:1,per_request_timeout_seconds:20,
      jev_max_input_tokens_per_request:6000,jev_max_output_tokens_per_request:1000,
      automatic_retries:0,job_wall_time_minutes:5},queries};
  await save(`${output}/approved-scope.json`,manifest);
  const transport={live:true,dispatch:async({kind,payload,key,signal})=>{
    assert.equal(kind,'serper');
    const r=await fetch('https://google.serper.dev/search',{method:'POST',redirect:'error',signal,
      headers:{'X-API-KEY':process.env.SERPERDEV_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({q:payload.query,num:5})});
    const text=await r.text();assert.ok(text.length<=1000000);const data=JSON.parse(text);
    await save(`${output}/${key}.json`,{at:new Date().toISOString(),status:r.status,query:payload.query,data});
    if(!r.ok||data.error||!Array.isArray(data.organic)) throw Error(`Reference research failed (HTTP ${r.status}); no retry.`);
    return data;
  }};
  const budget=await createPilotBudget({manifest,transport,mode:'live',journalPath:`${output}/admissions.jsonl`});
  const results=[];
  try{
    for(const[profileId,query]of queries){
      const data=await budget.request({profileId,kind:'serper',key:`reference-${profileId}`,payload:{query},deadlineAt:Date.now()+25000});
      const row={profileId,query,results:data.organic.map(({title,link,snippet})=>({title,link,snippet}))};
      results.push(row);console.log(JSON.stringify(row));
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{
    await budget.close();const s=budget.snapshot();
    await save(`${output}/summary.json`,{results,budget:s,completed:results.length===queries.length,
      cumulativeConservativeReservationUsd:s.sharedBudget.reservedSpendCents/100,
      remainingOriginalBudgetUsd:(s.sharedBudget.maxSpendCents-s.sharedBudget.reservedSpendCents)/100,
      claims:0,databaseWrites:0,coordinationWrites:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
