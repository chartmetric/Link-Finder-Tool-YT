import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {likelyReviewSuggestion,LIKELY_REVIEW_POLICY} from './instagram-likely-review-policy.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const csv=rows=>{
  const keys=Object.keys(rows[0]??{}),cell=v=>{
    const text=typeof v==='object'&&v!==null?JSON.stringify(v):String(v??'');
    return '"'+(/^\s*[=+@-]/u.test(text)?"'"+text:text).replaceAll('"','""')+'"';
  };
  return '\ufeff'+[keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
};
export async function compareLikelyReviews(batchDir,outputDir){
  const inputs=[],read=async name=>{
    const bytes=await fs.readFile(path.join(batchDir,name));inputs.push({file:name,sha256:hash(bytes)});
    return JSON.parse(bytes);
  };
  const scope=await read('scope.json'),receipt=await read('receipt.json'),source=await read('source-rows.json');
  assert.equal(hash(JSON.stringify(scope)),receipt.scopeSha256);assert.equal(hash(JSON.stringify(source)),receipt.sourceRowsSha256);
  const bytes=await fs.readFile(path.join(batchDir,'execution-paid/results.jsonl'));
  inputs.push({file:'execution-paid/results.jsonl',sha256:hash(bytes)});
  const results=bytes.toString('utf8').split('\n').filter(s=>s.trim()).map(JSON.parse);
  const originalArtists=await read('execution-paid/artist-outcomes.json');
  const originals=new Map(originalArtists.map(a=>[String(a.profileId),a]));
  const requests=new Map(scope.requests.map(r=>[r.key,r])),sources=new Map(source.filter(s=>s.key).map(s=>[s.key,s]));
  assert.equal(results.length,requests.size,'Partial or duplicated execution must not be treated as a complete batch.');
  const roster=new Map(scope.artists.map(a=>[String(a.profile_id),a])),owners=new Map(),pairVerdicts=new Map();
  for(const s of source.filter(s=>s.role==='candidate'&&s.url)){
    if(!owners.has(s.url))owners.set(s.url,new Set());owners.get(s.url).add(String(s.profileId));
  }
  for(const r of results){
    const key=`${r.profileId}:${r.instagramUrl}`;
    if(!pairVerdicts.has(key))pairVerdicts.set(key,new Set());pairVerdicts.get(key).add(r.verdict);
  }
  const rows=[],seen=new Set();
  for(const r of results){
    assert.ok(!seen.has(r.key),'Duplicate saved decision.');seen.add(r.key);
    const q=requests.get(r.key),s=sources.get(r.key);assert.ok(q&&s);
    assert.equal(q.profileId,s.profileId);assert.equal(q.role,s.role);assert.equal(r.role,s.role);
    assert.deepEqual(s.player,roster.get(String(s.profileId)));
    const packet=await read(`execution-paid/responses/${r.key}.json`);
    assert.equal(packet.status,200);assert.equal(hash(JSON.stringify(packet.decisionRequest)),q.sha256);
    assert.equal(packet.requestBodySha256,q.sha256);assert.deepEqual(packet.decisionRequest,q.body);
    assert.equal(packet.data.model,r.model);assert.equal(packet.data.model,scope.expectedModel);
    assert.equal(packet.data.answers.candidate_0_same_identity.noul,r.score);
    assert.equal(packet.data.answers.candidate_0_verdict.choice,r.verdict);
    assert.equal(packet.decisionRequest.state.artist,s.artist);
    assert.equal(packet.decisionRequest.state.candidates[0].url,r.instagramUrl);
    const p=structuredClone(s.profile);
    p.jevVerification={verdict:r.verdict,sameIdentityProbability:r.score};
    const vv=pairVerdicts.get(`${r.profileId}:${r.instagramUrl}`);
    const decision=likelyReviewSuggestion(p,s.player,{
      sharedHandle:s.role==='candidate'&&(owners.get(s.url)?.size??0)>1,
      contradictoryPair:vv.has('mismatch')&&(vv.has('likely')||vv.has('verified')),
    });
    rows.push({artist:s.artist,profile_id:String(s.profileId),cm_artist:s.player.cm_artist??'',tier:s.player.tier??'',
      role:s.role,instagram_url:r.instagramUrl,candidate_display_name:p.identityComparison?.candidate?.displayName??'',
      candidate_bio:p.identityComparison?.candidate?.bio??'',recorded_score:r.score,recorded_verdict:r.verdict,
      previous_review_support:r.researchPolicySupport,previous_reason:r.reason,
      proposed_review_suggestion:decision.reviewSuggestion,proposed_status:decision.status,proposed_reason:decision.reason,
      observed_conflict_details:decision.evidence,model:r.model,original_request_sha256:q.sha256,
      artist_metadata_actually_sent:packet.decisionRequest.state.artistContext??null,
      saved_artist_metadata_available_not_necessarily_sent:s.context??null,
      saved_candidate_evidence:p.identityComparison?.candidate??null,verified:false,live_link_changed:false});
  }
  for(const s of source.filter(s=>s.status!=='prepared')){
    const a=roster.get(String(s.profileId));assert.ok(a);
    rows.push({artist:s.artist,profile_id:String(s.profileId),cm_artist:a.cm_artist??'',tier:a.tier??'',role:s.role,
      instagram_url:s.url??'',candidate_display_name:'',candidate_bio:'',recorded_score:null,recorded_verdict:null,
      previous_review_support:false,previous_reason:s.reason??s.status,proposed_review_suggestion:false,
      proposed_status:s.status==='no_saved_candidate'?'no_saved_candidate':'incomplete_saved_evidence',
      proposed_reason:s.reason??s.status,observed_conflict_details:[],model:null,original_request_sha256:null,
      artist_metadata_actually_sent:null,saved_artist_metadata_available_not_necessarily_sent:s.context??null,
      saved_candidate_evidence:null,verified:false,live_link_changed:false});
  }
  const artists=scope.artists.map(a=>{
    const rr=rows.filter(r=>r.role==='candidate'&&r.profile_id===String(a.profile_id)),before=originals.get(String(a.profile_id));
    assert.ok(before);
    const suggested=rr.filter(r=>r.proposed_review_suggestion),incomplete=rr.some(r=>['no_saved_candidate','incomplete_saved_evidence'].includes(r.proposed_status));
    const conflict=rr.some(r=>['observed_identity_conflict','unresolved_ownership_conflict'].includes(r.proposed_status));
    const outcome=suggested.length?'positive_review_suggestion':incomplete?'incomplete_saved_evidence':
      conflict?'ownership_conflict_review':rr.some(r=>r.recorded_verdict==='uncertain')?'model_uncertain':'no_positive_saved_match';
    return {artist:a.artist,profile_id:String(a.profile_id),cm_artist:a.cm_artist??'',tier:a.tier??'',
      previous_outcome:before.status,previous_supported_urls:before.supportedUrls,proposed_outcome:outcome,
      proposed_review_urls:[...new Set(suggested.map(r=>r.instagram_url))],
      newly_suggested:before.status!=='supported_for_review'&&suggested.length>0,
      incomplete_evidence_still_present:incomplete,conflict_flags_still_present:conflict,
      candidates:rr.map(r=>({url:r.instagram_url,score:r.recorded_score,verdict:r.recorded_verdict,
        review_suggestion:r.proposed_review_suggestion,status:r.proposed_status,reason:r.proposed_reason})),
      metadata_actually_sent_per_candidate:rr.map(r=>({url:r.instagram_url,metadata:r.artist_metadata_actually_sent})),
      saved_metadata_available_per_candidate:rr.map(r=>({url:r.instagram_url,metadata:r.saved_artist_metadata_available_not_necessarily_sent})),
      verified:false,live_links_changed:false};
  });
  const count=(arr,key)=>arr.reduce((o,r)=>(o[r[key]]=(o[r[key]]??0)+1,o),{});
  const candidateRows=rows.filter(r=>r.role==='candidate'),positive=candidateRows.filter(r=>['likely','verified'].includes(r.recorded_verdict));
  const summary={policy:LIKELY_REVIEW_POLICY,artistRecords:artists.length,candidateAndPlaceholderRows:candidateRows.length,
    previousSupportedArtists:originalArtists.filter(a=>a.status==='supported_for_review').length,
    proposedReviewArtists:artists.filter(a=>a.proposed_review_urls.length).length,
    newlySuggestedArtists:artists.filter(a=>a.newly_suggested).length,
    previousSupportedArtistsNowHeld:artists.filter(a=>a.previous_outcome==='supported_for_review'&&!a.proposed_review_urls.length).length,
    artistOutcomes:count(artists,'proposed_outcome'),recordedPositiveCandidateRows:positive.length,
    proposedPositiveCandidateRows:candidateRows.filter(r=>r.proposed_review_suggestion).length,
    positiveVerdictHolds:count(positive.filter(r=>!r.proposed_review_suggestion),'proposed_reason'),
    controls:rows.filter(r=>r.role==='control').length,
    suggestedControls:rows.filter(r=>r.role==='control'&&r.proposed_review_suggestion).length,
    sourceScopeSha256:receipt.scopeSha256,sourceRowsSha256:receipt.sourceRowsSha256,
    codeHashes:{policy:hash(await fs.readFile(new URL('./instagram-likely-review-policy.mjs',import.meta.url))),
      audit:hash(await fs.readFile(fileURLToPath(import.meta.url)))},
    newPaidCalls:0,newSearches:0,liveLinkChanges:0,scoresChanged:false,accuracyCalibrated:false,
    independentlyReviewedLabels:0,productionApproved:false,
    interpretation:'Offline comparison of original 500-artist batch only; the later 24-check experiment is not mixed in. Positive review suggestions are not corroborated ownership, verified links or proof of accuracy. Conflicting IDs and account reuse mean unresolved ownership, not proven wrong identity. No saved candidate is not proof that no account exists. All historical answers and inputs remain unchanged.',inputs};
  await fs.mkdir(outputDir,{recursive:false});
  for(const [file,value] of [['summary.json',JSON.stringify(summary,null,2)],['all-500-artists.csv',csv(artists)],['all-candidates.csv',csv(rows)]])
    await fs.writeFile(path.join(outputDir,file),value,{flag:'wx'});
  return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [batch,out]=process.argv.slice(2);if(!batch||!out)throw Error('Usage: likely-review-audit <frozen-batch> <new-output>');
  const summary=await compareLikelyReviews(batch,out);
  console.log(JSON.stringify({...summary,inputs:`${summary.inputs.length} hashed input files`},null,2));
}
