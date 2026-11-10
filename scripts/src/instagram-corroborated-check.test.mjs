import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkSavedCorroboratedPolicy} from './instagram-corroborated-policy-check.mjs';
const hash = v => createHash('sha256').update(v).digest('hex');

test('offline report is network-free, binds original requests, and never changes archived sources', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'corroborated-check-'));
  const network=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('Network forbidden in offline verification.');};
  try {
    const music='https://open.spotify.com/artist/AAAAAAAAAAAAAAAAAAAAAA';
    const url='https://www.instagram.com/example_artist/';
    const artist={profile_id:'1',artist:'Example Artist',account_ids:['2'],
      accounts:[{profile_id:'1',account_id:'2',platform:'spotify',account_url:music}]};
    const profile={url,identityComparison:{status:'likely',reference:{url:music,platform:'spotify'},
      candidate:{url,displayName:artist.artist,bio:'Musician',externalUrls:[music]}}};
    const donor=structuredClone(profile);donor.url=donor.identityComparison.candidate.url='https://www.instagram.com/donor/';
    donor.identityComparison.candidate.displayName='Different Artist';
    const scope={cases:[{artist,profile,control:{profile:donor},context:{ownershipConfirmed:false,items:[]}}],inputs:[]};
    const scopeBytes=JSON.stringify(scope);
    await fs.mkdir(path.join(dir,'responses'));
    await fs.writeFile(path.join(dir,'prepared-scope.json'),scopeBytes);
    for(const [variant,p] of [['candidate',profile],['control',donor]]) {
      const decisionRequest={state:{artist:artist.artist,candidates:[{url:p.url,reference:p.identityComparison.reference}]}};
      const packet={profileId:'1',status:200,decisionRequest,requestBodySha256:hash(JSON.stringify(decisionRequest)),
        data:{model:'fixture-only',answers:{candidate_0_same_identity:{noul:variant==='candidate'?0.47:0.09},
          candidate_0_verdict:{choice:variant==='candidate'?'likely':'uncertain'}}}};
      await fs.writeFile(path.join(dir,'responses',`1-${variant}.json`),JSON.stringify(packet));
    }
    const output=path.join(dir,'out');
    const report=await checkSavedCorroboratedPolicy(dir,output);
    assert.equal(report.proposedTargetSupport,1);assert.equal(report.proposedControlSupport,0);
    assert.equal(report.newPaidCalls,0);assert.equal(report.productionApproved,false);
    assert.equal(report.thresholdCalibrated,false);
    assert.equal(await fs.readFile(path.join(dir,'prepared-scope.json'),'utf8'),scopeBytes);
    const csv=await fs.readFile(path.join(output,'policy-impact.csv'),'utf8');
    assert.match(csv,/Historical score/);assert.match(csv,/Proposed research support/);
    const responsePath=path.join(dir,'responses','1-candidate.json');
    const corrupt=JSON.parse(await fs.readFile(responsePath,'utf8'));
    corrupt.decisionRequest.state.artist='Changed after dispatch';
    await fs.writeFile(responsePath,JSON.stringify(corrupt));
    await assert.rejects(checkSavedCorroboratedPolicy(dir,path.join(dir,'bad-out')),/hash mismatch/);
    await assert.rejects(fs.stat(path.join(dir,'bad-out')),{code:'ENOENT'});
  } finally {globalThis.fetch=network;await fs.rm(dir,{recursive:true,force:true});}
});
