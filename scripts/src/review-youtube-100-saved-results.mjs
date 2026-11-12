// Offline audit only: imports no providers, database clients, or campaign executors.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [sourceArg,outputArg]=process.argv.slice(2);
assert.ok(sourceArg&&outputArg,'Supply source archive and separate output directory');
const source=path.resolve(sourceArg),output=path.resolve(outputArg);
assert.ok(output!==source&&!output.startsWith(source+path.sep),'Never write inside the paid archive');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(source+'/'+file,'utf8'));
const plan=await read('plan.json'),approval=await read('approval.json'),original=await read('summary.json');
assert.equal(hash(plan),approval.planSha256);
assert.equal(hash(approval.artists),approval.scopeSha256);
assert.equal(original.status,'completed');
assert.equal(approval.artists.length,100);
for(const [file,digest] of Object.entries(approval.runtimeFiles))
  assert.equal(hash(await fs.readFile(source+'/runtime/'+file,'utf8')),digest);
const packets=await read('supplemental-catalog/packets.json');
assert.equal(hash(packets),approval.catalogEvidenceSha256);
const receipts=new Map(),searches=new Map(),models=new Map();
for(const file of await fs.readdir(source+'/receipts')){
  const receipt=await read('receipts/'+file);
  assert.equal(file,hash(receipt.operationKey)+'.json');
  assert.equal(hash(receipt.request),receipt.inputSha256);
  assert.equal(receipt.status,200);
  const input=await read('inputs/'+file);
  assert.equal(input.key,receipt.operationKey);
  assert.equal(input.inputSha256,receipt.inputSha256);
  assert.equal(hash(input.request),receipt.inputSha256);
  receipts.set(hash(receipt),receipt);
  if(receipt.kind==='search')searches.set(input.profileId,receipt);
  if(receipt.kind==='model')models.set(receipt.inputSha256,receipt);
}
assert.equal(searches.size,100);
assert.equal(receipts.size,original.admissions.reduce((n,r)=>n+r.calls,0));
const counts={},inc=(key,n=1)=>counts[key]=(counts[key]??0)+n;
const candidateReasons={},modelVerdictAndType={},artistRows=[],candidateRows=[];
const videoHit=hit=>{
  try{
    const u=new URL(hit.link);
    return ['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)
      ?(u.pathname==='/watch'&&u.searchParams.has('v'))||u.pathname.startsWith('/shorts/')
      :u.hostname==='youtu.be'&&u.pathname.length>1;
  }catch{return false;}
};
for(const frozen of approval.artists){
  const r=await read('artists/'+frozen.profile_id+'.json');
  const packet=packets.find(p=>p.profileId===frozen.profile_id);
  assert.equal(r.artist.profileId,frozen.profile_id);
  assert.equal(r.artist.cmArtist,frozen.cm_artist);
  assert.equal(packet.cmArtist,frozen.cm_artist);
  const search=searches.get(frozen.profile_id);
  assert.ok(Array.isArray(search.data.organic));
  const videos=search.data.organic.filter(videoHit);
  if(videos.length)inc('artists_with_video_search_hits');
  if(!r.allSearchCandidates.length){
    inc('artists_without_parsed_channel_candidates');
    if(videos.length)inc('artists_without_parsed_channels_but_with_video_hits');
  }
  const accountPlatforms=[...new Set(packet.linkedAccounts.map(a=>a.platform))];
  if(!packet.linkedAccounts.length)inc('artists_without_saved_catalog_accounts');
  if(accountPlatforms.includes('instagram'))inc('artists_with_catalog_instagram_reference');
  if(accountPlatforms.includes('spotify'))inc('artists_with_catalog_spotify_reference');
  if((packet.releases?.length??0)+(packet.catalogTracks?.length??0)>0)inc('artists_with_saved_release_facts');
  let unresolved=false,modelChecked=false;
  const statuses=new Set();
  for(const c of r.candidates){
    const d=c.decision;
    statuses.add(d.status);
    candidateReasons[d.reason]=(candidateReasons[d.reason]??0)+1;
    assert.equal(hash(c.capture.body),c.capture.bodySha256);
    assert.ok(receipts.has(c.capture.rawReceiptSha256));
    let delivered=null,answer=c.recordedAnswer?.answer;
    if(c.recordedAnswer){
      modelChecked=true;
      const receipt=models.get(c.recordedAnswer.requestSha256);
      assert.ok(receipt);
      assert.equal(hash(receipt),c.recordedAnswer.receiptSha256);
      delivered=receipt.request.body.state;
      assert.equal(delivered.artist.profileId,frozen.profile_id);
      assert.equal(delivered.artist.cmArtist,frozen.cm_artist);
      const boundUrl=value=>{
        const u=new URL(value);
        return u.pathname.startsWith('/@')?value.toLowerCase():value;
      };
      assert.equal(boundUrl(delivered.candidate.url),boundUrl(c.url));
      assert.deepEqual(delivered.artist,c.metadataActuallyUsed.state.artist);
      const signature=answer.verdict+' / '+answer.channelType;
      modelVerdictAndType[signature]=(modelVerdictAndType[signature]??0)+1;
      inc('model_evaluations');
      const ev=delivered.artist.ownershipEvidence;
      if(!ev.declarations?.length)inc('model_inputs_without_owner_declarations');
      if(!ev.musicIds?.length)inc('model_inputs_without_catalog_music_ids');
      if(!ev.releases?.length)inc('model_inputs_without_release_facts');
      if(!ev.channelAttributedVideos?.length)inc('model_inputs_without_attributed_video_evidence');
      if(!delivered.artist.accounts?.length)inc('model_inputs_without_catalog_accounts');
      if(c.capture.body.isOfficialArtistChannel==null)inc('model_inputs_with_unknown_official_artist_badge');
    }
    if(d.status==='needs_identity_check')unresolved=true;
    candidateRows.push({artist:r.artist.name,profile_id:frozen.profile_id,cm_artist:frozen.cm_artist,
      youtube_url:c.url,channel_name:c.capture.body.displayName,decision_status:d.status,
      decision_reason:d.reason,model_run:Boolean(answer),model_verdict:answer?.verdict,
      model_channel_type:answer?.channelType,model_identity_score:answer?.sameIdentityProbability,
      supplied_declarations:delivered?.artist.ownershipEvidence.declarations?.length,
      supplied_catalog_music_ids:delivered?.artist.ownershipEvidence.musicIds?.length,
      supplied_release_facts:delivered?.artist.ownershipEvidence.releases?.length,
      supplied_attributed_videos:delivered?.artist.ownershipEvidence.channelAttributedVideos?.length,
      official_artist_badge:c.capture.body.isOfficialArtistChannel,
      search_title:c.title,search_snippet:c.snippet,
      limitation:'Saved evidence audit, not a new ownership verdict. Missing badge fields mean unknown.'});
  }
  if(unresolved)inc('artists_with_unresolved_ownership_candidate');
  if(modelChecked)inc('artists_with_at_least_one_model_evaluation');
  const group=r.classification.likely?'tentative_likely_match':
    !r.allSearchCandidates.length?'discovery_gap_video_hits_not_resolved':
    !r.candidates.length?'topic_only_search_results':
    unresolved?'ownership_evidence_unresolved':'related_or_conflicting_channels';
  inc('artist_group_'+group);
  artistRows.push({artist:r.artist.name,tier:r.tier,profile_id:frozen.profile_id,cm_artist:frozen.cm_artist,
    review_group:group,original_checked:r.classification.checked,original_likely:r.classification.likely,
    raw_search_results:search.data.organic.length,video_search_hits:videos.length,
    selected_channels:r.candidates.length,channel_decision_statuses:[...statuses].join('; '),
    catalog_account_platforms:accountPlatforms.join('; '),
    saved_release_facts:(packet.releases?.length??0)+(packet.catalogTracks?.length??0),
    video_search_urls:videos.map(h=>h.link).join('; '),
    limitation:'Video search hits and matching names are clues, not artist ownership proof. Original decisions unchanged.'});
}
assert.equal(candidateRows.length,original.admissions.find(r=>r.kind==='metadata').calls);
assert.equal(counts.model_evaluations,models.size);
assert.equal(artistRows.length,100);
assert.equal(artistRows.filter(r=>r.original_likely).length,original.likelyMatches);
const summary={artists:100,selectedChannelCandidates:candidateRows.length,originalResults:original,
  counts,candidateDecisionCounts:candidateReasons,modelVerdictAndType,
  scope:'Offline review of the exact archived requests, search receipts, channel captures, and recorded answers. No reconstructed inputs substituted for original requests.',
  paidCalls:0,catalogWrites:0,originalDecisionsChanged:0,
  recommendation:'Prepare a separately approved video-to-uploader discovery path and deliver stronger catalog-bound ownership evidence. Preserve Topic, organization, mismatch and shared-channel holds; do not lower acceptance requirements just to increase yield.'};
await fs.mkdir(output,{recursive:false});
const cell=v=>{
  let s=v==null?'':String(v);
  if(/^[=+\-@\t\r\n]/.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
for(const [file,rows] of [['artist-review.csv',artistRows],['channel-review.csv',candidateRows]]){
  const fields=Object.keys(rows[0]);
  await fs.writeFile(output+'/'+file,'\ufeff'+fields.map(cell).join(',')+'\r\n'+rows.map(r=>fields.map(k=>cell(r[k])).join(',')).join('\r\n')+'\r\n',{flag:'wx'});
}
await fs.writeFile(output+'/summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify(summary,null,2));
