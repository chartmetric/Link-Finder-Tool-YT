import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {select} from './instagram-artist-metadata-overlay.mjs';

export const SUBMISSIONS_TABLE='poc_new_verticals.youtube_link_submissions';
export const SUBMISSION_COLUMNS=['profile_id','cm_artist','channel_id','channel_url','batch','run_id','submitted_at'];
export const CREATE_SUBMISSIONS_SQL=`CREATE TABLE IF NOT EXISTS ${SUBMISSIONS_TABLE} (
  profile_id UInt32,
  cm_artist UInt32,
  channel_id String,
  channel_url String,
  batch String,
  run_id String,
  submitted_at DateTime64(6, 'UTC')
) ENGINE = MergeTree ORDER BY (profile_id, channel_id, batch, run_id)`;

export function submissionRunType(batchNumber){
  assert.ok(Number.isInteger(batchNumber)&&batchNumber>=1,'A positive batch number is required');
  return batchNumber===1?'final_submit':'final_submit_batch'+batchNumber;
}
export function newSubmissionRunId(batchNumber){
  return new Date().toISOString().replace(/[-:.]/g,'')+'_'+submissionRunType(batchNumber)+'_'+randomUUID();
}
export async function readSubmissionLedger({query=select}={}){
  return query(`SELECT ${SUBMISSION_COLUMNS.join(',')} FROM ${SUBMISSIONS_TABLE} ORDER BY profile_id,channel_id,batch,run_id`);
}
export function excludePreviouslySubmitted(rows,ledgerRows){
  const profiles=new Set(ledgerRows.map(r=>String(r.profile_id)));
  const channels=new Set(ledgerRows.map(r=>r.channel_id));
  const batchProfiles=new Set(),batchChannels=new Set(),eligible=[],excluded=[];
  for(const row of rows){
    const profile=String(row.profile_id);
    assert.match(row.channel_id,/^UC[A-Za-z0-9_-]{22}$/);
    const reasons=[];
    if(profiles.has(profile))reasons.push('profile_already_submitted');
    if(channels.has(row.channel_id))reasons.push('channel_already_submitted');
    if(!reasons.length&&batchProfiles.has(profile))reasons.push('duplicate_profile_within_batch');
    if(!reasons.length&&batchChannels.has(row.channel_id))reasons.push('duplicate_channel_within_batch');
    if(reasons.length){excluded.push({row,reasons});continue;}
    eligible.push(row);batchProfiles.add(profile);batchChannels.add(row.channel_id);
  }
  assert.equal(eligible.length+excluded.length,rows.length);
  return {eligible,excluded};
}
export async function gateFutureSubmission({rows,batchNumber,query=select}){
  assert.ok(batchNumber>=2,'The initial backfill is separate from future submission preparation');
  const type=submissionRunType(batchNumber);
  assert.ok(rows.every(r=>r.run_id.includes('_'+type+'_')),'Wrong run type for this submission batch');
  const ledger=await readSubmissionLedger({query});
  const result=excludePreviouslySubmitted(rows,ledger);
  return {...result,run_type:type,ledger_rows:ledger.length};
}
export function confirmedSubmissionRows({rows,batchNumber,submittedAt,confirmedSentToDE=false,confirmationNote}){
  assert.equal(confirmedSentToDE,true,'Do not record a batch until the user confirms it was sent to DE');
  assert.ok(typeof confirmationNote==='string'&&confirmationNote.trim(),
    'Keep the explicit user confirmation with the append-only write admission');
  const type=submissionRunType(batchNumber);
  assert.ok(rows.every(r=>r.run_id.includes('_'+type+'_')));
  assert.match(submittedAt,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}$/);
  return rows.map(r=>({
    profile_id:Number(r.profile_id),cm_artist:Number(r.cm_artist),
    channel_id:r.channel_id,channel_url:r.channel_url??r.youtube_url,
    batch:'batch_'+batchNumber,run_id:r.run_id,submitted_at:submittedAt,
  }));
}
