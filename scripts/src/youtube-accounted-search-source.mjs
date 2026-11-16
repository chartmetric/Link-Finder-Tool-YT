// Read-only reconciliation of an honestly stopped original run plus its
// separately approved, completed continuation. Never repairs old ledger rows.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {approveSearchContinuation,untouchedSearchScope,searchRecordFromReceipt} from './youtube-search-continuation.mjs';
import {readSearchSourceLedger} from './youtube-search-continuation-live.mjs';
import {archivedSearchReceiptName} from './youtube-video-stage.mjs';
const read=async f=>JSON.parse(await fs.readFile(f));
export async function accountedSearchLedger(c,source,continuation){
  const original=await readSearchSourceLedger(c,source.plan),ids=continuation.groups.map(g=>g.id);
  const runs=(await c.query(`SELECT id,status,scope_sha256,cap_cents,reserved_cents FROM youtube_discovery_test_runs
    WHERE id=ANY($1::text[]) ORDER BY id`,[ids])).rows;
  const admissions=(await c.query(`SELECT run_id,operation_key,profile_id,kind,status,http_status,input_sha256,
    receipt_sha256,reserved_cents FROM youtube_bounded_test_admissions WHERE run_id=ANY($1::text[])
    ORDER BY run_id,operation_key`,[ids])).rows;
  const results=(await c.query(`SELECT run_id,profile_id,cm_artist,status,candidates_json,metadata_json
    FROM youtube_discovery_test_results WHERE run_id=ANY($1::text[]) ORDER BY run_id,profile_id`,[ids])).rows;
  return {original,runs,admissions,results};
}
export async function auditAccountedSearches(c,{continuationRoot,exportRoot}){
  const sourceFiles={};
  const bytes=async f=>{
    assert.equal(await fs.realpath(f),path.resolve(f),'Symlink evidence is not allowed');
    const b=await fs.readFile(f);sourceFiles[f]=digest(b);return b;
  };
  const json=async f=>JSON.parse(await bytes(f));
  const continuation=await json(continuationRoot+'/plan.json');
  const approval=await json(continuationRoot+'/approval.json');
  const source=await json(continuationRoot+'/evidence/source.json');
  assert.deepEqual(approveSearchContinuation(continuation,source,approval),approval);
  assert.equal((await json(continuationRoot+'/summary.json')).status,'completed');
  for(const [file,sha] of Object.entries({...continuation.evidenceFiles,...continuation.runtimeFiles}))
    assert.equal(digest(await bytes(continuationRoot+'/'+file)),sha);
  const manifest=await json(continuationRoot+'/evidence/source-files.json');
  for(const [file,sha] of Object.entries(manifest)){
    assert.match(file,/^generated-artifacts\/[A-Za-z0-9_./-]+$/);assert.ok(!file.split('/').includes('..'));
    assert.equal(digest(await bytes(file)),sha);
  }
  const exported=await json(exportRoot+'/results.json'),ledger=await accountedSearchLedger(c,source,continuation);
  for(const key of ['runs','admissions','results'])assert.deepEqual(ledger.original[key],source[key]);
  const scope=untouchedSearchScope(source);
  assert.equal(scope.paid.length,90);assert.equal(ledger.runs.length,continuation.groups.length);
  assert.equal(ledger.admissions.length,410);assert.equal(ledger.results.length,410);
  const recovered=await json(continuationRoot+'/evidence/recovered-search.json'),records=[];
  const verify=async(entry,runId,admission,expected)=>{
    const {artist,packet,operation}=entry;
    assert.equal(admission.run_id,runId);assert.equal(admission.operation_key,operation.key);
    assert.equal(admission.profile_id,operation.profileId);assert.equal(admission.kind,'search');
    assert.equal(admission.reserved_cents,2);assert.equal(admission.status,'returned');
    assert.equal(admission.http_status,200);assert.equal(admission.input_sha256,operation.inputSha256);
    const receiptPath='generated-artifacts/'+runId+'/receipts/'+archivedSearchReceiptName(operation.profileId);
    const raw=await bytes(receiptPath),receipt=JSON.parse(raw);
    assert.equal(digest(receipt),admission.receipt_sha256);
    const record=searchRecordFromReceipt({artist,packet,operation,receipt,receiptPath,receiptBytes:raw});
    assert.deepEqual(record,expected);
    const saved=exported.results.find(r=>r.sourceRunId===runId&&r.record.artist.profileId===operation.profileId);
    assert.ok(saved);assert.deepEqual(saved.record,record);assert.equal(saved.sourceReceipt,receiptPath);
    assert.equal(saved.receiptSha256,admission.receipt_sha256);
    const isRecovery=runId===recovered.sourceRunId&&operation.profileId===recovered.record.artist.profileId;
    assert.equal(Boolean(saved.processedOffline),isRecovery);
    records.push(saved);
  };
  for(const entry of scope.paid){
    const isRecovery=entry.sourceRunId===recovered.sourceRunId&&entry.operation.profileId===recovered.record.artist.profileId;
    await verify(entry,entry.sourceRunId,entry.admission,isRecovery?recovered.record:
      await json('generated-artifacts/'+entry.sourceRunId+'/artists/'+entry.operation.profileId+'.json'));
  }
  for(const group of continuation.groups){
    const run=ledger.runs.find(r=>r.id===group.id);assert.ok(run);assert.equal(run.status,'completed');
    assert.equal(run.scope_sha256,group.scopeSha256);assert.equal(run.cap_cents,group.maximumSpendCents);
    assert.equal(run.reserved_cents,group.maximumSpendCents);
    for(const operation of group.operations){
      const admission=ledger.admissions.find(a=>a.run_id===group.id&&a.operation_key===operation.key);assert.ok(admission);
      const row=ledger.results.find(r=>r.run_id===group.id&&r.profile_id===operation.profileId);assert.ok(row);
      assert.equal(row.cm_artist,operation.cmArtist);assert.equal(row.status,'search_returned');
      assert.equal(row.metadata_json.approvalSha256,digest(approval));
      const record=await json('generated-artifacts/'+group.id+'/artists/'+operation.profileId+'.json');
      assert.deepEqual(row.candidates_json,record.candidates);
      await verify({artist:group.artists.find(a=>a.profile_id===operation.profileId),
        packet:group.packets.find(p=>p.profileId===operation.profileId),operation},group.id,admission,record);
    }
  }
  assert.equal(exported.results.length,500);assert.equal(records.length,500);
  for(const key of ['profileId','cmArtist'])assert.equal(new Set(records.map(r=>r.record.artist[key])).size,500);
  assert.equal(scope.priorReservedCents+ledger.runs.reduce((n,r)=>n+r.reserved_cents,0),1000);
  return {records,ledger,source,continuation,sourceFiles};
}
export async function assertAccountedLedger(c,root){
  const snapshot=await read(root+'/source-ledger.json');
  const source=await read(snapshot.continuationRoot+'/evidence/source.json');
  const continuation=await read(snapshot.continuationRoot+'/plan.json');
  assert.deepEqual(await accountedSearchLedger(c,source,continuation),snapshot.ledger,'Source search accounting changed');
}
