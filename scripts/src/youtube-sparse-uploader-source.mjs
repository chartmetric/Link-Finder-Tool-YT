// Separate sparse-cohort preparation. Never changes the historical staged runner.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {digest} from './youtube-video-discovery-offline.mjs';
import {buildSavedFallback} from './prepare-youtube-saved-fallback.mjs';
import {approveHundredSearch} from './youtube-hundred-search-plan.mjs';
import {channelCheckBundle,approveChannelCheckBundle} from './youtube-channel-check-bundle.mjs';
import {youtubeSearchPlan} from './youtube-search-plan.mjs';
import {VIDEO_PARENT} from './youtube-video-stage.mjs';

export const SPARSE_SOURCE='youtube-batch-100-staged-2026-11-13';
export const SPARSE_DIRECT='youtube-batch-channel-checks-direct-100-2026-11-13';
export const SPARSE_ID='youtube-batch-uploaders-sparse-100-2026-11-16';
export const json=async file=>JSON.parse(await fs.readFile(file));
export async function assertSourceFiles(files){
  for(const [file,hash] of Object.entries(files))
    assert.equal(digest(await fs.readFile(file)),hash,'Changed source: '+file);
}
// These are machine-generated, fully quoted rows. Reject other CSV dialects.
export function remainingRows(text){
  return text.replace(/^\ufeff/u,'').trimEnd().split(/\r?\n/u).map(line=>{
    assert.match(line,/^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/u,'Invalid remaining-artist CSV');
    return [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/gu)].map(m=>m[1].replaceAll('""','"'));
  });
}
export async function sparseSources(){
  const sourceFiles={};
  const bytes=async file=>{const raw=await fs.readFile(file);sourceFiles[file]=digest(raw);return raw;};
  const read=async file=>JSON.parse(await bytes(file));
  const root='generated-artifacts/'+SPARSE_SOURCE,directRoot='generated-artifacts/'+SPARSE_DIRECT;
  const parent=await read(root+'/plan.json'),approval=await read(root+'/approval.json');
  assert.deepEqual(approveHundredSearch(parent,approval),approval);
  const summary=await read(root+'/summary.json');
  assert.equal(summary.status,'completed');assert.equal(summary.searchCalls,100);
  for(const [file,hash] of Object.entries(parent.runtimeFiles))
    assert.equal(digest(await bytes(root+'/'+file)),hash);
  const direct=await read(directRoot+'/plan.json');
  assert.deepEqual(channelCheckBundle(direct),direct);
  const directApproval=await read(directRoot+'/approval.json');
  assert.deepEqual(approveChannelCheckBundle(direct,directApproval),directApproval);
  assert.equal(direct.sourceBundleId,parent.id);assert.equal(direct.sourceBundleSha256,digest(parent));
  const selected=direct.children.flatMap(c=>c.plan.selections);
  assert.equal(selected.length,55);
  const rows=remainingRows(String(await bytes(directRoot+'/remaining-artists.csv')));
  assert.deepEqual(rows.shift(),['artist','tier','profile_id','cm_artist','pending_video_leads','status']);
  assert.equal(rows.length,45);
  assert.equal(new Set(rows.map(r=>r[2])).size,45);
  const cases=[],cohorts=[];
  for(const child of parent.children){
    const folder='generated-artifacts/'+child.id;
    const proposal=await buildSavedFallback(folder,{includeDirectChannelCases:true});
    const plan=await read(folder+'/plan.json');
    assert.equal(digest(plan),child.planSha256);
    assert.equal(proposal.sourcePlanSha256,child.planSha256);
    for(const [file,hash] of Object.entries(proposal.sourceFiles))
      assert.equal(digest(await bytes(folder+'/'+file)),hash);
    for(const c of proposal.cases){
      const record=await read(folder+'/artists/'+c.profileId+'.json');
      assert.deepEqual(record.searchPlan,youtubeSearchPlan(record.artist));
      assert.equal(record.ownershipAccepted,false);
      const s=selected.find(s=>s.profileId===c.profileId||s.cmArtist===c.cmArtist);
      const row=rows.find(r=>r[2]===c.profileId);
      if(s){
        assert.equal(s.profileId,c.profileId);assert.equal(s.cmArtist,c.cmArtist);
        assert.equal(row,undefined,'Direct selections must not enter fallback');
      }else{
        assert.ok(row);assert.equal(row[0],c.artist);assert.equal(row[1],String(c.tier));
        assert.equal(row[3],c.cmArtist);assert.equal(row[4],String(c.resolutionQueue.length));
      }
      cases.push({...c,sourceId:child.id,directSelected:!!s,
        catalogPacket:plan.packets.find(p=>p.profileId===c.profileId&&p.cmArtist===c.cmArtist),
        sourceArtist:plan.artists.find(a=>a.profile_id===c.profileId)});
    }
    cohorts.push({id:child.id,planSha256:child.planSha256,proposal});
  }
  assert.equal(cases.length,100);
  assert.equal(cases.filter(c=>!c.directSelected&&c.resolutionQueue.length).length,24);
  await assertSourceFiles(sourceFiles);
  return {parent,cohorts,cases,selected,sourceFiles};
}
// Every allocation is retained regardless of return/failure/recovery status.
// Exclude identities independently, not only an identical combined operation key.
export function historicalUploaderConflict(c,history){
  return history.some(h=>h.profile_id===c.profileId||h.cm_artist===c.cmArtist
    ||c.resolutionQueue.some(v=>v.videoId===h.video_id||v.operation.key===h.operation_key));
}
export async function uploaderCoordinatorSnapshot(client){
  const rows=async(sql,args=[]) => (await client.query(sql,args)).rows;
  const snapshot={
    campaign:await rows('SELECT id,status FROM youtube_link_campaigns WHERE id=$1',[VIDEO_PARENT]),
    searches:await rows(`SELECT id,status,reserved_cents FROM youtube_discovery_test_runs
      WHERE id=ANY($1::text[])`,[Array.from({length:5},(_,i)=>`youtube-test-100-staged-2026-11-13-part-${i+1}`)]),
    receipts:await rows(`SELECT run_id,operation_key,profile_id,input_sha256,receipt_sha256,status,http_status
      FROM youtube_bounded_test_admissions WHERE run_id=ANY($1::text[]) AND kind='search'`,
    [Array.from({length:5},(_,i)=>`youtube-test-100-staged-2026-11-13-part-${i+1}`)]),
    history:await rows(`SELECT run_id,operation_key,profile_id,cm_artist,video_id,status,
      input_sha256,receipt_sha256,raw_sha256,http_status FROM youtube_video_stage_admissions`),
    otherUploaderKinds:await rows(`SELECT kind FROM youtube_bounded_test_admissions
      WHERE kind ILIKE '%video%' OR kind ILIKE '%uploader%' UNION ALL
      SELECT kind FROM youtube_link_campaign_admissions WHERE kind ILIKE '%video%' OR kind ILIKE '%uploader%'`),
  };
  // Unknown historical formats must be explicitly reconciled, never ignored.
  assert.equal(snapshot.otherUploaderKinds.length,0,'Unreconciled legacy uploader allocations');
  return snapshot;
}
export async function uploaderIdleBlockers(client){
  const blockers=[];
  if((await client.query('SELECT status FROM youtube_link_campaigns WHERE id=$1',[VIDEO_PARENT])).rows[0]?.status!=='stopped')
    blockers.push({reason:'full_campaign_not_stopped'});
  for(const [table,column] of [
    ['youtube_discovery_test_runs','running'],['youtube_video_stage_runs','running'],
    ['youtube_video_identity_runs','running'],['youtube_bounded_test_admissions','admitted'],
    ['youtube_video_stage_admissions','admitted'],['youtube_video_identity_admissions','admitted'],
    ['youtube_link_campaign_admissions','admitted'],
  ]){
    const count=(await client.query(`SELECT count(*)::int n FROM ${table} WHERE status=$1`,[column])).rows[0].n;
    if(count)blockers.push({reason:'active_or_uncertain_work',table,status:column,count});
  }
  return blockers;
}
export async function assertUploaderIdle(client){
  assert.deepEqual(await uploaderIdleBlockers(client),[],'Active or uncertain YouTube work blocks execution');
}
export async function validateSparseReceipts(sources,snapshot){
  assert.equal(snapshot.searches.length,5);assert.equal(snapshot.receipts.length,100);
  for(const cohort of sources.cohorts){
    const run=snapshot.searches.find(r=>r.id===cohort.id);
    assert.equal(run?.status,'completed');assert.equal(Number(run.reserved_cents),40);
    assert.equal(snapshot.receipts.filter(r=>r.run_id===cohort.id).length,20);
  }
  // Read every original receipt, including the 55 direct artists and empty searches.
  const {archivedSearchReceiptName}=await import('./youtube-video-stage.mjs');
  for(const c of sources.cases){
    const receipt=await json(`generated-artifacts/${c.sourceId}/receipts/${archivedSearchReceiptName(c.profileId)}`);
    const admissions=snapshot.receipts.filter(r=>r.run_id===c.sourceId&&r.profile_id===c.profileId
      &&r.operation_key===receipt.operationKey);
    assert.equal(admissions.length,1);
    const a=admissions[0];
    assert.equal(a.status,'returned');assert.equal(a.http_status,200);
    assert.equal(a.input_sha256,receipt.inputSha256);assert.equal(a.receipt_sha256,digest(receipt));
  }
}
