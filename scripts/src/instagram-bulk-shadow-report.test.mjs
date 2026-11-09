import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {classifyShadowResult,reportShadowRun} from './instagram-bulk-shadow-report.mjs';
test('absence, restriction, uncertainty and supported research remain distinct',()=>{
  assert.equal(classifyShadowResult({status:'no_candidates'}),'completed_no_candidates');
  assert.equal(classifyShadowResult({status:'needs_review'}),'unresolved_candidates');
  assert.equal(classifyShadowResult({reason:'reference unavailable'}),'processing_incomplete');
  assert.equal(classifyShadowResult({reason:'unreadable',partialEvidence:{profiles:[
    {metadataLookupError:'Restricted profile; skipped without absence claim.'}]}}),'restricted_skip');
  assert.equal(classifyShadowResult({urls:['https://www.instagram.com/example/']}),'supported_research_links');
});
test('report keeps raw URLs separate and non-importable; CSV text cannot execute formulas',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shadow-report-test-'));
  try{
    await fs.writeFile(path.join(dir,'approved-manifest.json'),JSON.stringify({artists:[
      {profile_id:'1',cm_artist:'2',artist:'=UNTRUSTED_FORMULA()',tier:2,account_ids:['3']}]}));
    await fs.writeFile(path.join(dir,'summary.json'),JSON.stringify({results:[{
      profileId:'1',cmArtist:'2',status:'needs_review',urls:[],
      discoveryAttempts:[{methodsUsed:[{method:'serper',status:'used'}],profiles:[
        {url:'https://www.instagram.com/example/'}]}],
      rawResult:{profiles:[{url:'https://www.instagram.com/example/',
        jevVerification:{verdict:'verified',sameIdentityProbability:0.8}}]},
      candidates:[{url:'https://www.instagram.com/example/',status:'needs_review',reason:'Below current gate'}]}],
      budget:{paid:3,reservedSpendCents:5,stopped:null},cumulativeReservedUsd:4.04}));
    const r=await reportShadowRun(dir);assert.equal(r.profilesWithRawCandidates,1);
    assert.equal(r.profilesWithSupportedResearchLinks,0);assert.equal(r.safeForImport,false);
    assert.equal(r.readyForFullRerun,false);assert.equal(r.categoricallyVerifiedCandidates,1);
    const csv=await fs.readFile(path.join(dir,'artist-research-results.csv'),'utf8');
    assert.ok(csv.includes(`"'=UNTRUSTED_FORMULA()"`));
    assert.ok(csv.includes('"accountIds"'));
    const candidates=await fs.readFile(path.join(dir,'candidate-evidence.csv'),'utf8');
    assert.ok(candidates.includes('"artist"'));
    assert.ok(candidates.includes(`"'=UNTRUSTED_FORMULA()"`));
    assert.equal(r.decisions[0].artist,'=UNTRUSTED_FORMULA()');
    await assert.rejects(reportShadowRun(dir),/EEXIST/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
