import test from 'node:test';
import assert from 'node:assert/strict';
import {excludePreviouslySubmitted,gateFutureSubmission,confirmedSubmissionRows,
  submissionRunType,newSubmissionRunId} from './youtube-submission-ledger.mjs';
const channel=n=>'UC'+String(n).padStart(22,'0');
const row=(profile,id=profile)=>({profile_id:profile,cm_artist:profile,channel_id:channel(id),
  channel_url:'https://www.youtube.com/channel/'+channel(id),run_id:'20261118T000000Z_final_submit_batch2_test'});
test('profile match excludes even when channel is different',()=>{
  const result=excludePreviouslySubmitted([row(1,2)],[row(1,1)]);
  assert.equal(result.eligible.length,0);
  assert.deepEqual(result.excluded[0].reasons,['profile_already_submitted']);
});
test('channel match excludes even when artist/profile is different',()=>{
  const result=excludePreviouslySubmitted([row(2,1)],[row(1,1)]);
  assert.equal(result.eligible.length,0);
  assert.deepEqual(result.excluded[0].reasons,['channel_already_submitted']);
});
test('duplicates are removed within the pending batch too',()=>{
  const result=excludePreviouslySubmitted([row(1),row(1,2),row(2,1),row(3)],[]);
  assert.deepEqual(result.eligible.map(r=>r.profile_id),[1,3]);
  assert.equal(result.excluded.length,2);
});
test('future gate reads the current ledger and validates batch-specific type',async()=>{
  let calls=0;
  const query=async sql=>{calls++;assert.match(sql,/youtube_link_submissions/);return [row(1)];};
  const result=await gateFutureSubmission({rows:[row(1),row(2)],batchNumber:2,query});
  assert.equal(calls,1);assert.equal(result.eligible.length,1);
  await assert.rejects(gateFutureSubmission({rows:[row(2)],batchNumber:3,query}),/Wrong run type/);
});
test('future gate excludes variant-inflated highs before any result insertion',async()=>{
  const result=await gateFutureSubmission({batchNumber:2,query:async()=>[],rows:[
    {...row(1),confidence:'high',evidence_level:'titles',matched_titles:['Home','Home (Live)','Home (Remix)']},
    {...row(2),confidence:'high',evidence_level:'titles',matched_titles:['One','Two','Three']},
  ]});
  assert.deepEqual(result.eligible.map(r=>r.profile_id),[2]);
  assert.deepEqual(result.excluded[0].reasons,['insufficient_distinct_base_songs']);
});
test('recording is impossible without explicit DE-send confirmation',()=>{
  assert.throws(()=>confirmedSubmissionRows({
    rows:[row(1)],batchNumber:2,submittedAt:'2026-11-18 17:22:19.728113',
  }),/confirms it was sent/);
});
test('batch numbers have separate types and new runs are unique',()=>{
  assert.equal(submissionRunType(1),'final_submit');
  assert.equal(submissionRunType(2),'final_submit_batch2');
  assert.equal(submissionRunType(3),'final_submit_batch3');
  assert.notEqual(newSubmissionRunId(3),newSubmissionRunId(3));
  const recorded=confirmedSubmissionRows({rows:[row(1)],batchNumber:2,
    submittedAt:'2026-11-18 17:22:19.728113',confirmedSentToDE:true,confirmationNote:'User explicitly confirmed sent'});
  assert.equal(recorded[0].batch,'batch_2');
});
