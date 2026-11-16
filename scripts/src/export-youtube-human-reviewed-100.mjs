// Separate human feedback from immutable captures and automated decisions.
// Local export only: no database, provider calls or catalog writes.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';

assert.deepEqual(process.argv.slice(2),['--export-review']);
const source='generated-artifacts/youtube-channel-results-100-completed-2026-11-16/results.json';
const output='generated-artifacts/youtube-channel-results-100-user-reviewed-2026-11-16';
const bytes=await fs.readFile(source),saved=JSON.parse(bytes);
assert.equal(saved.results.length,52);
assert.equal(saved.results.filter(r=>r.status==='metadata_captured_ownership_unverified').length,51);
const christian=saved.results.find(r=>r.profileId==='3559088'&&r.cmArtist==='11830222'
  &&r.youtubeUrl==='https://www.youtube.com/channel/UCPbooXW8aKJgQmo65dHjo-A');
assert.ok(christian?.savedHeld);
assert.equal(new Set(saved.results.map(r=>r.profileId+':'+r.youtubeUrl)).size,52);
const reviewedAt=new Date().toISOString();
const results=saved.results.map(r=>({
  ...r,
  userReview:{
    source:'user_review',recordedAt:reviewedAt,status:'looks_correct',
    statement:r===christian?'Christian Liguori channel looks good':
      'Other channels in the 51 captured YouTube channels document also look good',
    catalogConflictResolved:false,
    catalogWriteAuthorized:false,
  },
}));
assert.ok(results.every(r=>r.ownershipAccepted===false&&r.importEligible===false));
const summary={
  reviewedChannels:52,topicChannels:results.filter(r=>r.channelType==='topic').length,
  originalHeldConflicts:results.filter(r=>r.savedHeld).length,
  status:'user_reviewed_looks_correct_not_import_authorized',
  paidCalls:0,catalogWrites:0,automatedDecisionsChanged:0,
};
const cell=v=>{
  let s=String(v??'');if(/^[=+\-@\t\r\n]/u.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
const headers=['artist','starting_tier','tier_at_approval','profile_id','cm_artist','youtube_url',
  'channel_name','channel_type','channel_type_label','user_review','original_capture_status',
  'catalog_conflict_still_recorded','catalog_write_authorized','result_json'];
const rows=results.map(r=>[r.artist,r.startingTier,r.tierAtApproval,r.profileId,r.cmArtist,r.youtubeUrl,
  r.channelName,r.channelType,r.channelTypeLabel,r.userReview.status,r.status,
  r.savedHeld||r.conflicts.length>0,false,JSON.stringify(r)]);
await fs.mkdir(output);
await fs.writeFile(output+'/youtube-channels-user-reviewed.csv',
  '\ufeff'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n'),{flag:'wx'});
await fs.writeFile(output+'/review.json',JSON.stringify({
  source,sourceSha256:digest(bytes),reviewedAt,summary,results,
},null,2),{flag:'wx'});
assert.equal(digest(await fs.readFile(source)),digest(bytes));
console.log(JSON.stringify({output,...summary}));
