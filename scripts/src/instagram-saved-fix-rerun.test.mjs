import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectSavedCases,summarizeSavedControls,revisedProfile,runSavedFixRerun,rerunCodeFingerprint,prepareSavedFixRerun} from './instagram-saved-fix-rerun.mjs';

test.beforeEach(t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden in offline control fixtures');});
});

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
  const pool=Array.from({length:40},(_,i)=>make(i+1)),before=JSON.stringify(pool);
  const selected=selectSavedCases([...pool,{artist:{profile_id:'99'},priority:0}]);
  assert.equal(selected.length,20);
  assert.equal(new Set(selected.map(c=>c.artist.profile_id)).size,20);
  assert.equal(new Set(selected.map(c=>c.control.profile.url)).size,20);
  const targetIds=new Set(selected.map(c=>String(c.artist.profile_id)));
  for(const c of selected){
    assert.ok(!targetIds.has(String(c.control.profileId)));
    assert.notEqual(c.control.profile.url,c.profile.url);
    assert.equal(c.control.kind,'cross_artist_synthetic_challenge');
    assert.equal(c.control.ownershipLabel,null);
  }
  assert.equal(JSON.stringify(pool),before);
  assert.deepEqual(selectSavedCases([...pool].reverse()),selected);
  assert.equal(summarizeSavedControls(selected).diversityStatus,'distinct_account_per_target');
  const completed=selected.map(c=>({variant:'control',status:'evaluated',
    profileId:c.artist.profile_id,instagramUrl:c.control.profile.url,gatePassed:false}));
  assert.equal(summarizeSavedControls(selected,completed).evaluatedDiversityStatus,'distinct_account_per_target');
  assert.equal(summarizeSavedControls(selected,completed.slice(0,1)).evaluatedDiversityStatus,'insufficient_control_diversity');
  assert.throws(()=>selectSavedCases(pool,21),/at most 20/);
});

