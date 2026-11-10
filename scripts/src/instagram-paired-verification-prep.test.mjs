import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {preparePairedVerification,pairedRequests} from './instagram-paired-verification-prep.mjs';
import {createPilotBudget} from './instagram-pilot-budget.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const save=(f,d)=>fs.writeFile(f,JSON.stringify(d));

function item(index){
  const id=String(index),name=`Artist ${index}`,url=`https://www.instagram.com/artist_${index}/`;
  const music=`https://open.spotify.com/artist/${String.fromCharCode(65+index).repeat(22)}`;
  const artist={profile_id:id,cm_artist:`cm-${id}`,artist:name,account_ids:[`${id}-s`,`${id}-y`,`${id}-t`],accounts:[
    {profile_id:id,account_id:`${id}-s`,platform:'spotify',account_url:music},
    {profile_id:id,account_id:`${id}-y`,platform:'youtube',account_url:`https://www.youtube.com/@artist_${id}`},
    {profile_id:id,account_id:`${id}-t`,platform:'tiktok',account_url:`https://www.tiktok.com/@artist_${id}`},
  ]};
  const profile={url,title:name,identityComparison:{status:'likely',
    reference:{platform:'spotify',url:music,displayName:name},
    candidate:{url,displayName:name,bio:'Singer',externalUrls:[music],directExternalUrls:[music]}},
    jevVerification:{verdict:'likely',sameIdentityProbability:0.6}};
  return {artist,profile,context:{ownershipConfirmed:false,items:[]},priority:0};
}
async function fixture(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'paired-prep-')),sourceDir=path.join(dir,'source'),archive=path.join(dir,'archive');
  await fs.mkdir(sourceDir);await fs.mkdir(path.join(sourceDir,'responses'));await fs.mkdir(archive);
  const cases=Array.from({length:6},(_,i)=>item(i+1));
  cases[0].profile.identityComparison.reference.externalUrls=[cases[0].profile.url];
  const multi=cases[1].profile.identityComparison.candidate;
  multi.bio='公式Instagram';multi.externalUrls=multi.directExternalUrls=cases[1].artist.accounts.slice(1).map(a=>a.account_url);
  cases[3].profile.jevVerification.verdict='uncertain';
  cases[4].profile.identityComparison.candidate.displayName='Different Person';
  cases[5].profile.identityComparison.candidate.externalUrls=cases[5].profile.identityComparison.candidate.directExternalUrls=[];
  const donors=Array.from({length:6},(_,i)=>item(i+10));
  const manifest=JSON.stringify({artists:donors.map(d=>d.artist)});
  const results=donors.map(d=>JSON.stringify({profileId:d.artist.profile_id,rawResult:{profiles:[d.profile]}})).join('\n');
  await fs.writeFile(path.join(archive,'approved-manifest.json'),manifest);
  await fs.writeFile(path.join(archive,'results.jsonl'),results);
  const scope={cases,inputs:[{directory:archive,manifestSha256:hash(manifest),resultsSha256:hash(results)}]};
  await save(path.join(sourceDir,'prepared-scope.json'),scope);
  for(const c of cases){
    const decisionRequest={state:{artist:c.artist.artist,candidates:[{url:c.profile.url,reference:c.profile.identityComparison.reference}]}};
    await save(path.join(sourceDir,'responses',`${c.artist.profile_id}-candidate.json`),{
      status:200,profileId:c.artist.profile_id,decisionRequest,requestBodySha256:hash(JSON.stringify(decisionRequest)),
      data:{model:'fixture-model',answers:{
        candidate_0_verdict:{choice:c.profile.jevVerification.verdict},
        candidate_0_same_identity:{noul:c.profile.jevVerification.sameIdentityProbability}}}});
  }
  const budgetFile=path.join(dir,'budget.json');
  await save(budgetFile,{budgetId:'musician-instagram-pilot-2026-11-05',maxSpendCents:1000,reservedSpendCents:948,observedAt:'2026-11-10T01:46:12.455Z'});
  return {dir,sourceDir,budgetFile,outputDir:path.join(dir,'prepared'),cases};
}

