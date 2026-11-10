import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectSavedCases,revisedProfile,runSavedFixRerun,rerunCodeFingerprint,prepareSavedFixRerun} from './instagram-saved-fix-rerun.mjs';

const make=i=>{
  const spotify=`https://open.spotify.com/artist/${String(i).padStart(22,'A')}`;
  const youtube=`https://www.youtube.com/@artist_${i}`;
  return {artist:{profile_id:String(i),cm_artist:String(100+i),artist:`Musician ${i}`,
    account_ids:[String(i)],accounts:[{account_id:String(i),platform:'youtube',account_url:youtube}]},
  priority:i%3,
  profile:{url:`https://www.instagram.com/artist_${i}/`,
    identityComparison:{reference:{platform:'spotify',url:spotify},candidate:{
      url:`https://www.instagram.com/artist_${i}/`,displayName:`Musician ${i}`,externalUrls:[youtube],directExternalUrls:[youtube]},
      status:'uncertain'},jevVerification:{verdict:'likely',sameIdentityProbability:0.5+i/1000}},
  context:{ownershipConfirmed:false,items:[]}};
};
test('comparison targets at most 20 distinct artists and never substitutes missing metadata',()=>{
  const pool=Array.from({length:30},(_,i)=>make(i+1));
  const selected=selectSavedCases([...pool,{artist:{profile_id:'99'},priority:0}]);
  assert.equal(selected.length,20);
  assert.equal(new Set(selected.map(c=>c.artist.profile_id)).size,20);
  for(const c of selected){
    assert.notEqual(c.control.profileId,c.artist.profile_id);
    assert.notEqual(c.control.profile.url,c.profile.url);
  }
  assert.throws(()=>selectSavedCases(pool,21),/at most 20/);
});
test('revised saved profiles gain exact alternate bindings without changing archived decisions',()=>{
  const input=make(1),before=JSON.stringify(input);
  const revised=revisedProfile(input.profile,input.artist);
  assert.equal(revised.identityComparison.status,'likely');
  assert.equal(revised.identityComparison.catalogConnections.length,1);
  assert.equal(revised.jevVerification,undefined);
  assert.equal(JSON.stringify(input),before);
  assert.throws(()=>revisedProfile({...input.profile,url:'https://www.instagram.com/wrong/'},input.artist),/identity-bound/);
});
test('paid entry refuses unmerged fixes before opening an admissions journal or making network calls',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fix-rerun-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const scope={manifest:{},cases:[]},digest=createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  await fs.writeFile(path.join(dir,'prepared-scope.json'),JSON.stringify(scope));
  await fs.writeFile(path.join(dir,'prepared-scope-receipt.json'),JSON.stringify({sha256:digest}));
  await fs.writeFile(path.join(dir,'merged-validation.json'),JSON.stringify({
    task144:'MERGED',task145:'MERGING',offlineTestsPassed:true}));
  const oldFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('Network forbidden');};
  try{
    await assert.rejects(runSavedFixRerun(dir),/Both merged fixes/);
    assert.equal(calls,0);
    await assert.rejects(fs.stat(path.join(dir,'admissions.jsonl')),/ENOENT/);
  }finally{globalThis.fetch=oldFetch;}
});
test('preparation cannot increase the shared ceiling and code validation has a stable receipt',async()=>{
  await assert.rejects(prepareSavedFixRerun({priorReservedCents:901}),/unchanged shared/);
  const a=await rerunCodeFingerprint(),b=await rerunCodeFingerprint();
  assert.match(a,/^[a-f0-9]{64}$/);assert.equal(a,b);
});
