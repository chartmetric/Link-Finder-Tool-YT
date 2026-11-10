import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {normalizeInstagramProfile,profileLinkDiagnostics,incompleteLinkEvidence} from './instagram-link-capture.mjs';
import {createLiveTransport} from './instagram-pilot-live-transport.mjs';
import {classifyShadowResult,reportShadowRun,relabelShadowRun} from './instagram-bulk-shadow-report.mjs';
import {resolveMusicEvidence} from './public-music-links.mjs';

const url='https://www.instagram.com/example/';
const fixtures=JSON.parse(await fs.readFile(new URL('../fixtures/instagram-link-capture.json',import.meta.url)));
for (const fixture of fixtures) test(fixture.name,()=>{
  const candidate=normalizeInstagramProfile({data:{user:fixture.user}},url);
  assert.equal(candidate.linkCapture.status,fixture.status);
  assert.equal(candidate.directExternalUrls.length,fixture.count);
  assert.equal(candidate.linkCapture.absenceConfirmed,false);
  assert.equal(candidate.linkCapture.sourceUrl,url);
  const profile={url,identityComparison:{candidate}};
  assert.equal(incompleteLinkEvidence(profile),fixture.status==='incomplete_fields');
  assert.equal(classifyShadowResult({rawResult:{profiles:[profile]}}),
    fixture.status==='incomplete_fields'?'processing_incomplete':'unresolved_candidates');
});

test('legacy normalized empty is unknown, never reconstructed as provider empty',()=>{
  assert.equal(profileLinkDiagnostics({url,identityComparison:{candidate:{externalUrls:[]}}}).capture.status,'unknown_legacy_capture');
  assert.throws(()=>normalizeInstagramProfile({data:{user:{username:'other'}}},url),
    e=>e.linkCapture.status==='identity_conflict');
});

test('HTTP restrictions and errors are source-bound and never retried',async t=>{
  for(const [status,data,expected] of [
    [403,{error:'Restricted profile; 18 years old'},'restricted_response'],
    [404,{error:'Profile not found'},'error_response'],
    [500,{error:'Provider failed'},'error_response'],
    [200,{success:false,error:'Provider incomplete'},'error_response'],
  ]) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'link-capture-'));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    let calls=0;
    const transport=createLiveTransport({keys:{SCRAPECREATORS_API_KEY:'fixture',SERPERDEV_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture'},responseDir:dir,
      fetchImpl:async()=>{calls++;return Response.json(data,{status});}});
    await assert.rejects(transport.dispatch({kind:'scrapecreators_candidate',key:'fixture',payload:{url}}),
      e=>e.linkCapture.status===expected && e.linkCapture.sourceUrl===url);
    assert.equal(calls,1);
  }
});

test('resolution cap is separate from capture completeness',async()=>{
  const candidate=normalizeInstagramProfile({data:{user:{username:'example',external_url:'https://linktr.ee/example',bio_links:[]}}},url);
  const hub=await resolveMusicEvidence({candidate,catalog:{platform:'spotify',url:'https://open.spotify.com/artist/0123456789ABCDEFGHIJKL'},
    maxPages:1,readPage:async sourceUrl=>({sourceUrl,musicTargets:['https://linktr.ee/next'],externalUrls:[]})});
  assert.equal(hub.resolutionCapped,true);
  candidate.externalLinkEvidence=hub;
  assert.equal(profileLinkDiagnostics({identityComparison:{candidate}}).resolution,'capped');
  assert.equal(candidate.linkCapture.status,'links_captured');
});

test('JSON and both CSV reports surface incomplete vs explicit empty without mutating inputs',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'link-report-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const profiles=fixtures.slice(0,3).map(f=>({url,identityComparison:{candidate:normalizeInstagramProfile({data:{user:f.user}},url)}}));
  await fs.writeFile(`${dir}/approved-manifest.json`,JSON.stringify({artists:[{profile_id:'1',artist:'Example',cm_artist:'2'}]}));
  const summary=JSON.stringify({results:[{profileId:'1',rawResult:{profiles}}],budget:{paid:0,reservedSpendCents:0}});
  await fs.writeFile(`${dir}/summary.json`,summary);
  const report=await reportShadowRun(dir);
  assert.equal(report.rows[0].finalOutcome,'incomplete');
  assert.deepEqual(report.decisions.map(d=>d.linkCaptureStatus),['explicit_empty','explicit_empty','incomplete_fields']);
  assert.deepEqual(report.linkCaptureStatuses,{explicit_empty:2,incomplete_fields:1});
  for(const name of ['candidate-evidence.csv','artist-research-results.csv']) {
    const text=await fs.readFile(`${dir}/${name}`,'utf8');
    assert.match(text,/explicit_empty/); assert.match(text,/incomplete_fields/);
  }
  assert.equal(await fs.readFile(`${dir}/summary.json`,'utf8'),summary);
  await relabelShadowRun(dir);
  const final=JSON.parse(await fs.readFile(`${dir}/final-outcomes.json`,'utf8'));
  assert.equal(final.rows[0].finalOutcome,'incomplete');
  assert.equal(final.rows[0].countsAsDone,false);
  assert.equal(final.rows[0].linkCaptureDiagnostics[2].capture.status,'incomplete_fields');
  assert.match(await fs.readFile(`${dir}/final-outcomes.csv`,'utf8'),/incomplete_fields/);
  await assert.rejects(reportShadowRun(dir),/EEXIST/);
  await assert.rejects(relabelShadowRun(dir),/EEXIST/);
});