test('preparation freezes 24 complete paired requests, six unique controls, and no spending approval', async()=>{
  const f=await fixture(),fetch=globalThis.fetch;
  globalThis.fetch=()=>{throw Error('Offline preparation must not call providers.');};
  try{
    const before=await fs.readFile(f.budgetFile,'utf8');
    const result=await preparePairedVerification(f);
    assert.equal(result.requests,24);assert.equal(result.maximumConservativeReservationUsd,0.48);
    assert.equal(result.executionAllowed,false);assert.equal(result.paidCalls,0);
    const manifest=JSON.parse(await fs.readFile(path.join(f.outputDir,'prepared-manifest.json'),'utf8'));
    assert.equal(manifest.controlCoverage.distinctControlAccounts,6);
    assert.equal(manifest.controlCoverage.reusedComparisons,0);
    assert.equal(manifest.intentionalControlArmRepeats,6);
    assert.equal(manifest.authorization.approved,false);assert.equal(manifest.run_allowed,false);
    assert.equal(manifest.remainingPilotCentsAfterProposedReservation,4);
    const groups=new Map();
    for(const r of manifest.requests){
      const bytes=await fs.readFile(path.join(f.outputDir,r.requestFile));
      assert.equal(hash(bytes),r.sha256);assert.equal(bytes.length,r.bytes);assert.ok(bytes.length<=6000);
      const key=`${r.profileId}:${r.kind}`;
      if(groups.has(key))assert.equal(r.sourceEvidenceSha256,groups.get(key));else groups.set(key,r.sourceEvidenceSha256);
    }
    assert.equal(groups.size,12);
    await assert.rejects(createPilotBudget({manifest,mode:'live',journalPath:path.join(f.dir,'admissions.jsonl'),
      transport:{live:true,dispatch:()=>{throw Error('Dispatch must be unreachable.');}}}),/disabled/);
    assert.equal(await fs.readFile(f.budgetFile,'utf8'),before);
    const saved=await fs.readFile(path.join(f.outputDir,'prepared-manifest.json'),'utf8');
    await assert.rejects(preparePairedVerification(f),{code:'EEXIST'});
    assert.equal(await fs.readFile(path.join(f.outputDir,'prepared-manifest.json'),'utf8'),saved);
  }finally{globalThis.fetch=fetch;await fs.rm(f.dir,{recursive:true,force:true});}
});
test('insufficient remaining ceiling and changed frozen inputs cannot produce a ready scope',async()=>{
  const f=await fixture();
  try{
    const b=JSON.parse(await fs.readFile(f.budgetFile,'utf8'));b.reservedSpendCents=953;await save(f.budgetFile,b);
    await assert.rejects(preparePairedVerification(f),/unchanged shared ceiling/);
    await assert.rejects(fs.stat(f.outputDir),{code:'ENOENT'});
    b.reservedSpendCents=948;await save(f.budgetFile,b);
    const p=path.join(f.sourceDir,'responses','1-candidate.json'),packet=JSON.parse(await fs.readFile(p,'utf8'));
    packet.decisionRequest.state.artist='Tampered';await save(p,packet);
    await assert.rejects(preparePairedVerification(f),/binding failed/);
  }finally{await fs.rm(f.dir,{recursive:true,force:true});}
});
test('paired construction cannot silently drop essential or oversized source evidence',()=>{
  const c=item(1),before=JSON.stringify(c);
  const pair=pairedRequests(c,c.profile);
  assert.equal(pair[0].sourceEvidenceSha256,pair[1].sourceEvidenceSha256);
  assert.equal(JSON.stringify(c),before);
  const huge=structuredClone(c);huge.artist.artist='x'.repeat(10000);
  assert.throws(()=>pairedRequests(huge,huge.profile),/cap|exceeds/);
});
