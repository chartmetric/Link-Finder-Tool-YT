import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {compareSavedControls,loadSavedControlReport,renderSavedControlMarkdown,savedControlReportCli} from './instagram-saved-control-report.mjs';
import {summarizeSavedControls} from './instagram-saved-fix-rerun.mjs';

test.beforeEach(t=>t.mock.method(globalThis,'fetch',()=>{throw Error('Network forbidden');}));
const url=handle=>`https://www.instagram.com/${handle}/`;
const c=(id,handle)=>({artist:{profile_id:id},control:handle?{profile:{url:url(handle)}}:null});
const r=(id,handle,status='evaluated',extra={})=>({variant:'control',status,profileId:id,instagramUrl:url(handle),...extra});
const run=(runId,cases,results)=>({runId,scope:{cases},summary:results===undefined?null:{results}});

test('overlapping, disjoint and identical runs use unions, not summed independent coverage',()=>{
  const inputs=[
    run('a',[c(1,'alpha'),c(2,'beta')],[r(1,'alpha'),r(2,'beta')]),
    run('b',[c(' 1 ','ALPHA'),c(3,'gamma')],[r('1','ALPHA'),r(3,'gamma')]),
    run('copy',[c(1,'alpha'),c(2,'beta')],[r(1,'alpha'),r(2,'beta')]),
    run('disjoint',[c(4,'delta')],[r(4,'delta')]),
  ];
  inputs[1].scope.cases[0].control.profile.url='https://m.instagram.com/ALPHA/?utm_source=x#bio';
  inputs[1].summary.results[0].instagramUrl='https://instagram.com/ALPHA?from=saved';
  const before=JSON.stringify(inputs),report=compareSavedControls(inputs);
  assert.equal(JSON.stringify(inputs),before);
  for(const phase of ['planned','evaluated']){
    assert.equal(report.combined[phase].comparisons,7);
    assert.equal(report.combined[phase].distinctTargets,4);
    assert.equal(report.combined[phase].distinctControlAccounts,4);
    assert.equal(report.combined[phase].distinctPairs,4);
    assert.equal(report.combined[phase].sumPerRunDistinctControlAccounts,7);
    assert.equal(report.combined[phase].controlAccountsSharedAcrossRuns,2);
    assert.equal(report.overlaps[0][phase].distinctControlAccounts,1);
    assert.deepEqual(report.overlaps[0][phase].accountUrls,[url('alpha')]);
    assert.equal(report.overlaps[1][phase].distinctPairs,2);
    assert.equal(report.overlaps[2][phase].distinctControlAccounts,0);
  }
  assert.equal(report.accuracyScored,false);
  assert.equal(report.ownershipLabelsAssigned,0);
  assert.equal(report.independentlySourceReviewedNegativeLabels,0);
  assert.equal(report.calibratedFalsePositiveRate,null);
});

test('legacy reused controls, duplicates, missing and partial evaluations retain counting conventions',()=>{
  const cases=[c(1,'shared'),c(2,'shared'),c(3,'shared'),c(4,null)];
  const results=[r(1,'shared', 'evaluated',{gatePassed:true}),r('1','SHARED'),
    r(2,'shared','held_before_dispatch'),r(3,'shared','unresolved'),
    {...r(4,'candidate'),variant:'candidate'}];
  const report=compareSavedControls([run('legacy',cases,results),run('not-started',cases)]);
  const a=report.runs[0],legacy=summarizeSavedControls(cases,results);
  assert.equal(a.targetArtists,legacy.targetArtists);
  assert.equal(a.planned.comparisons,legacy.assignedComparisons);
  assert.equal(a.planned.distinctControlAccounts,legacy.distinctControlAccounts);
  assert.equal(a.planned.reusedAccountComparisons,legacy.reusedComparisons);
  assert.equal(a.evaluated.comparisons,legacy.evaluatedComparisons);
  assert.equal(a.evaluated.distinctPairs,legacy.distinctEvaluatedPairs);
  assert.equal(a.evaluated.distinctTargets,legacy.distinctEvaluatedTargetArtists);
  assert.equal(a.evaluated.distinctControlAccounts,legacy.distinctEvaluatedControlAccounts);
  assert.equal(a.evaluated.gatePassObservations,1);
  assert.equal(a.unassignedComparisons,1);
  assert.deepEqual(a.unassignedTargets,['4']);
  assert.equal(a.evaluated.repeatedPairComparisons,1);
  assert.equal(a.evaluated.diversityStatus,'insufficient_control_diversity');
  assert.equal(report.overlaps[0].planned.distinctControlAccounts,1);
  assert.equal(report.overlaps[0].evaluated.distinctControlAccounts,0);
  assert.equal(report.runs[1].evaluated.diversityStatus,'not_evaluated');
  assert.deepEqual(report.combined.runsMissingSummary,['not-started']);
  assert.match(renderSavedControlMarkdown(report),/not false positives/);
});

