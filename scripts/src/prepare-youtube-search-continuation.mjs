// Reads both databases and saved receipts, writes only a new local proposal.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {digest} from './youtube-video-discovery-offline.mjs';
import {evidenceDigest} from './youtube-ownership-policy.mjs';
import {untouchedSearchScope,searchRecordFromReceipt,searchContinuationPlan} from './youtube-search-continuation.mjs';
import {readSearchSourceLedger,assertSearchContinuationReady} from './youtube-search-continuation-live.mjs';
import {checkContinuationEligibility} from './run-youtube-search-continuation.mjs';
import {connectSavedBatchPool} from './instagram-saved-batch-gate.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
import {freezeLocalModules} from './seal-youtube-campaign-runtime.mjs';
assert.deepEqual(process.argv.slice(2),['--prepare-only']);
const sourceRoot='generated-artifacts/youtube-batch-500-staged-2026-11-16';
const id='youtube-search-continuation-410-ready-2026-11-16',root='generated-artifacts/'+id;
try{await fs.lstat(root);assert.fail('Fresh proposal required; never overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
const sourceFiles={};
const bytes=async file=>{
  assert.equal(await fs.realpath(file),path.resolve(file),'Symlink source');
  const b=await fs.readFile(file);sourceFiles[file]=digest(b);return b;
};
const read=async file=>JSON.parse(await bytes(file));
const plan=await read(sourceRoot+'/plan.json'),approval=await read(sourceRoot+'/approval.json');
await bytes(sourceRoot+'/run-started.json');
const childApprovals=[],leafApprovals=[];
async function verifyFiles(folder,p){
  for(const [file,sha] of Object.entries({...p.evidenceFiles,...p.runtimeFiles}))
    assert.equal(digest(await bytes(folder+'/'+file)),sha);
}
await verifyFiles(sourceRoot,plan);
for(const child of plan.children){
  const folder='generated-artifacts/'+child.id,p=await read(folder+'/plan.json');
  assert.equal(digest(p),child.planSha256);await verifyFiles(folder,p);
  childApprovals.push(await read(folder+'/approval.json'));
  try{await bytes(folder+'/run-started.json');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const leaf of p.children){
    const folder='generated-artifacts/'+leaf.id,p=await read(folder+'/plan.json');
    assert.equal(digest(p),leaf.planSha256);await verifyFiles(folder,p);
    leafApprovals.push(await read(folder+'/approval.json'));
  }
}
const pool=await connectSavedBatchPool();let c,source,scope;
try{
  c=await pool.connect();await c.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  source={plan,approval,childApprovals,leafApprovals,...await readSearchSourceLedger(c,plan)};
  scope=untouchedSearchScope(source);
  assert.equal(scope.paid.length,90);assert.equal(scope.pending.length,410);
  assert.equal(scope.unprocessedSavedResponses,1);assert.equal(scope.priorReservedCents,180);
  assert.equal(scope.maximumAdditionalCents,820);assert.equal(scope.originalMaximumCents,1000);
  // Build the exact group layout for the unchanged live guards.
  const provisional=searchContinuationPlan({id,preparedAt:new Date().toISOString(),
    evidenceFiles:{'evidence/preflight.json':digest('preflight')},
    runtimeFiles:{'runtime/preflight.mjs':digest('preflight')}},source);
  for(const group of provisional.groups)await assertSearchContinuationReady(c,source,group);
  const eligibility=await checkContinuationEligibility(scope.pending.map(p=>p.artist));
  const recovered=[];
  for(const entry of scope.paid){
    const receiptPath='generated-artifacts/'+entry.sourceRunId+'/receipts/'+archivedSearchReceiptName(entry.operation.profileId);
    const raw=await bytes(receiptPath),receipt=JSON.parse(raw);
    assert.equal(evidenceDigest(receipt),entry.admission.receipt_sha256);
    const record=searchRecordFromReceipt({...entry,receipt,receiptPath,receiptBytes:raw});
    const old=source.results.find(r=>r.run_id===entry.sourceRunId&&r.profile_id===entry.operation.profileId);
    const oldPath='generated-artifacts/'+entry.sourceRunId+'/artists/'+entry.operation.profileId+'.json';
    if(old.status==='search_returned'){
      assert.deepEqual(await read(oldPath),record);
      assert.deepEqual(old.candidates_json,record.candidates);
    }else{
      try{await fs.lstat(oldPath);assert.fail('Unexpected partially processed local file');}
      catch(e){if(e.code!=='ENOENT')throw e;}
      recovered.push({sourceRunId:entry.sourceRunId,receiptPath,receiptSha256:entry.admission.receipt_sha256,
        rawFileSha256:digest(raw),originalLedgerStatus:old.status,
        status:'processed_from_saved_response_locally_only',record,providerRequests:0,ledgerWrites:0});
    }
  }
  assert.equal(recovered.length,1);
  await c.query('COMMIT');
  for(const [file,sha] of Object.entries(sourceFiles))assert.equal(digest(await fs.readFile(file)),sha);
  await fs.mkdir(root);await fs.mkdir(root+'/evidence');await fs.mkdir(root+'/groups');
  const save=(name,value)=>fs.writeFile(root+'/'+name,typeof value==='string'?value:JSON.stringify(value,null,2),{flag:'wx'});
  const evidenceFiles={};
  const evidence=async(name,value)=>{
    await save(name,value);evidenceFiles[name]=digest(await fs.readFile(root+'/'+name));
  };
  await evidence('evidence/source.json',source);
  await evidence('evidence/source-files.json',sourceFiles);
  await evidence('evidence/current-eligibility.json',{checkedAt:new Date().toISOString(),rows:eligibility});
  await evidence('evidence/recovered-search.json',recovered[0]);
  const runtimeFiles={};
  for(const file of await freezeLocalModules(path.join(path.dirname(fileURLToPath(import.meta.url)),
    'run-youtube-search-continuation.mjs'),root+'/runtime'))
    runtimeFiles['runtime/'+path.basename(file)]=digest(await fs.readFile(file));
  const final=searchContinuationPlan({id,preparedAt:new Date().toISOString(),evidenceFiles,runtimeFiles},source);
  await save('plan.json',final);
  const cell=v=>{let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  await save('remaining-410-artists.csv','\ufeff'+[
    ['artist','tier','profile_id','cm_artist','exact_search_query','maximum_search_cost_usd','status'],
    ...scope.pending.map(p=>[p.artist.artist,p.artist.tier,p.operation.profileId,p.operation.cmArtist,
      p.operation.request.body.q,'0.02','Untouched — new approval required']),
  ].map(r=>r.map(cell).join(',')).join('\r\n'));
  const summary={id,status:'sealed_not_approved_not_started',planSha256:digest(final),
    untouchedSearches:410,maximumAdditionalCents:820,priorReservedCents:180,combinedMaximumCents:1000,
    sourceResponsesPreserved:90,previouslyProcessed:89,savedResponsesProcessedOffline:1,
    recoveredArtist:recovered[0].record.artist.name,groups:final.groups.map(g=>g.operations.length),
    paidCalls:0,ledgerWrites:0,catalogWrites:0,oldFilesChanged:0,
    downstreamChecksRequireSeparateApproval:true};
  await save('preparation.json',summary);console.log(JSON.stringify(summary));
}catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c?.release();await pool.end();}