// Model mismatch here only prevents these rows from becoming targets under the
// existing target-ranking rule. It is NOT a ground-truth ownership label.
const control=i=>{
  const item=make(i);
  item.profile.jevVerification={verdict:'mismatch',sameIdentityProbability:0.01};
  return item;
};
const targets=n=>Array.from({length:n},(_,i)=>make(i+1));
const bindUrl=(item,url)=>{
  item.profile.url=url;item.profile.identityComparison.candidate.url=url;
  return item;
};
test('controls rotate deterministically across distinct accounts before balanced reuse',()=>{
  const pool=[...targets(5),control(81),control(82),control(83)];
  const selected=selectSavedCases(pool,5);
  assert.deepEqual(selected.map(c=>c.control.profileId),['81','82','83','81','82']);
  assert.deepEqual(selectSavedCases([...pool].reverse(),5),selected);
  const report=summarizeSavedControls(selected);
  assert.equal(report.targetArtists,5);
  assert.equal(report.assignedComparisons,5);
  assert.equal(report.distinctControlAccounts,3);
  assert.equal(report.reusedComparisons,2);
  assert.equal(report.distinctAccountShortfall,2);
  assert.equal(report.unassignedTargets,0);
  assert.equal(report.diversityStatus,'insufficient_control_diversity');
});
test('every target identity is excluded globally, including aliases and shared catalog IDs',()=>{
  const target=make(1),second=make(2);
  const sameProfile=control(81);sameProfile.artist.profile_id=1;
  const sameCm=control(82);sameCm.artist.cm_artist=Number(second.artist.cm_artist);
  const sameAccount=control(83);sameAccount.artist.account_ids=[Number(target.artist.account_ids[0])];
  const sameAccountRow=control(84);
  sameAccountRow.artist.accounts[0].account_id=second.artist.account_ids[0];
  const sameCatalogUrl=control(85);
  sameCatalogUrl.artist.accounts[0].account_url='https://youtube.com/@ARTIST_1/';
  const sameReference=control(86);
  sameReference.profile.identityComparison.reference=structuredClone(second.profile.identityComparison.reference);
  const sameName=control(87);sameName.artist.artist='MUSICIAN-1';
  const sameIg=bindUrl(control(88),'https://instagram.com/ARTIST_2/?from=saved');
  const alias=control(89);alias.artist.cm_artist=target.artist.cm_artist;
  const duplicateAlias=bindUrl(control(90),alias.profile.url);
  const good=control(99);
  const selected=selectSavedCases([target,second,sameProfile,sameCm,sameAccount,sameAccountRow,
    sameCatalogUrl,sameReference,sameName,sameIg,alias,duplicateAlias,good],2);
  assert.equal(selected.length,2);
  assert.deepEqual(selected.map(c=>c.control.profileId),['99','99']);
  assert.equal(summarizeSavedControls(selected).distinctControlAccounts,1);
});
test('controls with direct or reciprocal cross-links to any target are excluded',()=>{
  const [a,b]=targets(2),direct=control(81),reciprocal=control(82),referenceLink=control(83);
  direct.profile.identityComparison.candidate.directExternalUrls=[a.artist.accounts[0].account_url];
  reciprocal.profile.identityComparison.candidate.bio=b.profile.identityComparison.reference.url;
  a.profile.identityComparison.reference.bio=`Instagram: ${referenceLink.profile.url}`;
  const duplicate=bindUrl(control(84),direct.profile.url);
  const selected=selectSavedCases([a,b,direct,duplicate,reciprocal,referenceLink,control(99)],2);
  assert.deepEqual(selected.map(c=>c.control.profileId),['99','99']);
});
test('URL variants and duplicate archive occurrences count as one account, with metadata bound',()=>{
  const original=control(81),alias=bindUrl(control(82),'https://m.instagram.com/ARTIST_81/?source=archive');
  const unbound=control(83);unbound.profile.identityComparison.candidate.url='https://www.instagram.com/elsewhere/';
  const unreadable=control(84);delete unreadable.profile.identityComparison;
  const pool=[...targets(3),original,alias,structuredClone(original),unbound,unreadable];
  const selected=selectSavedCases(pool,3);
  assert.deepEqual(selectSavedCases([...pool].reverse(),3),selected);
  assert.equal(summarizeSavedControls(selected).distinctControlAccounts,1);
  assert.equal(summarizeSavedControls(selected).reusedComparisons,2);
  const variant=revisedProfile(alias.profile,selected[0].artist);
  assert.equal(variant.url,original.profile.url);
  assert.equal(alias.profile.url,'https://m.instagram.com/ARTIST_81/?source=archive');
});
test('scarce and absent controls retain targets and disclose missing diversity without ownership labels',()=>{
  for(const count of [0,1]){
    const pool=[...targets(4),...(count?[control(81)]:[])];
    const selected=selectSavedCases(pool,4),report=summarizeSavedControls(selected);
    assert.equal(selected.length,4);
    assert.equal(report.targetArtists,4);
    assert.equal(report.distinctControlAccounts,count);
    assert.equal(report.assignedComparisons,count?4:0);
    assert.equal(report.unassignedTargets,count?0:4);
    assert.equal(report.reusedComparisons,count?3:0);
    assert.equal(report.diversityStatus,'insufficient_control_diversity');
    assert.equal(report.ownershipLabelsAssigned,0);
    assert.equal(report.independentlySourceReviewedNegativeLabels,0);
    assert.equal(report.accuracyScored,false);
    assert.equal(report.calibratedFalsePositiveRate,null);
    assert.equal(report.evaluatedDiversityStatus,'not_evaluated');
    if(!count)assert.ok(selected.every(c=>c.control===null));
  }
  assert.equal(summarizeSavedControls([]).diversityStatus,'insufficient_control_diversity');
});
test('evaluated counts separate occurrences, target/account pairs and distinct accounts',()=>{
  const cases=selectSavedCases([...targets(4),control(81)],4),url=cases[0].control.profile.url;
  const results=[
    {variant:'control',status:'evaluated',profileId:'1',instagramUrl:url,gatePassed:true},
    {variant:'control',status:'evaluated',profileId:1,instagramUrl:'https://instagram.com/ARTIST_81/',gatePassed:false},
    {variant:'control',status:'evaluated',profileId:'2',instagramUrl:url,gatePassed:false},
    {variant:'candidate',status:'evaluated',profileId:'3',instagramUrl:make(3).profile.url,gatePassed:true},
    {variant:'control',status:'held_before_dispatch',profileId:'3',instagramUrl:url},
    {variant:'control',status:'unresolved',profileId:'4',instagramUrl:url},
  ];
  const report=summarizeSavedControls(cases,results);
  assert.equal(report.assignedComparisons,4);
  assert.equal(report.evaluatedComparisons,3);
  assert.equal(report.distinctEvaluatedControlAccounts,1);
  assert.equal(report.distinctEvaluatedTargetArtists,2);
  assert.equal(report.distinctEvaluatedPairs,2);
  assert.equal(report.evaluatedGatePasses,1);
  assert.equal(report.evaluatedDiversityStatus,'insufficient_control_diversity');
  assert.equal(report.accuracyScored,false);
  assert.equal(report.calibratedFalsePositiveRate,null);
});
test('historical repeated-control scopes can be summarized without rewriting archived labels or decisions',()=>{
  const oldControl=control(81),cases=targets(20).map(item=>({...item,control:{
    artist:oldControl.artist.artist,profileId:oldControl.artist.profile_id,profile:oldControl.profile,
  }}));
  const before=JSON.stringify(cases),report=summarizeSavedControls(cases);
  assert.equal(report.targetArtists,20);
  assert.equal(report.assignedComparisons,20);
  assert.equal(report.distinctControlAccounts,1);
  assert.equal(report.reusedComparisons,19);
  assert.equal(report.distinctAccountShortfall,19);
  assert.equal(report.diversityStatus,'insufficient_control_diversity');
  assert.equal(report.independentlySourceReviewedNegativeLabels,0);
  assert.equal(JSON.stringify(cases),before);
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

test('offline preparation persists scarcity reports and preserves frozen input bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fix-rerun-prepare-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const archive=path.join(root,'frozen');await fs.mkdir(archive);
  // Every saved artist becomes a target: no unrelated control remains.
  const pool=targets(3);
  const files={
    'approved-manifest.json':JSON.stringify({artists:pool.map(x=>x.artist)}),
    'results.jsonl':pool.map(x=>JSON.stringify({profileId:x.artist.profile_id,rawResult:{profiles:[x.profile]}})).join('\n'),
    'artist-context-evidence.json':JSON.stringify({packets:pool.map(x=>({
      profileId:x.artist.profile_id,cmArtist:x.artist.cm_artist,platformSnapshots:[],spotifyMetadata:[],tags:[],
    }))}),
  };
  for(const [file,bytes]of Object.entries(files))await fs.writeFile(path.join(archive,file),bytes);
  const auditFile=path.join(root,'audit.json');
  const auditText=JSON.stringify({rows:pool.map(x=>({profile_id:x.artist.profile_id,instagram_link:x.profile.url}))});
  await fs.writeFile(auditFile,auditText);
  const outputDir=path.join(root,'new-scope');
  const report=await prepareSavedFixRerun({directories:[archive],auditFile,outputDir,priorReservedCents:0});
  assert.equal(report.paidCalls,0);
  assert.equal(report.artists,3);
  assert.equal(report.maxCalls,3);
  assert.equal(report.worstCaseReservedUsd,0.06);
  assert.equal(report.controlCoverage.unassignedTargets,3);
  assert.equal(report.controlCoverage.diversityStatus,'insufficient_control_diversity');
  const scope=JSON.parse(await fs.readFile(path.join(outputDir,'prepared-scope.json'),'utf8'));
  assert.deepEqual(scope.controlCoverage,report.controlCoverage);
  assert.deepEqual(scope.manifest.selection.controlCoverage,report.controlCoverage);
  assert.equal(scope.manifest.run_allowed,false);
  assert.equal(scope.manifest.proposed_limits.jev_requests_total,3);
  assert.equal(scope.manifest.proposed_limits.paid_http_requests_total,3);
  assert.ok(scope.cases.every(c=>c.control===null));
  const receipt=JSON.parse(await fs.readFile(path.join(outputDir,'prepared-scope-receipt.json'),'utf8'));
  assert.equal(receipt.sha256,createHash('sha256').update(JSON.stringify(scope)).digest('hex'));
  await assert.rejects(prepareSavedFixRerun({directories:[archive],auditFile,outputDir,priorReservedCents:0}),/EEXIST/);
  for(const [file,bytes]of Object.entries(files))assert.equal(await fs.readFile(path.join(archive,file),'utf8'),bytes);
  assert.equal(await fs.readFile(auditFile,'utf8'),auditText);
  await assert.rejects(fs.stat(path.join(outputDir,'admissions.jsonl')),/ENOENT/);
});