test('empty and absent controls, duplicate scope rows and unplanned evaluations are explicit',()=>{
  const report=compareSavedControls([run('empty',[],[]),
    run('absent',[c(1,null),c(2,null)],[]),
    run('duplicates',[c(1,'one'),c('1','one')],[r(9,'other')])]);
  assert.equal(report.runs[0].planned.diversityStatus,'insufficient_control_diversity');
  assert.equal(report.runs[1].unassignedComparisons,2);
  assert.equal(report.runs[2].planned.distinctPairs,1);
  assert.equal(report.runs[2].planned.repeatedPairComparisons,1);
  assert.equal(report.runs[2].evaluated.unplannedPairObservations,1);
  assert.equal(report.runs[2].evaluated.diversityStatus,'insufficient_control_diversity');
  assert.equal(report.combined.evaluated.distinctTargets,1);
});

test('one shared account with different targets is account overlap but not pair overlap',()=>{
  const report=compareSavedControls([
    run('first',[c(1,'shared')],[r(1,'shared')]),
    run('second',[c(2,'SHARED')],[r(2,'shared','unresolved')]),
  ]);
  assert.equal(report.overlaps[0].planned.distinctControlAccounts,1);
  assert.equal(report.overlaps[0].planned.distinctTargets,0);
  assert.equal(report.overlaps[0].planned.distinctPairs,0);
  assert.equal(report.overlaps[0].evaluated.distinctControlAccounts,0);
  assert.equal(report.combined.planned.distinctPairs,2);
  assert.equal(report.combined.planned.distinctControlAccounts,1);
  assert.equal(report.combined.evaluated.distinctPairs,1);
});

test('source-reviewed labels and model verdicts never become synthetic ownership labels or accuracy',()=>{
  const input=run('labeled',[{...c(1,'one'),ownershipLabel:'negative'}],
    [r(1,'one','evaluated',{ownershipLabel:'negative',controlKind:'reviewed',decision:{verdict:'mismatch'}})]);
  const report=compareSavedControls([input]);
  assert.equal(report.ownershipLabelsAssigned,0);
  assert.equal(report.independentlySourceReviewedNegativeLabels,0);
  assert.equal(report.accuracyScored,false);
  assert.ok(!JSON.stringify(report).includes('"negative"'));
});

test('malformed inputs fail explicitly rather than counting unknown identities',()=>{
  assert.throws(()=>compareSavedControls([]),/at least one/);
  assert.throws(()=>compareSavedControls([run('a',[]),run('a',[])]),/unique/);
  assert.throws(()=>compareSavedControls([{runId:'a',scope:{}}]),/cases/);
  assert.throws(()=>compareSavedControls([{...run('a',[]),summary:{}}]),/results/);
  assert.throws(()=>compareSavedControls([run('a',[c('',null)])]),/profile ID/);
  assert.throws(()=>compareSavedControls([run('a',[c(1,'p')])]),/Instagram/);
  assert.throws(()=>compareSavedControls([run('a',[],[r(null,'a')])]),/profile ID/);
  assert.throws(()=>compareSavedControls([run('a',[],[r(1,'p')])]),/Instagram/);
});

test('CLI reads only frozen JSON, preserves all bytes, refuses duplicate sources and exclusive outputs',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'saved-control-report-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'frozen');await fs.mkdir(source);
  const files={
    'prepared-scope.json':JSON.stringify({cases:[c(1,'shared'),c(2,'shared')]}),
    'summary.json':JSON.stringify({results:[r(1,'shared')]}),
    'prepared-scope-receipt.json':'frozen receipt\n','responses.jsonl':'frozen responses\n',
  };
  for(const [name,bytes] of Object.entries(files))await fs.writeFile(path.join(source,name),bytes);
  const output=path.join(root,'report');
  const report=await savedControlReportCli([source,'--output',output]);
  assert.equal(report.runs[0].planned.distinctControlAccounts,1);
  assert.match(report.runs[0].source.preparedScopeSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,'report.json'),'utf8')),JSON.parse(JSON.stringify(report)));
  assert.match(await fs.readFile(path.join(output,'report.md'),'utf8'),/Only one run/);
  await assert.rejects(savedControlReportCli([source,'--output',output]),/EEXIST/);
  await assert.rejects(savedControlReportCli([source,'--output',path.join(source,'new-report')]),/outside/);
  const alias=path.join(root,'alias');await fs.symlink(source,alias);
  await assert.rejects(loadSavedControlReport([source,alias]),/Duplicate/);
  await assert.rejects(savedControlReportCli([source,'--run-approved']),/Unknown/);
  for(const [name,bytes] of Object.entries(files))assert.equal(await fs.readFile(path.join(source,name),'utf8'),bytes);
  assert.deepEqual((await fs.readdir(source)).sort(),Object.keys(files).sort());
});

test('missing summaries stay unknown; malformed summaries never silently become missing',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'saved-control-missing-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'prepared-scope.json'),JSON.stringify({cases:[c(1,null)]}));
  const report=await loadSavedControlReport([root]);
  assert.equal(report.runs[0].summaryState,'missing_not_evidence_of_no_calls');
  await fs.writeFile(path.join(root,'summary.json'),'not json');
  await assert.rejects(loadSavedControlReport([root]),SyntaxError);
});
